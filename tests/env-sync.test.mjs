#!/usr/bin/env node
// Tests for env-sync: value preservation, schema parsing, parity detection.
//
// The point of this suite is the property the script exists for: values survive byte-for-byte and never appear in output. Fixtures use fake secrets containing the exact characters that break naive line-splitting — `#`, `=`, quotes, newlines.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseAssignments, parseSchema, findRuntimeEnvGaps } from "../scripts/env-sync.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "env-sync.mjs");

const failures = [];
let passed = 0;

function ok(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  v ${label}`);
  } else {
    failures.push(label);
    console.error(`  X ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

function eq(label, got, want) {
  ok(label, got === want, `got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
}

let dir;
function fresh() {
  dir = mkdtempSync(path.join(tmpdir(), "env-sync-"));
  return dir;
}
function write(name, content) {
  writeFileSync(path.join(dir, name), content);
}
function read(name) {
  return readFileSync(path.join(dir, name), "utf8");
}
function run(args) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [SCRIPT, "--cwd", dir, ...args], {
        cwd: dir,
        encoding: "utf8",
      }),
    };
  } catch (error) {
    return { code: error.status, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/** Re-parses a formatted file so assertions compare values rather than layout. */
function values(content) {
  return parseAssignments(content).entries;
}

// A minimal schema covering every shape the parser must handle: a plain key, an optional key, a multi-line expression, a ternary, a multi-line comment, a section marker, and a `runtimeEnv` block that restates everything.
const SCHEMA = `import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  server: {
    // ── Database
    // The primary connection string.
    DATABASE_URL: z.url(),
    // Optional so an unconfigured environment still boots.
    CRON_SECRET: z.string().min(16).optional(),
    // ── Stripe
    // Prefixes are documented and stable.
    // Length deliberately unpinned.
    STRIPE_SECRET_KEY: z
      .string()
      .regex(/^sk_/, "must be a secret key"),
    STRIPE_WEBHOOK_SECRET:
      process.env.NODE_ENV === "production"
        ? z.string().startsWith("whsec_")
        : z.string().startsWith("whsec_").optional(),
    NODE_ENV: z.enum(["development", "production"]).default("development"),
  },

  client: {
    // ── Runtime
    NEXT_PUBLIC_ENV: z.enum(["PROD", "LOCAL"]),
  },

  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    CRON_SECRET: process.env.CRON_SECRET,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_ENV: process.env.NEXT_PUBLIC_ENV,
  },
});
`;

function withSchema() {
  fresh();
  write("env.ts", SCHEMA);
}

console.log("\nparseSchema");
{
  const keys = parseSchema(SCHEMA);
  eq("finds every declared key", keys.size, 6);
  // The regression that motivated this test: parsing `runtimeEnv` alongside the schema blocks overwrites each expression with `process.env.KEY`, collapsing every optional key to required.
  const optional = [...keys].filter(([, m]) => m.optional).map(([k]) => k).sort();
  eq("runtimeEnv does not overwrite optionality", optional.join(","), "CRON_SECRET,STRIPE_WEBHOOK_SECRET");
  ok("multi-line expression stays attached to its key", keys.get("STRIPE_SECRET_KEY") && !keys.get("STRIPE_SECRET_KEY").optional);
  ok("ternary schema counts as optional", keys.get("STRIPE_WEBHOOK_SECRET").optional);
  eq("multi-line comment run is one comment", keys.get("STRIPE_SECRET_KEY").comment.length, 2);
  eq("section marker attaches", keys.get("DATABASE_URL").section, "Database");
  eq("section persists to the next marker", keys.get("STRIPE_SECRET_KEY").section, "Stripe");
  eq("client block parsed too", keys.get("NEXT_PUBLIC_ENV").section, "Runtime");
  eq("marker line is not treated as a comment", keys.get("NEXT_PUBLIC_ENV").comment.length, 0);
}

console.log("\nfindRuntimeEnvGaps");
{
  eq("no gaps when every key is wired", findRuntimeEnvGaps(SCHEMA).length, 0);
  const missing = SCHEMA.replace("    CRON_SECRET: process.env.CRON_SECRET,\n", "");
  eq("reports a key absent from runtimeEnv", findRuntimeEnvGaps(missing).join(","), "CRON_SECRET");
  // A spread wires keys this text parser cannot see, so the check must stand down rather than report false gaps.
  const spread = SCHEMA.replace("  runtimeEnv: {", "  runtimeEnv: {\n    ...oauthRuntimeEnv,");
  eq("stands down when runtimeEnv uses a spread", findRuntimeEnvGaps(spread).length, 0);
}

console.log("\nvalue preservation");
{
  withSchema();
  write(".env.local", 'NEXT_PUBLIC_ENV=LOCAL\nDATABASE_URL="postgres://u:p@h:1/db"\nSTRIPE_SECRET_KEY=sk_test_x\n');
  const before = values(read(".env.local"));
  run([".env.local"]);
  const after = values(read(".env.local"));
  eq("same keys and values", JSON.stringify([...after].sort()), JSON.stringify([...before].sort()));
  // Order follows the schema (server before client), which is the feature.
  eq("reordered to schema order", [...after.keys()].join(","), "DATABASE_URL,STRIPE_SECRET_KEY,NEXT_PUBLIC_ENV");
}
{
  withSchema();
  write(".env.local", 'DATABASE_URL="postgres://u:pa#ss@h:1/db"\n');
  run([".env.local"]);
  eq("`#` inside a value survives", values(read(".env.local")).get("DATABASE_URL"), '"postgres://u:pa#ss@h:1/db"');
}
{
  withSchema();
  write(".env.local", 'DATABASE_URL="a=b=c"\n');
  run([".env.local"]);
  eq("`=` inside a value survives", values(read(".env.local")).get("DATABASE_URL"), '"a=b=c"');
}
{
  withSchema();
  const pem = '"-----BEGIN KEY-----\nline2\nline3\n-----END KEY-----"';
  write(".env.local", `DATABASE_URL=${pem}\n`);
  run([".env.local"]);
  eq("multi-line quoted value survives", values(read(".env.local")).get("DATABASE_URL"), pem);
}
{
  withSchema();
  write(".env.local", 'DATABASE_URL="postgres://user:SUPERSECRET@h:1/db"\nNEXT_PUBLIC_ENV=LOCAL\n');
  const result = run([".env.local"]);
  ok("never prints a value", !result.out.includes("SUPERSECRET") && !result.out.includes("postgres://"));
}
{
  withSchema();
  write(".env.local", "# DATABASE_URL=disabled\nNEXT_PUBLIC_ENV=LOCAL\n");
  run([".env.local"]);
  ok("commented-out key is not resurrected", !values(read(".env.local")).has("DATABASE_URL"));
}

