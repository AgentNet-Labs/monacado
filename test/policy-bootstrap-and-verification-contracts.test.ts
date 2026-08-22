/**
 * Policy bootstrap and verification-link contract tests (Phase 1.4).
 *
 * Offline: no database, no network, and no mail transport. Everything here is a
 * pure decision — how a verification link is built, what the message says, what
 * the consumption handler answers to a token it will not look up, and what the
 * operator command prints.
 *
 * The recurring assertion is **absence**: no identifier in a link, no identifier
 * in a message, nothing identifying in a page result, and no environment value in
 * an operator report.
 */

import { describe, expect, it } from "vitest";
import {
  VERIFICATION_TOKEN_PARAM,
  VERIFY_EMAIL_PATH,
  buildVerificationUrl,
  readVerificationLinkOrigin,
} from "../src/server/policy/verification-link";
import {
  VERIFICATION_OPERATIONAL_GAPS,
  renderVerificationMessage,
} from "../src/server/policy/verification-notice-service";
import { handleVerifyEmailRequest } from "../src/server/policy/verification-route-handler";
import { PolicyError } from "../src/server/policy/policy-errors";
import {
  BootstrapUsageError,
  classifyEnvironment,
  evaluateProductionGate,
  formatJson,
  formatPreflight,
  formatReport,
  parseCommandOptions,
} from "../scripts/bootstrap-marketplace-policy";
import type { PolicyBootstrapOutcome } from "../src/server/policy/marketplace-policy-bootstrap";
import { STRIPE_MODES } from "../src/server/payments/stripe-runtime-config";
import { MailMessage } from "../src/contracts/marketplace/notification-delivery";
import { createCapturingMailAdapter } from "../src/server/notifications/mail-port";

const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE"; // 43 base64url chars
const EXPIRES = "2028-03-02T09:00:00.000Z";

describe("verification link origin", () => {
  it("is read from the origin this deployment already declares", () => {
    expect(readVerificationLinkOrigin({ MONACADO_APP_ORIGIN: "https://monacado.test" })).toBe(
      "https://monacado.test",
    );
  });

  it("keeps an explicit port and drops a trailing slash", () => {
    expect(readVerificationLinkOrigin({ MONACADO_APP_ORIGIN: "http://localhost:3000/" })).toBe(
      "http://localhost:3000",
    );
  });

  it("refuses rather than defaulting when it is absent or unusable", () => {
    /* A default would put a link to localhost — or to a host this deployment does
       not control — into somebody's inbox. */
    for (const value of [undefined, "", "not-a-url", "ftp://monacado.test", "monacado.test"]) {
      expect(() => readVerificationLinkOrigin({ MONACADO_APP_ORIGIN: value })).toThrow(PolicyError);
    }
  });
});

describe("the verification URL", () => {
  const url = buildVerificationUrl("https://monacado.test", TOKEN);

  it("points at the Monacado page that consumes the challenge, on the configured origin", () => {
    expect(url.startsWith(`https://monacado.test${VERIFY_EMAIL_PATH}?`)).toBe(true);
    expect(new URL(url).searchParams.get(VERIFICATION_TOKEN_PARAM)).toBe(TOKEN);
  });

  it("carries the opaque token and NOTHING else", () => {
    const params = Array.from(new URL(url).searchParams.keys());
    expect(params).toEqual([VERIFICATION_TOKEN_PARAM]);
  });

  it("carries no participant, contact, challenge, or account identifier", () => {
    for (const prefix of ["mon:mpart:", "mon:pemc:", "mon:evch:", "mon:acct:"]) {
      expect(url).not.toContain(prefix);
    }
  });
});

describe("the verification message", () => {
  const url = buildVerificationUrl("https://monacado.test", TOKEN);
  const message = renderVerificationMessage({ verificationUrl: url, expiresAt: EXPIRES });

  it("identifies Monacado, states its purpose, and carries the link", () => {
    expect(message.subject).toContain("Monacado");
    expect(message.body).toContain("Monacado");
    expect(message.body).toContain("customer support contact");
    expect(message.body).toContain(url);
  });

  it("states that the link expires, and when", () => {
    expect(message.body).toContain("used once");
    expect(message.body).toContain(new Date(EXPIRES).toUTCString());
  });

  it("tells an unexpecting recipient to ignore it", () => {
    expect(message.body.toLowerCase()).toContain("ignore this message");
  });

  it("names no participant, account, contact, challenge, or address", () => {
    for (const prefix of ["mon:mpart:", "mon:acct:", "mon:pemc:", "mon:evch:", "mon:mpol:"]) {
      expect(message.body).not.toContain(prefix);
    }
    expect(message.body).not.toContain("@");
  });

  it("mentions the token only inside the link", () => {
    /* Everything but the URL line must be free of it: a token repeated as bare
       text is a credential a quoted reply carries onward. */
    const withoutUrl = message.body.split("\n").filter((line) => !line.includes(url)).join("\n");
    expect(withoutUrl).not.toContain(TOKEN);
  });

  it("is a valid MailMessage — plain text, no HTML part, no template", () => {
    const parsed = MailMessage.parse({
      to: "seller@example.invalid",
      subject: message.subject,
      text: message.body,
    });
    expect(Object.keys(parsed).sort()).toEqual(["subject", "text", "to"]);
  });

  it("goes through the Phase 1.1 mail port unchanged", async () => {
    const port = createCapturingMailAdapter();
    const result = await port.send({
      to: "seller@example.invalid",
      subject: message.subject,
      text: message.body,
    });
    expect(result.outcome).toBe("ACCEPTED");
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]!.text).toContain(url);
  });
});

