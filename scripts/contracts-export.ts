/**
 * contracts:export — write the derived JSON Schema artifacts.
 *
 * JSON Schema is generated from the Zod Capsule-Driven schemas (ADR §8) and is
 * a derived artifact. Output goes to generated/ (git-ignored this phase). Runs
 * offline. Never hand-edit the output.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateAllSchemas } from "../src/contracts/index";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "generated", "jsonschema");
mkdirSync(outDir, { recursive: true });

const schemas = generateAllSchemas();
for (const { name, schema } of schemas) {
  const target = join(outDir, name);
  writeFileSync(target, JSON.stringify(schema, null, 2) + "\n", "utf8");
  console.log(`✓ wrote ${name} (${Object.keys(schema).length} top-level keys)`);
}

console.log(`\ncontracts:export — ${schemas.length} schema(s) written to generated/jsonschema/.`);