console.log("\nlayout");
{
  withSchema();
  write(".env.local", "NEXT_PUBLIC_ENV=LOCAL\nSOME_NEW_KEY=whatever\n");
  const result = run([".env.local"]);
  const after = read(".env.local");
  ok("unknown key moves to Uncategorised", after.includes("Uncategorised"));
  eq("unknown key keeps its value", values(after).get("SOME_NEW_KEY"), "whatever");
  ok("section rules rendered", after.includes("── Runtime"));
  ok("extra key named in report", result.out.includes("SOME_NEW_KEY") || result.out.includes("extra"));
}
{
  withSchema();
  write(".env.local", 'DATABASE_URL="x"\nSTRIPE_SECRET_KEY=sk_x\nNEXT_PUBLIC_ENV=LOCAL\n');
  run([".env.local"]);
  const after = read(".env.local");
  ok("schema comment rendered above its key", after.includes("# The primary connection string.\nDATABASE_URL="));
  // Each line of a multi-line comment run gets its own `#`, and the run stays attached to the key below it.
  ok("multi-line comment rendered in full", after.includes("# Prefixes are documented and stable.\n# Length deliberately unpinned.\nSTRIPE_SECRET_KEY="));
  ok("section marker is not rendered as a comment", !after.includes("# ── Stripe\n#"));
}
{
  withSchema();
  write(".env.local", 'DATABASE_URL="x"\nNEXT_PUBLIC_ENV=LOCAL\n');
  run([".env.local"]);
  const first = read(".env.local");
  const second = run([".env.local"]);
  eq("idempotent", read(".env.local"), first);
  ok("second run reports already formatted", second.out.includes("already formatted"));
}

console.log("\n--check");
{
  withSchema();
  write(".env.local", 'DATABASE_URL="x"\nNEXT_PUBLIC_ENV=LOCAL\nSTRIPE_SECRET_KEY=sk_x\n');
  const original = read(".env.local");
  const result = run(["--check", ".env.local"]);
  eq("exits 1 on an unformatted file", result.code, 1);
  eq("writes nothing", read(".env.local"), original);
  run([".env.local"]);
  eq("exits 0 once formatted", run(["--check", ".env.local"]).code, 0);
}
{
  withSchema();
  // Required: DATABASE_URL, STRIPE_SECRET_KEY, NEXT_PUBLIC_ENV. NODE_ENV is excluded (runtime supplies it).
  write(".env.local", 'DATABASE_URL="x"\nNEXT_PUBLIC_ENV=LOCAL\n');
  const result = run(["--check", ".env.local"]);
  eq("missing required key fails", result.code, 1);
  ok("names the missing key", result.out.includes("STRIPE_SECRET_KEY"));
}
{
  withSchema();
  write(".env.local", 'DATABASE_URL="x"\nNEXT_PUBLIC_ENV=LOCAL\nSTRIPE_SECRET_KEY=sk_x\n');
  run([".env.local"]);
  const result = run(["--check", ".env.local"]);
  eq("missing optional key does not fail", result.code, 0);
  ok("NODE_ENV is never reported missing", !result.out.includes("missing required"));
}
{
  withSchema();
  write(".env.local", 'DATABASE_URL="x"\nNEXT_PUBLIC_ENV=LOCAL\nSTRIPE_SECRET_KEY=sk_x\nTOOLING_ONLY=y\n');
  run([".env.local"]);
  const result = run(["--check", ".env.local"]);
  eq("extra key never fails", result.code, 0);
}
{
  withSchema();
  write(".env.local", 'DATABASE_URL="one"\nNEXT_PUBLIC_ENV=LOCAL\nSTRIPE_SECRET_KEY=sk_x\nDATABASE_URL="two"\n');
  const result = run(["--check", ".env.local"]);
  eq("duplicate key fails", result.code, 1);
  ok("names the duplicate", result.out.includes("duplicate") && result.out.includes("DATABASE_URL"));
  ok("duplicate report prints no value", !result.out.includes("one") || !result.out.includes("two"));
}

