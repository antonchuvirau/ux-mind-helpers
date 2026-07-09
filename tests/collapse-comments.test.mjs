#!/usr/bin/env node
// Tests for collapse-comments: block collapse, // runs, JSDoc/string safety,
// and idempotency. Assert-based (no fixtures) — the transform is pure.

import process from "node:process";

import { transformSource } from "../scripts/collapse-comments.mjs";

// transformSource returns null on no-op; treat that as "unchanged".
function apply(src) {
  const result = transformSource(src);
  return result ? result.code : src;
}

const failures = [];
function eq(label, input, expected) {
  const got = apply(input);
  if (got === expected) {
    console.log(`  v ${label}`);
  } else {
    failures.push(label);
    console.error(
      `  X ${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(expected)}`
    );
  }
}

eq("block collapse", "/* a\n   b\n   c */", "/* a b c */");
eq("block star-prefixed", "/* a\n * b\n * c */", "/* a b c */");
eq("jsdoc untouched", "/** keep\n * x */", "/** keep\n * x */");
eq(
  "url in string untouched",
  'const u = "http://x";\n// one\n// two',
  'const u = "http://x";\n// one two'
);
eq("adjacent // merged", "\t// one\n\t// two\n\t// three", "\t// one two three");
eq(
  "trailing // not merged with next",
  "x = 1 // trailing\n// next",
  "x = 1 // trailing\n// next"
);
eq("single // untouched", "// solo", "// solo");
eq("blank line breaks run", "// a\n\n// b", "// a\n\n// b");
eq("different indent not merged", "// a\n  // b", "// a\n  // b");
eq("// inside string untouched", 'const s = "a // b";', 'const s = "a // b";');
eq(
  "block marker in template untouched",
  "const t = `a /* b */ c`;",
  "const t = `a /* b */ c`;"
);

// Idempotent: collapsing twice equals collapsing once.
const once = apply("/* a\n b */\n// x\n// y");
eq("idempotent", once, apply(once));

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nall collapse-comments tests passed");
}
