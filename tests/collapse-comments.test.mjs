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
// Prose JSDoc (no @tags) converts to // line comment(s) — attached or not.
eq(
  "jsdoc prose single para -> //",
  "/**\n * a\n * b\n */\nfunction foo() {}",
  "// a b\nfunction foo() {}"
);
eq(
  "jsdoc prose two paras -> // with bare separator",
  "/**\n * one line a\n * one line b\n *\n * two line a\n * two line b\n */\nexport const x = 1;",
  "// one line a one line b\n//\n// two line a two line b\nexport const x = 1;"
);
eq(
  "jsdoc indented continuation prefix aligns",
  "  /**\n   * a\n   * b\n   */\n  const foo = 1;",
  "  // a b\n  const foo = 1;"
);
eq(
  "single-line jsdoc /** x */ -> //",
  "/** just a note */\nfunction foo() {}",
  "// just a note\nfunction foo() {}"
);
eq(
  "jsdoc above a bare return -> //",
  "/**\n * render note\n */\nreturn <div />;",
  "// render note\nreturn <div />;"
);
eq(
  "jsdoc above arrow const -> //",
  "/**\n * comp doc\n */\nconst Foo = () => null;",
  "// comp doc\nconst Foo = () => null;"
);
eq(
  "jsdoc @param untouched",
  "/**\n * Does a thing.\n * @param x the thing\n * @returns whatever\n */",
  "/**\n * Does a thing.\n * @param x the thing\n * @returns whatever\n */"
);
eq(
  "jsdoc mixed prose+tag untouched",
  "/**\n * some prose here\n * wrapped\n *\n * @example foo()\n */",
  "/**\n * some prose here\n * wrapped\n *\n * @example foo()\n */"
);
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

// Regex literals must not leak comment markers into the scanner. The `/*` inside
// this char class once desynced the scan and swallowed following code.
eq(
  "regex with /* not treated as block comment",
  'const clean = s.replace(/[^-+/*0-9.,]+/g, "");\n// a\n// b\nconst after = 1;',
  'const clean = s.replace(/[^-+/*0-9.,]+/g, "");\n// a b\nconst after = 1;'
);
eq(
  "regex with */ not treated as comment end",
  "const r = /a*/;\n// x\n// y",
  "const r = /a*/;\n// x y"
);
eq(
  "division is not misread as regex",
  "const q = total /* c */ / count;\n// p\n// q",
  "const q = total /* c */ / count;\n// p q"
);

// Deliberately structured comments (lists, banners, tables, code) survive whole.
eq(
  "bullet list in // run not merged",
  "// Formats:\n// - a: first\n// - b: second",
  "// Formats:\n// - a: first\n// - b: second"
);
eq(
  "numbered list in jsdoc untouched",
  "/**\n * Order:\n * 1. mask\n * 2. format\n */",
  "/**\n * Order:\n * 1. mask\n * 2. format\n */"
);
eq(
  "ascii banner not merged with prose",
  "// -----------------\n// Section: hit points\n// -----------------",
  "// -----------------\n// Section: hit points\n// -----------------"
);
eq(
  "commented-out code block untouched",
  "/*\n * if (x) {\n *   doThing();\n * }\n */",
  "/*\n * if (x) {\n *   doThing();\n * }\n */"
);
eq(
  "markdown table in jsdoc untouched",
  "/**\n * Example:\n * |A|B|\n * |-|-|\n * |1|2|\n */",
  "/**\n * Example:\n * |A|B|\n * |-|-|\n * |1|2|\n */"
);
eq(
  "plain prose next to a bullet: whole block skipped",
  "// intro line here\n// - bullet one\n// - bullet two",
  "// intro line here\n// - bullet one\n// - bullet two"
);

