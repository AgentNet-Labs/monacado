/**
 * Shared Prisma client (Phase 0D).
 *
 * A lazily-instantiated singleton so importing this module never opens a
 * connection (safe for build/typecheck). `DATABASE_URL` is validated only when
 * the client is first needed, and its value is NEVER logged or included in
 * errors — only its presence/absence is reported.
 */

import { PrismaClient } from "@prisma/client";

let client: PrismaClient | undefined;

/** Validate that DATABASE_URL is present and plausibly a MySQL URL (no value leaked). */
function assertDatabaseUrl(): void {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim() === "") {
    throw new Error("DATABASE_URL is not set. Configure a local disposable MySQL URL in .env (see .env.example).");
  }
  if (!/^mysql:\/\//i.test(url)) {
    // Do not echo the value — only the scheme expectation.
    throw new Error("DATABASE_URL must be a mysql:// connection string.");
  }
}

/** Get the shared Prisma client, creating it on first use. */
export function getPrisma(): PrismaClient {
  if (client) return client;
  assertDatabaseUrl();
  client = new PrismaClient();
  return client;
}

/** Disconnect the shared client (tests/scripts cleanup). */
export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}

/** Prisma type alias for use in repository transaction callbacks. */
export type { PrismaClient } from "@prisma/client";
