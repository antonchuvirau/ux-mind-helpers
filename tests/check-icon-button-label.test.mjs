#!/usr/bin/env node
// Fixture-based tests for check-icon-button-label.
//
// Asserts that runIconButtonLabelCheck() flags icon-only Buttons missing
// an accessible name and leaves labelled / non-icon-only Buttons alone.

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  findViolations,
  runIconButtonLabelCheck,
} from "../scripts/check-icon-button-label.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(
  __dirname,
  "__fixtures__",
  "check-icon-button-label",
  "sample-project"
);

const TEST_CONFIG = {
  src: ["components"],
  extensions: [".tsx"],
  ignoredDirs: [".git", "node_modules"],
  components: ["Button", "InputGroupButton"],
  iconNamePattern: "^[A-Z][A-Za-z0-9_]*Icon$",
  labelProps: ["aria-label", "aria-labelledby", "title"],
};

const failures = [];
function assert(label, cond, detail) {
  if (cond) {
    console.log(`  v ${label}`);
  } else {
    failures.push({ label, detail });
    console.error(`  X ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

async function testFixtureProject() {
  console.log("Fixture project run:");
  const findings = await runIconButtonLabelCheck({
    cwd: FIXTURE_DIR,
    config: TEST_CONFIG,
  });

  const byPath = new Map(findings.map((f) => [f.path, f]));

  const violationsFile = byPath.get("components/violations.tsx");
  assert(
    "violations.tsx is reported",
    !!violationsFile,
    "expected to find findings for violations.tsx"
  );

  if (violationsFile) {
    // Script iterates `components` in order, so all Button hits come
    // before any InputGroupButton hits regardless of source-line order.
    const expected = [
      { component: "Button", iconName: "XIcon" },
      { component: "Button", iconName: "SearchIcon" },
      { component: "Button", iconName: "XIcon" },
      { component: "Button", iconName: "XIcon" },
      { component: "InputGroupButton", iconName: "CheckIcon" },
    ];
    assert(
      `violations.tsx reports ${expected.length} sites`,
      violationsFile.violations.length === expected.length,
      `got ${violationsFile.violations.length}`
    );
    for (let i = 0; i < expected.length; i++) {
      const v = violationsFile.violations[i];
      const e = expected[i];
      if (!v) continue;
      assert(
        `  site ${i + 1}: <${e.component}> wraps <${e.iconName} />`,
        v.component === e.component && v.iconName === e.iconName,
        `got <${v?.component}> wraps <${v?.iconName} />`
      );
    }
  }

  assert(
    "clean.tsx is NOT reported",
    !byPath.has("components/clean.tsx"),
    "clean.tsx should produce no findings"
  );
}

function testInlineCases() {
  console.log("\nInline detection cases:");

  const cases = [
    {
      label: "labelled w/ aria-label is clean",
      source: `<Button aria-label="x"><XIcon /></Button>`,
      expectViolations: 0,
    },
    {
      label: "icon-only w/o label fires",
      source: `<Button><XIcon /></Button>`,
      expectViolations: 1,
    },
    {
      label: "spread props is clean (assumed forwarded label)",
      source: `<Button {...rest}><XIcon /></Button>`,
      expectViolations: 0,
    },
    {
      label: "title satisfies accessible name",
      source: `<Button title="x"><XIcon /></Button>`,
      expectViolations: 0,
    },
    {
      label: "self-closing skipped (render-slot pattern)",
      source: `<Button variant="ghost" />`,
      expectViolations: 0,
    },
    {
      label: "<ButtonGroup> is not a Button",
      source: `<ButtonGroup><XIcon /></ButtonGroup>`,
      expectViolations: 0,
    },
    {
      label: "non-Icon child is ignored (e.g. <Foo />)",
      source: `<Button><Foo /></Button>`,
      expectViolations: 0,
    },
    {
      label: "icon + text is clean (text provides label)",
      source: `<Button><XIcon /> Close</Button>`,
      expectViolations: 0,
    },
    {
      label: "expression with `>` in props doesn't end the tag early",
      source: `<Button onClick={() => x>0 ? a : b}><XIcon /></Button>`,
      expectViolations: 1,
    },
    {
      label: "JSX comment between is allowed",
      source: `<Button>{/* close */}<XIcon /></Button>`,
      expectViolations: 1,
    },
    {
      label: "paired icon tag fires",
      source: `<Button><XIcon></XIcon></Button>`,
      expectViolations: 1,
    },
    {
      label: "aria-label substring not confused with data-aria-label",
      source: `<Button data-aria-label="x"><XIcon /></Button>`,
      expectViolations: 1,
    },
  ];

  for (const c of cases) {
    const v = findViolations(c.source, TEST_CONFIG);
    assert(
      c.label,
      v.length === c.expectViolations,
      `expected ${c.expectViolations} violations, got ${v.length}`
    );
  }
}

async function main() {
  await testFixtureProject();
  testInlineCases();

  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll check-icon-button-label tests passed.");
}

main().catch((err) => {
  console.error("test runner failed:", err);
  process.exit(2);
});