describe("the consumption handler", () => {
  /* A database that would explode if touched: these cases must be decided from
     the token's shape alone. */
  const explodingDb = new Proxy(
    {},
    {
      get() {
        throw new Error("the handler must not reach the database for a malformed token");
      },
    },
  ) as never;

  it("refuses a missing token without a lookup", async () => {
    await expect(
      handleVerifyEmailRequest({ token: null, at: EXPIRES }, { db: explodingDb }),
    ).resolves.toEqual({ outcome: "NOT_VALID" });
  });

  it("refuses a malformed token without a lookup", async () => {
    for (const token of ["", "short", `${TOKEN}extra`, "not/base64url/at/all"]) {
      await expect(
        handleVerifyEmailRequest({ token, at: EXPIRES }, { db: explodingDb }),
      ).resolves.toEqual({ outcome: "NOT_VALID" });
    }
  });

  it("answers with an outcome and nothing identifying", async () => {
    const result = await handleVerifyEmailRequest(
      { token: null, at: EXPIRES },
      { db: explodingDb },
    );
    expect(Object.keys(result)).toEqual(["outcome"]);
  });
});

describe("the bootstrap command's invocation", () => {
  const ACCOUNT = "mon:acct:P14CONTRACT00000000000000";

  it("applies, does not activate, and confirms nothing by default", () => {
    const options = parseCommandOptions([], { MONACADO_POLICY_BOOTSTRAP_ACCOUNT_ID: ACCOUNT });
    expect(options).toEqual({
      mode: "APPLY",
      activate: false,
      confirmProduction: false,
      recordedByAccountId: ACCOUNT,
    });
  });

  it("activates only when asked, explicitly", () => {
    expect(
      parseCommandOptions(["--activate"], { MONACADO_POLICY_BOOTSTRAP_ACCOUNT_ID: ACCOUNT })
        .activate,
    ).toBe(true);
  });

  it("inspects without applying", () => {
    expect(
      parseCommandOptions(["--inspect"], { MONACADO_POLICY_BOOTSTRAP_ACCOUNT_ID: ACCOUNT }).mode,
    ).toBe("INSPECT");
  });

  it("refuses to run without a recording account", () => {
    /* A governance row records WHO recorded a version; inventing one would
       manufacture the fact the row exists to hold. */
    expect(() => parseCommandOptions([], {})).toThrow(BootstrapUsageError);
  });

  it("refuses an argument it does not recognise", () => {
    expect(() =>
      parseCommandOptions(["--force"], { MONACADO_POLICY_BOOTSTRAP_ACCOUNT_ID: ACCOUNT }),
    ).toThrow(BootstrapUsageError);
  });

  it("takes the production confirmation only from argv, never from the environment", () => {
    expect(
      parseCommandOptions([], {
        MONACADO_POLICY_BOOTSTRAP_ACCOUNT_ID: ACCOUNT,
        /* Deliberately plausible-looking variables. None of them authorises
           anything: a variable is set once and then silently applies forever. */
        MONACADO_CONFIRM_PRODUCTION: "true",
        CONFIRM_PRODUCTION: "yes",
        NODE_ENV: "production",
        CI: "true",
      }).confirmProduction,
    ).toBe(false);

    expect(
      parseCommandOptions(["--confirm-production"], {
        MONACADO_POLICY_BOOTSTRAP_ACCOUNT_ID: ACCOUNT,
      }).confirmProduction,
    ).toBe(true);
  });
});

