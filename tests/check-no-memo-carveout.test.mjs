#!/usr/bin/env node
// Fixture-based tests for check-no-memo-carveout.
//
// Asserts that runCarveoutCheck() correctly classifies each file in the
// sample project as enforced violation, advisory, or clean.

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runCarveoutCheck } from "../scripts/check-no-memo-carveout.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(
  __dirname,
  "__fixtures__",
  "check-no-memo-carveout",
  "sample-project"
);

// Built-in defaults from the script. Inlining here keeps the test
// self-contained; importing them from the script would tie tests to
// internals that may legitimately evolve.
const TEST_CONFIG = {
  src: ["components", "hooks"],
  extensions: [".ts", ".tsx"],
  ignoredDirs: [".git", "node_modules"],
  directives: [
    '"use no memo"',
    '"use no forget"',
    "'use no memo'",
    "'use no forget'",
  ],
  rules: [
    {
      name: "TanStack Table",
      enforced: true,
      imports: ["@tanstack/react-table"],
      reason: "stub",
    },
    {
      name: "RHF interior hooks",
      enforced: true,
      hooks: ["useFormState", "useWatch", "useFieldArray", "useController"],
      reason: "stub",
    },
    {
      name: "RHF legacy watch()",
      enforced: true,
      methods: [{ name: "watch", requiresImportFrom: "react-hook-form" }],
      reason: "stub",
    },
    {
      name: "zustand",
      enforced: false,
      imports: ["zustand"],
      reason: "stub",
    },
  ],
};

function fail(msg, extra) {
  console.error(`FAIL ${msg}`);
  if (extra) console.error(extra);
  process.exitCode = 1;
}

function pass(msg) {
  console.log(`PASS ${msg}`);
}

function assertEqual(label, actual, expected) {
  const a = JSON.stringify(actual.slice().sort());
  const e = JSON.stringify(expected.slice().sort());
  if (a === e) {
    pass(label);
    return;
  }
  fail(label, `expected ${e}\nactual   ${a}`);
}

async function main() {
  const { enforced, advisories } = await runCarveoutCheck({
    cwd: FIXTURE_DIR,
    config: TEST_CONFIG,
  });

  const enforcedPaths = enforced.map((e) => e.path);
  const advisoryPaths = advisories.map((a) => a.path);

  // Expected enforced offenders:
  //   - bad-tanstack.tsx  (imports @tanstack/react-table, no directive)
  //   - bad-rhf-hook.tsx  (calls useFormState)
  //   - bad-rhf-watch.tsx (imports react-hook-form + calls .watch())
  // good-tanstack.tsx is excluded (has "use no memo")
  // good-rhf-useform.tsx is excluded (only useForm, returns stable refs)
  // type-only-tanstack.tsx is excluded (import type only)
  // unrelated.tsx is excluded (no flagged imports/calls)
  assertEqual(
    "enforced offenders",
    enforcedPaths,
    [
      "components/bad-tanstack.tsx",
      "components/bad-rhf-hook.tsx",
      "components/bad-rhf-watch.tsx",
    ]
  );

  // Expected advisories:
  //   - advisory-zustand.tsx (imports zustand)
  assertEqual("advisories", advisoryPaths, ["hooks/advisory-zustand.tsx"]);

  // Spot-check rule attribution.
  const tanstackHit = enforced.find(
    (e) => e.path === "components/bad-tanstack.tsx"
  );
  if (tanstackHit?.ruleName !== "TanStack Table") {
    fail(
      "rule attribution: bad-tanstack.tsx",
      `expected ruleName=TanStack Table, got ${tanstackHit?.ruleName}`
    );
  } else {
    pass("rule attribution: bad-tanstack.tsx → TanStack Table");
  }

  const rhfWatchHit = enforced.find(
    (e) => e.path === "components/bad-rhf-watch.tsx"
  );
  if (rhfWatchHit?.ruleName !== "RHF legacy watch()") {
    fail(
      "rule attribution: bad-rhf-watch.tsx",
      `expected ruleName=RHF legacy watch(), got ${rhfWatchHit?.ruleName}`
    );
  } else {
    pass("rule attribution: bad-rhf-watch.tsx → RHF legacy watch()");
  }
}

main().catch((err) => {
  console.error("test runner failed:", err);
  process.exitCode = 1;
});