console.log("\nsweep");
{
  withSchema();
  write(".env.local", "NEXT_PUBLIC_ENV=LOCAL\n");
  const backup = "NEXT_PUBLIC_ENV=LOCAL\n";
  write(".env.local.rescue", backup);
  write(".env.local.bak", backup);
  run([]);
  eq("skips .rescue", read(".env.local.rescue"), backup);
  eq("skips .bak", read(".env.local.bak"), backup);
  ok("still formats the real file", read(".env.local") !== backup);
}
{
  withSchema();
  write(".env.local", "NEXT_PUBLIC_ENV=LOCAL\n");
  write(".env.claude", "SOME_MCP_TOKEN=x\n");
  run([]);
  eq("ignores .env.claude by default", read(".env.claude"), "SOME_MCP_TOKEN=x\n");
}
{
  withSchema();
  write(".env.empty", "# only comments\n\n# nothing to do\n");
  const result = run([".env.empty"]);
  eq("file with no assignments is left alone", read(".env.empty"), "# only comments\n\n# nothing to do\n");
  ok("reports the skip", result.out.includes("no assignments"));
}

console.log("\n--scaffold and --prune");
{
  withSchema();
  const secret = 'DATABASE_URL="postgres://u:p#w=x@h:1/db"\n';
  write(".env.local", `NEXT_PUBLIC_ENV=LOCAL\n${secret}`);
  const result = run(["--scaffold", ".env.local"]);
  const after = values(read(".env.local"));
  eq("scaffold succeeds", result.code, 0);
  eq("existing value untouched, `#` and `=` included", after.get("DATABASE_URL"), '"postgres://u:p#w=x@h:1/db"');
  eq("missing required key added empty", after.get("STRIPE_SECRET_KEY"), "");
  ok("optional key NOT added by default", !after.has("CRON_SECRET"));
}
{
  withSchema();
  write(".env.local", "NEXT_PUBLIC_ENV=LOCAL\n");
  run(["--scaffold=all", ".env.local"]);
  ok("--scaffold=all adds optional keys too", values(read(".env.local")).has("CRON_SECRET"));
}
{
  withSchema();
  write(".env.local", "NEXT_PUBLIC_ENV=LOCAL\n");
  run([".env.local"]);
  ok("does not scaffold without the flag", !values(read(".env.local")).has("STRIPE_SECRET_KEY"));
}
{
  withSchema();
  write(".env.local", "NEXT_PUBLIC_ENV=LOCAL\nRETIRED_EMPTY=\nRETIRED_WITH_VALUE=keep-me\n");
  run(["--prune", ".env.local"]);
  const after = values(read(".env.local"));
  ok("prunes unknown AND empty", !after.has("RETIRED_EMPTY"));
  // The safety property: an unknown key holding a value is relocated, never deleted. Losing a secret to a tidy-up would be unrecoverable.
  eq("never prunes a key holding a value", after.get("RETIRED_WITH_VALUE"), "keep-me");
}
{
  withSchema();
  write(".env.local", "NEXT_PUBLIC_ENV=LOCAL\nCRON_SECRET=\n");
  run(["--prune", ".env.local"]);
  ok("never prunes a schema key, even when empty", values(read(".env.local")).has("CRON_SECRET"));
}
{
  withSchema();
  write(".env.local", "NEXT_PUBLIC_ENV=LOCAL\nRETIRED_EMPTY=\n");
  const result = run(["--scaffold", "--prune", ".env.local"]);
  ok("prints key names", result.out.includes("RETIRED_EMPTY"));
  ok("prints no value", !result.out.includes("=LOCAL"));
}

console.log("\nerrors");
{
  fresh();
  write(".env.local", "FOO=bar\n");
  const result = run(["--check"]);
  eq("missing schema exits 2", result.code, 2);
  ok("says which file it wanted", result.out.includes("env.ts"));
}

if (dir) rmSync(dir, { recursive: true, force: true });

console.log(`\n${failures.length === 0 ? "v" : "X"} ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(`\nFailed: ${failures.join(", ")}`);
  process.exit(1);
}