describe("the production write gate", () => {
  it("classifies from NODE_ENV, and from nothing else", () => {
    expect(classifyEnvironment({ NODE_ENV: "production" })).toBe("PRODUCTION");
    expect(classifyEnvironment({ NODE_ENV: "  PRODUCTION  " })).toBe("PRODUCTION");
    for (const env of [
      {},
      { NODE_ENV: "development" },
      { NODE_ENV: "test" },
      /* A production-looking database, a CI marker, and a hostname classify as
         NON_PRODUCTION: a guess that says "this looks like production" is one
         word away from a guess that says "...so this must be authorised". */
      { DATABASE_URL: "mysql://user@db.prod.internal:3306/monacado" },
      { CI: "true" },
      { HOSTNAME: "monacado-prod-1" },
    ]) {
      expect(classifyEnvironment(env)).toBe("NON_PRODUCTION");
    }
  });

  it("permits a non-production mutation with no confirmation", () => {
    expect(
      evaluateProductionGate({
        mode: "APPLY",
        environment: "NON_PRODUCTION",
        confirmProduction: false,
      }),
    ).toEqual({ permitted: true, decision: "NON_PRODUCTION", environment: "NON_PRODUCTION" });
  });

  it("refuses a production mutation with no confirmation", () => {
    expect(
      evaluateProductionGate({
        mode: "APPLY",
        environment: "PRODUCTION",
        confirmProduction: false,
      }),
    ).toEqual({
      permitted: false,
      decision: "PRODUCTION_CONFIRMATION_REQUIRED",
      environment: "PRODUCTION",
    });
  });

  it("permits a production mutation that was explicitly confirmed", () => {
    expect(
      evaluateProductionGate({
        mode: "APPLY",
        environment: "PRODUCTION",
        confirmProduction: true,
      }),
    ).toEqual({
      permitted: true,
      decision: "PRODUCTION_CONFIRMED",
      environment: "PRODUCTION",
    });
  });

  it("never demands a confirmation for a read", () => {
    /* Inspect writes nothing, in any environment, so there is nothing to confirm. */
    expect(
      evaluateProductionGate({
        mode: "INSPECT",
        environment: "PRODUCTION",
        confirmProduction: false,
      }),
    ).toEqual({ permitted: true, decision: "READ_ONLY", environment: "PRODUCTION" });
  });

  it("decides the write independently of whether activation was asked for", () => {
    /* The gate takes no `activate` input at all. Confirming a production WRITE
       can therefore never imply a production ACTIVATION. */
    const gate = evaluateProductionGate({
      mode: "APPLY",
      environment: "PRODUCTION",
      confirmProduction: true,
    });
    expect(Object.keys(gate).sort()).toEqual(["decision", "environment", "permitted"]);
  });
});

describe("the preflight block", () => {
  const preflight = formatPreflight({
    environment: "PRODUCTION",
    mode: "APPLY",
    activate: true,
  });

  it("names the target, the policy, the source hash, and the requested action", () => {
    expect(preflight).toContain("environment:      PRODUCTION");
    expect(preflight).toContain("mon:mpol:");
    expect(preflight).toContain("1.0.0");
    expect(preflight).toContain("marketplace-policy/1.0.0");
    expect(preflight).toMatch(/source hash:      sha256:[0-9a-f]{64}/);
    expect(preflight).toContain("requested action: RECORD_AND_ACTIVATE");
  });

  it("distinguishes a record-only request from an activating one", () => {
    expect(
      formatPreflight({ environment: "PRODUCTION", mode: "APPLY", activate: false }),
    ).toContain("requested action: RECORD_ONLY");
  });

  it("carries no environment value, connection string, or credential", () => {
    for (const forbidden of ["DATABASE_URL", "mysql://", "password", "NODE_ENV=", "@"]) {
      expect(preflight).not.toContain(forbidden);
    }
  });
});

describe("the bootstrap report", () => {
  const outcome: PolicyBootstrapOutcome = {
    mode: "APPLY",
    policyId: "mon:mpol:M0NACAD0MARKETP0ACEP000CY0",
    policyVersion: "1.0.0",
    contentRef: "marketplace-policy/1.0.0",
    sourceHash: `sha256:${"a".repeat(64)}`,
    persistedHash: `sha256:${"a".repeat(64)}`,
    persistedState: "ACTIVE",
    action: "RECORD_AND_ACTIVATE",
    applied: true,
    activated: true,
    refusal: null,
    conflictingActiveVersion: null,
  };

  it("reports the policy id, version, source hash, state, action, and activation", () => {
    const report = formatReport(outcome);
    expect(report).toContain(outcome.policyId);
    expect(report).toContain("1.0.0");
    expect(report).toContain(outcome.sourceHash);
    expect(report).toContain("ACTIVE");
    expect(report).toContain("RECORD_AND_ACTIVATE");
    expect(report).toContain("activated:        yes");
  });

  it("names a refusal and the version standing in the way", () => {
    const report = formatReport({
      ...outcome,
      action: "REFUSED",
      applied: false,
      activated: false,
      refusal: "CONFLICTING_ACTIVE_VERSION",
      conflictingActiveVersion: "2.0.0",
    });
    expect(report).toContain("CONFLICTING_ACTIVE_VERSION");
    expect(report).toContain("2.0.0");
  });

  it("emits exactly the outcome as JSON, with nothing added", () => {
    expect(JSON.parse(formatJson(outcome))).toEqual(outcome);
  });

  it("carries no environment value, connection string, or prose", () => {
    const report = formatReport(outcome);
    for (const forbidden of ["DATABASE_URL", "mysql://", "password", "@", "Monacado is the merchant"]) {
      expect(report).not.toContain(forbidden);
    }
  });
});

describe("standing constraints", () => {
  it("leaves Stripe test-mode only", () => {
    expect(STRIPE_MODES).toEqual(["TEST"]);
  });

  it("names the operational controls this phase did not build", () => {
    expect(VERIFICATION_OPERATIONAL_GAPS.rateLimiting).toBe("NOT_IMPLEMENTED");
    expect(VERIFICATION_OPERATIONAL_GAPS.productionMailVendor).toBe("NOT_SELECTED");
  });
});