// Indented aligned lists under a label (Usage:/Options:/Reads from:) stay whole.
eq(
  "jsdoc indented Usage list untouched",
  "/**\n * Usage:\n *   pnpm tsx foo.ts <in> [opts]\n *   -o, --output <file>\n */",
  "/**\n * Usage:\n *   pnpm tsx foo.ts <in> [opts]\n *   -o, --output <file>\n */"
);
eq(
  "// run indented Reads-from list untouched",
  "// Reads from:\n//   a/b/c.json\n//   a/b/d.json",
  "// Reads from:\n//   a/b/c.json\n//   a/b/d.json"
);
// But a normal 'Note:' that merely soft-wraps (no extra indent) still merges.
eq(
  "prose 'Note:' soft-wrap still merges",
  "// Note: this wraps to\n// the next line normally",
  "// Note: this wraps to the next line normally"
);

// Prose containing the WORDS return/if/let/const must still merge (not misread
// as commented-out code). Regression: bare keywords fired mid-sentence.
eq(
  "prose with keyword 'return' merges",
  "// would return the value as data\n// and report success",
  "// would return the value as data and report success"
);
eq(
  "prose with 'let'/'if' merges",
  "// never let a create hit the error\n// if it rolls back the batch",
  "// never let a create hit the error if it rolls back the batch"
);
eq(
  "prose ending in semicolon still merges",
  "// only this warning is silenced;\n// the sibling serves the other",
  "// only this warning is silenced; the sibling serves the other"
);
// But real commented-out code (keyword at line start / brace) is skipped.
eq(
  "commented-out code (// run) untouched",
  "// export const X = [\n//   { a: 1 },\n// ];",
  "// export const X = [\n//   { a: 1 },\n// ];"
);
// Fenced code block inside jsdoc untouched.
eq(
  "jsdoc fenced code block untouched",
  "/**\n * Example:\n * ```tsx\n * <Foo />\n * ```\n */",
  "/**\n * Example:\n * ```tsx\n * <Foo />\n * ```\n */"
);
// Labelled banner (rule chars after a label) breaks the run.
eq(
  "labelled ==== banner not merged with next line",
  "// STORAGE =================\n// Dependency: localforage",
  "// STORAGE =================\n// Dependency: localforage"
);
// Unicode box-drawing banner treated as a banner.
eq(
  "box-drawing banner not merged",
  "// ─── Operator translator ───────\n// Reproduces filterByOperator",
  "// ─── Operator translator ───────\n// Reproduces filterByOperator"
);

// Linter/compiler directives must stay on their own line, never merged.
eq(
  "biome-ignore not merged into preceding comment",
  "// Debounced sync on changes\n// biome-ignore lint/correctness/useExhaustiveDependencies: only sync flags",
  "// Debounced sync on changes\n// biome-ignore lint/correctness/useExhaustiveDependencies: only sync flags"
);
eq(
  "eslint-disable-next-line not merged",
  "// use eval carefully\n// eslint-disable-next-line no-eval",
  "// use eval carefully\n// eslint-disable-next-line no-eval"
);
eq(
  "two adjacent biome-ignores not merged",
  "// biome-ignore lint/correctness/useImageSize: external url\n// biome-ignore lint/performance/noImgElement: markdown image",
  "// biome-ignore lint/correctness/useImageSize: external url\n// biome-ignore lint/performance/noImgElement: markdown image"
);
eq(
  "run around a directive still merges the non-directive part",
  "// a\n// b\n// biome-ignore lint/x: y",
  "// a b\n// biome-ignore lint/x: y"
);
eq(
  "block directive comment untouched",
  "/* biome-ignore lint/x: y\n   more */",
  "/* biome-ignore lint/x: y\n   more */"
);

// Idempotent: collapsing twice equals collapsing once.
const once = apply("/* a\n b */\n// x\n// y");
eq("idempotent", once, apply(once));

const jsdocOnce = apply("/**\n * a\n * b\n *\n * c\n * d\n */");
eq("jsdoc idempotent", jsdocOnce, apply(jsdocOnce));

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nall collapse-comments tests passed");
}
