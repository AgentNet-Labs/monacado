/**
 * Registrar runtime configuration tests (Phase 0E.6.2).
 *
 * NO NETWORK. Nothing here opens a socket, resolves DNS, or contacts a
 * Registrar — the whole point of this boundary is that it can be fully
 * exercised without one.
 *
 * Every value below is synthetic: `example` / `invalid` hostnames reserved by
 * RFC 2606, a fabricated Registrar identifier, and obviously fake secrets. No
 * real endpoint, identifier, or credential appears in this repository.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  ENV_KEYS,
  findAllowListIssues,
  loadRegistrarRuntimeConfiguration,
  normalizeOrigin,
  type EnvironmentSource,
  type RegistrarRuntimeConfig,
} from "../src/server/registrar/registrar-runtime-config";
import { EnvBearerCredentialProvider } from "../src/server/registrar/env-credential-provider";
import {
  createConfiguredRegistrarTransport,
  validateRegistrarRuntimeReadiness,
} from "../src/server/registrar/registrar-runtime-factory";
import {
  EndpointNotAllowListedError,
  InvalidCredentialSecretError,
  MissingCredentialSecretError,
  RuntimeTransportConstructionFailureError,
  UnsupportedCredentialModeError,
} from "../src/server/registrar/runtime-config-errors";

// — Synthetic fixtures —

const SECRET_VAR = "MONACADO_TEST_FAKE_REGISTRAR_TOKEN";
const FAKE_SECRET = "fake-test-token-not-a-real-credential";
const FAKE_REGISTRAR_ID = "an:registrar:0000000000000000000000TEST";
const ENDPOINT = "https://registrar.example/v1/register";
const ORIGIN = "https://registrar.example";

function enabledEnv(overrides: Record<string, string | undefined> = {}): EnvironmentSource {
  return {
    [ENV_KEYS.enabled]: "true",
    [ENV_KEYS.registrarId]: FAKE_REGISTRAR_ID,
    [ENV_KEYS.endpoint]: ENDPOINT,
    [ENV_KEYS.allowedOrigins]: ORIGIN,
    [ENV_KEYS.credentialMode]: "BEARER_ENV",
    [ENV_KEYS.bearerTokenEnv]: SECRET_VAR,
    ...overrides,
  };
}

function readyConfig(overrides: Partial<RegistrarRuntimeConfig> = {}): RegistrarRuntimeConfig {
  const load = loadRegistrarRuntimeConfiguration(enabledEnv());
  if (load.state !== "READY") throw new Error(`fixture is not READY: ${load.state}`);
  return { ...load.config, ...overrides };
}

const secretSource: EnvironmentSource = { [SECRET_VAR]: FAKE_SECRET };

// — Loading —

describe("loadRegistrarRuntimeConfiguration", () => {
  it("is DISABLED when nothing is configured", () => {
    expect(loadRegistrarRuntimeConfiguration({}).state).toBe("DISABLED");
  });

  it("is DISABLED when explicitly disabled, even with everything else set", () => {
    const load = loadRegistrarRuntimeConfiguration(enabledEnv({ [ENV_KEYS.enabled]: "false" }));
    expect(load.state).toBe("DISABLED");
  });

  it("treats an unrecognised enabled value as disabled rather than guessing", () => {
    expect(loadRegistrarRuntimeConfiguration({ [ENV_KEYS.enabled]: "perhaps" }).state).toBe(
      "DISABLED",
    );
  });

  it("is INCOMPLETE when enabled but required keys are missing, naming the keys", () => {
    const load = loadRegistrarRuntimeConfiguration({ [ENV_KEYS.enabled]: "true" });
    expect(load.state).toBe("INCOMPLETE");
    if (load.state !== "INCOMPLETE") return;
    expect(load.missingFields).toContain(ENV_KEYS.endpoint);
    expect(load.missingFields).toContain(ENV_KEYS.bearerTokenEnv);
  });

  it("treats a whitespace-only value as missing", () => {
    const load = loadRegistrarRuntimeConfiguration(enabledEnv({ [ENV_KEYS.endpoint]: "   " }));
    expect(load.state).toBe("INCOMPLETE");
  });

  it("trims surrounding whitespace from accepted values", () => {
    const load = loadRegistrarRuntimeConfiguration(
      enabledEnv({ [ENV_KEYS.endpoint]: `  ${ENDPOINT}  ` }),
    );
    expect(load.state).toBe("READY");
    if (load.state !== "READY") return;
    expect(load.config.endpointUrl).toBe(ENDPOINT);
  });

  it("is READY for a complete, valid configuration", () => {
    const load = loadRegistrarRuntimeConfiguration(enabledEnv());
    expect(load.state).toBe("READY");
    if (load.state !== "READY") return;
    expect(load.config.registrarId).toBe(FAKE_REGISTRAR_ID);
    expect(load.config.credentialMode).toBe("BEARER_ENV");
  });

  it("applies bounded defaults for timeout and response size", () => {
    const load = loadRegistrarRuntimeConfiguration(enabledEnv());
    if (load.state !== "READY") throw new Error("expected READY");
    expect(load.config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(load.config.maxResponseBytes).toBe(DEFAULT_MAX_RESPONSE_BYTES);
  });

  it("parses a comma-separated allow-list", () => {
    const load = loadRegistrarRuntimeConfiguration(
      enabledEnv({ [ENV_KEYS.allowedOrigins]: ` https://other.example , ${ORIGIN} ` }),
    );
    if (load.state !== "READY") throw new Error("expected READY");
    expect(load.config.allowedOrigins).toEqual(["https://other.example", ORIGIN]);
  });

  it("is INVALID for a non-numeric timeout, naming the field only", () => {
    const load = loadRegistrarRuntimeConfiguration(
      enabledEnv({ [ENV_KEYS.timeoutMs]: "ten seconds" }),
    );
    expect(load.state).toBe("INVALID");
    if (load.state !== "INVALID") return;
    expect(load.issues.join(" ")).toContain("timeoutMs");
  });

  it("is INVALID for an out-of-range timeout", () => {
    expect(
      loadRegistrarRuntimeConfiguration(enabledEnv({ [ENV_KEYS.timeoutMs]: "1" })).state,
    ).toBe("INVALID");
    expect(
      loadRegistrarRuntimeConfiguration(enabledEnv({ [ENV_KEYS.timeoutMs]: "999999" })).state,
    ).toBe("INVALID");
  });

  it("is INVALID for an out-of-range response bound", () => {
    expect(
      loadRegistrarRuntimeConfiguration(enabledEnv({ [ENV_KEYS.maxResponseBytes]: "1" })).state,
    ).toBe("INVALID");
  });

  it("is INVALID for an unsupported credential mode", () => {
    const load = loadRegistrarRuntimeConfiguration(
      enabledEnv({ [ENV_KEYS.credentialMode]: "MTLS" }),
    );
    expect(load.state).toBe("INVALID");
  });

  it("is INVALID when the bearer variable is a value rather than a NAME", () => {
    // A lowercase, punctuated string is what a pasted *token* looks like.
    const load = loadRegistrarRuntimeConfiguration(
      enabledEnv({ [ENV_KEYS.bearerTokenEnv]: "sk-live-abc.def" }),
    );
    expect(load.state).toBe("INVALID");
    if (load.state !== "INVALID") return;
    expect(load.issues.join(" ")).toContain("bearerTokenEnvVar");
    expect(load.issues.join(" ")).not.toContain("sk-live-abc.def");
  });

  it("accepts any non-blank Registrar identifier, per the existing contract", () => {
    // `RegistrarId` is deliberately `z.string().min(1)` — the Registrar's own
    // identifier format is not Monacado's to dictate, and tightening it here
    // would silently change a contract shared with persistence. A blank one is
    // still refused, as INCOMPLETE, by the required-key check above.
    const load = loadRegistrarRuntimeConfiguration(
      enabledEnv({ [ENV_KEYS.registrarId]: "registrar-1" }),
    );
    expect(load.state).toBe("READY");
    expect(
      loadRegistrarRuntimeConfiguration(enabledEnv({ [ENV_KEYS.registrarId]: "  " })).state,
    ).toBe("INCOMPLETE");
  });

  it("never echoes an environment value in its issues", () => {
    const load = loadRegistrarRuntimeConfiguration(
      enabledEnv({ [ENV_KEYS.endpoint]: "https://user:hunter2@evil.invalid/register" }),
    );
    expect(load.state).toBe("INVALID");
    if (load.state !== "INVALID") return;
    const text = load.issues.join(" ");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("evil.invalid");
  });

  it("reads only its own keys and never returns the wider environment", () => {
    const load = loadRegistrarRuntimeConfiguration({
      ...enabledEnv(),
      AWS_SECRET_ACCESS_KEY: "fake-unrelated-secret",
      DATABASE_URL: "mysql://root@127.0.0.1:3308/monacado_phase0e2",
    });
    if (load.state !== "READY") throw new Error("expected READY");
    expect(JSON.stringify(load.config)).not.toContain("fake-unrelated-secret");
    expect(JSON.stringify(load.config)).not.toContain("mysql://");
  });

  it("stores the secret variable NAME and never a secret value", () => {
    const load = loadRegistrarRuntimeConfiguration(enabledEnv());
    if (load.state !== "READY") throw new Error("expected READY");
    expect(load.config.bearerTokenEnvVar).toBe(SECRET_VAR);
    expect(JSON.stringify(load.config)).not.toContain(FAKE_SECRET);
    expect(Object.values(load.config)).not.toContain(FAKE_SECRET);
  });
});

// — Origin normalisation and allow-listing —

describe("normalizeOrigin", () => {
  it("fills in the effective port so default-port forms compare equal", () => {
    expect(normalizeOrigin("https://r.example")).toBe(normalizeOrigin("https://r.example:443"));
  });

  it("ignores path, query, and case of host", () => {
    expect(normalizeOrigin("https://R.Example/a/b?c=d")).toBe("https://r.example:443");
  });

  it("refuses wildcards outright", () => {
    expect(normalizeOrigin("https://*.example")).toBeUndefined();
  });

  it("refuses non-http(s) schemes and unparseable input", () => {
    expect(normalizeOrigin("file:///etc/passwd")).toBeUndefined();
    expect(normalizeOrigin("not a url")).toBeUndefined();
  });
});

describe("findAllowListIssues", () => {
  const opts = { allowLoopbackHttp: false };

  it("accepts an endpoint whose origin matches exactly", () => {
    expect(findAllowListIssues(ENDPOINT, [ORIGIN], opts)).toEqual([]);
  });

  it("accepts a default-port allow-list entry for a portless endpoint", () => {
    expect(findAllowListIssues(ENDPOINT, ["https://registrar.example:443"], opts)).toEqual([]);
  });

  it("rejects an unlisted origin", () => {
    const issues = findAllowListIssues(ENDPOINT, ["https://other.example"], opts);
    expect(issues.map((i) => i.rule)).toContain("origin-not-allowed");
  });

  it("rejects a suffix-collision host that a naive endsWith check would admit", () => {
    const issues = findAllowListIssues("https://evil-registrar.example/v1", [ORIGIN], opts);
    expect(issues.map((i) => i.rule)).toContain("origin-not-allowed");
  });

  it("rejects a subdomain of an allowed origin", () => {
    const issues = findAllowListIssues("https://a.registrar.example/v1", [ORIGIN], opts);
    expect(issues.map((i) => i.rule)).toContain("origin-not-allowed");
  });

  it("rejects a differing port", () => {
    const issues = findAllowListIssues("https://registrar.example:8443/v1", [ORIGIN], opts);
    expect(issues.map((i) => i.rule)).toContain("origin-not-allowed");
  });

  it("rejects a wildcarded allow-list entry", () => {
    const issues = findAllowListIssues(ENDPOINT, ["https://*.example"], opts);
    expect(issues.map((i) => i.rule)).toContain("allow-list-entry");
  });

  it("requires https for a non-loopback endpoint", () => {
    const issues = findAllowListIssues("http://registrar.example/v1", ["http://registrar.example"], opts);
    expect(issues.map((i) => i.rule)).toContain("https-required");
  });

  it("permits loopback http only when the test flag is set", () => {
    const url = "http://127.0.0.1:8080/register";
    const allowed = ["http://127.0.0.1:8080"];
    expect(findAllowListIssues(url, allowed, { allowLoopbackHttp: true })).toEqual([]);
    expect(
      findAllowListIssues(url, allowed, { allowLoopbackHttp: false }).map((i) => i.rule),
    ).toContain("https-required");
  });

  it("refuses non-loopback http even with the test flag set", () => {
    const issues = findAllowListIssues("http://registrar.example/v1", ["http://registrar.example"], {
      allowLoopbackHttp: true,
    });
    expect(issues.map((i) => i.rule)).toContain("loopback-only");
  });

  it("still applies Phase 0E.6.1 shape rules", () => {
    const issues = findAllowListIssues("https://user:pw@registrar.example/v1", [ORIGIN], opts);
    expect(issues.map((i) => i.rule)).toContain("embedded-credentials");
  });

  it("never includes the URL in an issue", () => {
    const issues = findAllowListIssues("https://user:hunter2@secret.invalid/v1", [ORIGIN], opts);
    const text = JSON.stringify(issues);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("secret.invalid");
  });
});

// — Credential provider —

describe("EnvBearerCredentialProvider", () => {
  it("resolves a bearer credential from the named variable", () => {
    const provider = new EnvBearerCredentialProvider(readyConfig(), secretSource);
    expect(provider.getRegistrarCredentials()).toEqual({
      authorization: `Bearer ${FAKE_SECRET}`,
    });
  });

  it("contributes no additional headers", () => {
    const provider = new EnvBearerCredentialProvider(readyConfig(), secretSource);
    expect(provider.getRegistrarCredentials().additionalHeaders).toBeUndefined();
  });

  it("throws when the secret is unset", () => {
    const provider = new EnvBearerCredentialProvider(readyConfig(), {});
    expect(() => provider.getRegistrarCredentials()).toThrow(MissingCredentialSecretError);
  });

  it("throws when the secret is blank", () => {
    const provider = new EnvBearerCredentialProvider(readyConfig(), { [SECRET_VAR]: "   " });
    expect(() => provider.getRegistrarCredentials()).toThrow(MissingCredentialSecretError);
  });

  it("does not name the secret variable in the missing-secret error", () => {
    const provider = new EnvBearerCredentialProvider(readyConfig(), {});
    try {
      provider.getRegistrarCredentials();
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as Error).message).not.toContain(SECRET_VAR);
    }
  });

  it("rejects a secret carrying CR or LF, which could split the request", () => {
    for (const bad of ["fake\r\nx-injected: 1", "fake\nvalue", "fake\u0000value"]) {
      const provider = new EnvBearerCredentialProvider(readyConfig(), { [SECRET_VAR]: bad });
      expect(() => provider.getRegistrarCredentials()).toThrow(InvalidCredentialSecretError);
    }
  });

  it("rejects an absurdly long secret", () => {
    const provider = new EnvBearerCredentialProvider(readyConfig(), {
      [SECRET_VAR]: "a".repeat(9_000),
    });
    expect(() => provider.getRegistrarCredentials()).toThrow(InvalidCredentialSecretError);
  });

  it("never includes the secret in an invalid-secret error", () => {
    const provider = new EnvBearerCredentialProvider(readyConfig(), {
      [SECRET_VAR]: `${FAKE_SECRET}\r\ninjected: 1`,
    });
    try {
      provider.getRegistrarCredentials();
      throw new Error("expected a throw");
    } catch (error) {
      const serialized = `${(error as Error).message} ${JSON.stringify(error)}`;
      expect(serialized).not.toContain(FAKE_SECRET);
    }
  });

  it("re-reads the source each call, so a rotated secret takes effect at once", () => {
    const mutable: Record<string, string | undefined> = { [SECRET_VAR]: FAKE_SECRET };
    const provider = new EnvBearerCredentialProvider(readyConfig(), mutable);
    expect(provider.getRegistrarCredentials().authorization).toBe(`Bearer ${FAKE_SECRET}`);
    mutable[SECRET_VAR] = "fake-rotated-token";
    expect(provider.getRegistrarCredentials().authorization).toBe("Bearer fake-rotated-token");
  });

  it("refuses an unsupported credential mode at construction", () => {
    const config = { ...readyConfig(), credentialMode: "MTLS" } as unknown as RegistrarRuntimeConfig;
    expect(() => new EnvBearerCredentialProvider(config, secretSource)).toThrow(
      UnsupportedCredentialModeError,
    );
  });
});

// — Composition root —

describe("createConfiguredRegistrarTransport", () => {
  it("builds a transport and endpoint from a ready configuration", () => {
    const built = createConfiguredRegistrarTransport(readyConfig(), { secretSource });
    expect(built.endpoint.url).toBe(ENDPOINT);
    expect(built.endpoint.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(built.registrarId).toBe(FAKE_REGISTRAR_ID);
    expect(built.transport).toBeDefined();
  });

  it("re-applies the allow-list, refusing a hand-assembled off-list endpoint", () => {
    const tampered = readyConfig({ endpointUrl: "https://attacker.invalid/register" });
    expect(() => createConfiguredRegistrarTransport(tampered, { secretSource })).toThrow(
      EndpointNotAllowListedError,
    );
  });

  it("names rules but never the endpoint when refusing", () => {
    const tampered = readyConfig({ endpointUrl: "https://attacker.invalid/register" });
    try {
      createConfiguredRegistrarTransport(tampered, { secretSource });
      throw new Error("expected a throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("origin-not-allowed");
      expect(message).not.toContain("attacker.invalid");
    }
  });

  it("refuses an off-list endpoint BEFORE reading any secret", () => {
    const tampered = readyConfig({ endpointUrl: "https://attacker.invalid/register" });
    let reads = 0;
    const watched = new Proxy({} as Record<string, string | undefined>, {
      get(_target, key) {
        reads += 1;
        return key === SECRET_VAR ? FAKE_SECRET : undefined;
      },
    });
    expect(() => createConfiguredRegistrarTransport(tampered, { secretSource: watched })).toThrow(
      EndpointNotAllowListedError,
    );
    expect(reads).toBe(0);
  });

  it("refuses an unsupported credential mode", () => {
    const config = { ...readyConfig(), credentialMode: "MTLS" } as unknown as RegistrarRuntimeConfig;
    expect(() => createConfiguredRegistrarTransport(config, { secretSource })).toThrow(
      UnsupportedCredentialModeError,
    );
  });

  it("refuses a hand-assembled configuration with an out-of-range bound", () => {
    // `createConfiguredRegistrarTransport` does not trust its input — the same
    // reason the allow-list is re-applied. A TypeScript-typed object can still
    // carry a value no schema ever approved.
    for (const [field, override] of [
      ["timeoutMs", { timeoutMs: 0 }],
      ["maxResponseBytes", { maxResponseBytes: 3 }],
    ] as const) {
      try {
        createConfiguredRegistrarTransport(readyConfig(override as never), { secretSource });
        throw new Error("expected a throw");
      } catch (error) {
        expect(error).toBeInstanceOf(RuntimeTransportConstructionFailureError);
        expect((error as RuntimeTransportConstructionFailureError).fields).toContain(field);
      }
    }
  });

  it("does not read the secret at construction time", () => {
    // Construction must succeed even with no secret present; the credential is
    // resolved per request, not cached at build time.
    expect(() =>
      createConfiguredRegistrarTransport(readyConfig(), { secretSource: {} }),
    ).not.toThrow();
  });
});

// — Readiness —

describe("validateRegistrarRuntimeReadiness", () => {
  it("reports DISABLED when there is no configuration", () => {
    expect(validateRegistrarRuntimeReadiness(undefined, {})).toEqual({ status: "DISABLED" });
  });

  it("reports READY for a coherent configuration with its secret present", () => {
    const readiness = validateRegistrarRuntimeReadiness(readyConfig(), secretSource);
    expect(readiness).toEqual({ status: "READY", registrarId: FAKE_REGISTRAR_ID });
  });

  it("reports INVALID when the secret is absent, with a stable code", () => {
    const readiness = validateRegistrarRuntimeReadiness(readyConfig(), {});
    expect(readiness).toEqual({ status: "INVALID", code: "MISSING_CREDENTIAL_SECRET", fields: [] });
  });

  it("reports INVALID for an off-list endpoint", () => {
    const tampered = readyConfig({ endpointUrl: "https://attacker.invalid/register" });
    const readiness = validateRegistrarRuntimeReadiness(tampered, secretSource);
    expect(readiness.status).toBe("INVALID");
    if (readiness.status !== "INVALID") return;
    expect(readiness.code).toBe("ENDPOINT_NOT_ALLOW_LISTED");
  });

  it("is safe to log — never carries a secret or an endpoint", () => {
    const readiness = validateRegistrarRuntimeReadiness(readyConfig(), secretSource);
    const serialized = JSON.stringify(readiness);
    expect(serialized).not.toContain(FAKE_SECRET);
    expect(serialized).not.toContain("registrar.example");
    expect(serialized).not.toContain(SECRET_VAR);
  });
});

// — Boundary hygiene —

describe("configuration boundary hygiene", () => {
  it("exposes no Registrar configuration through the browser-facing contracts barrel", async () => {
    const barrel = (await import("../src/contracts/index")) as Record<string, unknown>;
    for (const name of [
      "loadRegistrarRuntimeConfiguration",
      "EnvBearerCredentialProvider",
      "createConfiguredRegistrarTransport",
      "validateRegistrarRuntimeReadiness",
    ]) {
      expect(barrel[name]).toBeUndefined();
    }
  });

  it("defines no NEXT_PUBLIC Registrar variable", () => {
    for (const key of Object.values(ENV_KEYS)) {
      expect(key.startsWith("NEXT_PUBLIC_")).toBe(false);
    }
  });

  it("keeps the internal cause non-enumerable on runtime-config errors", () => {
    const error = new MissingCredentialSecretError();
    expect(Object.keys(error)).not.toContain("internalCause");
    expect(JSON.stringify(error)).not.toContain("internalCause");
  });
});
