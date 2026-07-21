#!/usr/bin/env node
// Collapse multiline comments to a single line so the editor owns soft-wrapping.
//
// - Non-JSDoc block comments /* ... */ with newlines -> one-line /* a b c */
// - Runs of adjacent, same-indent, standalone // lines -> one // line
// - Prose JSDoc /** ... */ (no @tags) converts to // line comment(s), one per
//   paragraph — it has no IDE doc value. JSDoc with @tags is left untouched.
// - Linter/compiler directives (biome-ignore, eslint-disable, @ts-*, …) are
//   never collapsed or merged — they must stay first on their own line.
// - Deliberately-formatted comments are left whole: bullet/numbered lists,
//   markdown/ascii tables, ---- banners, and commented-out code.
// - Regex literals are skipped too, so a /* or */ inside a char class (e.g.
//   /[^/*]/) is never mistaken for a comment and made to swallow real code.
//
// A hand-rolled scanner (no deps) walks the source and yields comment spans,
// skipping strings, template literals, and regex-like text so comment markers
// inside "http://x" or JSX are never touched.

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { confirm, isInteractive } from "./lib/prompt.mjs";
import { collectSourceFiles, toRelativePath } from "./lib/walk-files.mjs";

// A `/` begins a regex literal (not division/comment) when the previous
// significant token is not a value — i.e. it follows an operator, opener, or
// keyword. This is the standard heuristic; it can misread `a /b/g` where `a` is
// a value divided twice, but that shape never occurs in real code, and getting
// it wrong here only skips a would-be comment, never corrupts source.
const RE_ALLOW_BEFORE = /[([{,;:=!&|?+\-*/%^~<>]/;
const RE_KEYWORD_BEFORE = /(^|[^.\w$])(return|typeof|instanceof|in|of|new|delete|void|do|else|yield|await|case)$/;

function regexAllowedAfter(prevSignificant, srcBefore) {
  if (prevSignificant === "") return true; // start of file
  if (RE_ALLOW_BEFORE.test(prevSignificant)) return true;
  return RE_KEYWORD_BEFORE.test(srcBefore);
}

// Walk the source, emitting { kind, start, end } for every comment. Strings,
// template literals, and regex literals are skipped char-by-char (same loop
// shape as the other codemods' maskStringsAndComments) so a // or /* inside a
// string OR a regex character class (e.g. /[^/*]/) is never mistaken for a
// comment.
function scanComments(src) {
  const comments = [];
  let i = 0;
  const n = src.length;
  let prevSignificant = ""; // last non-whitespace, non-comment char seen
  const setPrev = (ch) => {
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") prevSignificant = ch;
  };
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      comments.push({ kind: "line", start: i, end: stop });
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      comments.push({ kind: "block", start: i, end: stop });
      i = stop;
      continue;
    }
    // Regex literal: skip its body (incl. character classes) so `/[^/*]/` or
    // `/a\/b/` never leaks a comment marker. Only when a regex is allowed here.
    if (c === "/" && regexAllowedAfter(prevSignificant, src.slice(0, i))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const ch = src[j];
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === "\n") break; // unterminated — bail, treat `/` as division
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) {
          closed = true;
          j++;
          break;
        }
        j++;
      }
      if (closed) {
        prevSignificant = "/"; // regex is a value; a following `/` is division
        i = j;
        continue;
      }
      // not a real regex (hit newline) — fall through, advance one char
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === quote) {
          j++;
          break;
        }
        if (src[j] === "\n") break;
        j++;
      }
      prevSignificant = quote; // a string is a value
      i = j;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (depth === 0 && src[j] === "`") {
          j++;
          break;
        }
        if (src[j] === "$" && src[j + 1] === "{") {
          depth++;
          j += 2;
          continue;
        }
        if (depth > 0 && src[j] === "}") {
          depth--;
          j++;
          continue;
        }
        j++;
      }
      prevSignificant = "`"; // a template literal is a value
      i = j;
      continue;
    }
    setPrev(c);
    i++;
  }
  return comments;
}

// Linter/compiler directives are position-sensitive: they must be the first
// token of their own comment line or the tool stops honoring them. Never merge
// or collapse a comment that carries one, and never merge it into a neighbor.
const DIRECTIVE_RE =
  /\b(biome-ignore|eslint-disable|eslint-enable|ts-expect-error|ts-ignore|ts-nocheck|prettier-ignore|v8 ignore|c8 ignore|istanbul ignore|@ts-)/;

function isDirective(text) {
  return DIRECTIVE_RE.test(text);
}

// Some comments are deliberately formatted and must survive verbatim: bullet or
// numbered lists, aligned tables, ASCII banners, or commented-out code. Joining
// their lines produces an unreadable run-on. Detect any such structure and skip
// the whole comment. `lines` is the inner text already stripped of comment
// markers (`//`, `*`) and per-line indentation-normalised is NOT required.
const BULLET_RE = /^\s*([-*+•]\s|\d+[.)]\s)/; // - x | * x | + x | • x | 1. x | 2) x
// A divider/banner. Two shapes:
//  - 4+ rule chars in a run anywhere (bare `----`, labelled `STORAGE =====`);
//  - a line STARTING with 3+ rule chars (`--- Section ---` labelled banners),
//    which prose almost never does.
const BANNER_RE = /[-=~─━═]{4,}|[*#]{4,}|^\s*[-=~─━═]{3,}\s/;
const TABLE_RE = /^\s*\|.*\|/; // |A|B| markdown/ascii table row
const FENCE_RE = /^\s*```/; // ``` fenced code block
// Commented-out code: a statement keyword STARTING the line (bare `return`/`if`
// etc. mid-prose are common English words, so we anchor to line start), an arrow
// fn, or a line ending in `;`/`{`/`}`. Prose rarely matches; code reliably does.
// Commented-out code signals, tuned to not fire on prose:
//  - a declaration/import keyword at line start followed by an identifier
//    (`const x`, `export function y`, `import z`) — "return the value" won't match;
//  - a control keyword directly followed by `(` (`if (`, `for (`, `switch (`);
//  - an arrow function `=>`, or a line ending in a brace.
const CODE_RE =
  /^\s*(export\s+)?(function|const|let|var|class|import|async)\s+[\w{[*]|^\s*(if|for|while|switch|catch)\s*\(|=>|[{}]\s*$/;

function isStructural(line) {
  return (
    BULLET_RE.test(line) ||
    TABLE_RE.test(line) ||
    FENCE_RE.test(line) ||
    BANNER_RE.test(line) ||
    CODE_RE.test(line)
  );
}

function hasStructure(lines) {
  return lines.some((line) => line.trim() !== "" && isStructural(line));
}

// Indent-aligned content: any non-empty line indented DEEPER than the comment's
// own base (minimum) indent. This is the shape of `Usage:` / `Options:` /
// `Reads from:` reference blocks AND bare indented command/path blocks (no label
// needed). Plain prose that merely soft-wraps keeps a flat indent, so it isn't
// tripped. `contentLines` keep content indentation (only the `*`/`//` marker
// stripped), so indents are comparable.
function indentWidth(line) {
  const m = line.match(/^\s*/);
  return m ? m[0].length : 0;
}
function hasIndentedList(contentLines) {
  const nonEmpty = contentLines.filter((l) => l.trim() !== "");
  if (nonEmpty.length < 2) return false;
  const base = Math.min(...nonEmpty.map(indentWidth));
  return nonEmpty.some((l) => indentWidth(l) > base);
}

// Inner lines with ONLY the comment marker stripped (`*` for block, `//` for
// line) but content indentation preserved — for indent-sensitive checks.
function contentLines(raw, kind) {
  const inner = kind === "line" ? raw : raw.slice(raw.startsWith("/**") ? 3 : 2, -2);
  const strip = kind === "line" ? /^\/\/ ?/ : /^\s*\* ?/;
  return inner.split("\n").map((line) => line.replace(strip, "").replace(/\s+$/, ""));
}

// Single `//` line (marker stripped) that must not participate in a merge.
function isStructuralLine(text) {
  return isStructural(text.replace(/^\/\/\s?/, ""));
}

// Split a comment body into physical lines with comment markers stripped, so
// hasStructure/collapse see the raw prose. `openLen` is the opener width (2 for
// `/*`, 3 for `/**`); the trailing `*/` is always 2. Fully trimmed: a wrapped
// line's residual leading indent must not survive as a double space at the join
// (` *  Must` -> `Must`, not ` Must`). Structure regexes are `^\s*`-tolerant, so
// trimming doesn't hide bullets/tables.
function innerLines(raw, openLen) {
  return raw
    .slice(openLen, -2)
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s?/, "").trim());
}

// Collapse block-comment inner text: strip leading `*`/whitespace per line,
// join non-empty lines with single spaces.
function collapseBlock(raw) {
  const body = innerLines(raw, 2) // drop /* and */
    .filter((line) => line.length > 0)
    .join(" ")
    .trim();
  return `/* ${body} */`;
}

// True if a JSDoc block carries any @tag (@param, @returns, @example, …). Such
// blocks are semantic per-line (and @example may hold code) — leave them alone.
function isTagJsdoc(text) {
  return /^\s*\*?\s*@\w/m.test(text.slice(3, -2));
}

// Group a block's inner lines into paragraphs: each blank-line-separated run of
// lines joins to one soft-wrap line.
function jsdocParagraphs(raw) {
  const lines = innerLines(raw, 3); // drop /** and */
  const paragraphs = [];
  let current = [];
  for (const line of lines) {
    if (line.length === 0) {
      if (current.length > 0) {
        paragraphs.push(current.join(" ").trim());
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current.join(" ").trim());
  return paragraphs.filter(Boolean);
}

// Convert a prose JSDoc block to `//` line comments: one line per paragraph, a
// bare `//` separator between paragraphs. The first line sits at the comment's
// existing column (the replacement span starts at `/**`), so only continuation
// lines get the `indent` prefix.
function jsdocToLineComment(raw, indent) {
  return jsdocParagraphs(raw)
    .map((p) => `// ${p}`)
    .join(`\n${indent}//\n${indent}`);
}

// True if the range [lineStart, tokenStart) on the token's line is only whitespace.
function isStandalone(src, tokenStart) {
  let i = tokenStart - 1;
  while (i >= 0 && src[i] !== "\n") {
    if (src[i] !== " " && src[i] !== "\t") return false;
    i--;
  }
  return true;
}

function indentOf(src, tokenStart) {
  let i = tokenStart - 1;
  while (i >= 0 && src[i] !== "\n") i--;
  return src.slice(i + 1, tokenStart);
}

function lineOf(src, pos) {
  let line = 0;
  for (let i = 0; i < pos; i++) if (src[i] === "\n") line++;
  return line;
}

export function transformSource(src) {
  const raw = scanComments(src);
  const comments = raw.map((c) => {
    const text = src.slice(c.start, c.end);
    return {
      ...c,
      text,
      line: lineOf(src, c.start),
      standalone: isStandalone(src, c.start),
      indent: indentOf(src, c.start),
    };
  });

  const edits = [];

  for (const c of comments) {
    if (c.kind !== "block") continue;
    if (isDirective(c.text)) continue; // linter/compiler directive

    const isJsdoc = c.text.startsWith("/**") && c.text !== "/**/";

    if (isJsdoc) {
      if (isTagJsdoc(c.text)) continue; // @tag JSDoc: semantic, skip
      if (hasStructure(innerLines(c.text, 3))) continue; // list/table/banner/fence/code
      if (hasIndentedList(contentLines(c.text, "block"))) continue; // Usage:/Options: block
      // Prose JSDoc has no IDE value (no @tags) — convert to plain // line
      // comment(s), one per paragraph, regardless of what follows.
      const converted = jsdocToLineComment(c.text, c.indent);
      if (converted !== c.text) edits.push({ start: c.start, end: c.end, text: converted });
      continue;
    }

    if (!c.text.includes("\n")) continue; // plain /* */ already one line
    if (hasStructure(innerLines(c.text, 2))) continue; // list/table/banner/fence/code

    const collapsed = collapseBlock(c.text);
    if (collapsed !== c.text) edits.push({ start: c.start, end: c.end, text: collapsed });
  }

  // Group standalone // lines that are adjacent + same indent into runs.
  const lineComments = comments.filter((c) => c.kind === "line" && c.standalone);
  let i = 0;
  while (i < lineComments.length) {
    const first = lineComments[i];
    // Directives never merge and break the run at their boundary.
    if (isDirective(first.text)) {
      i += 1;
      continue;
    }
    // Maximal adjacent, same-indent, non-directive run.
    let j = i + 1;
    while (
      j < lineComments.length &&
      lineComments[j].line === lineComments[j - 1].line + 1 &&
      lineComments[j].indent === first.indent &&
      !isDirective(lineComments[j].text)
    ) {
      j++;
    }
    // If ANY line in the run is structural (bullet/table/banner/fence/code), the
    // whole run is deliberately formatted — leave it verbatim. Lists and
    // commented-out code span multiple lines, so a per-line break would flatten
    // the rest; skipping the entire run preserves it.
    const runLines = lineComments.slice(i, j);
    const runIsStructural =
      runLines.some((c) => isStructuralLine(c.text)) ||
      hasIndentedList(runLines.map((c) => c.text.replace(/^\/\/ ?/, "").replace(/\s+$/, "")));
    if (!runIsStructural && j - i >= 2) {
      const bodies = lineComments
        .slice(i, j)
        .map((c) => c.text.replace(/^\/\/\s?/, "").trim())
        .filter(Boolean);
      const merged = `// ${bodies.join(" ")}`;
      edits.push({ start: first.start, end: lineComments[j - 1].end, text: merged });
    }
    i = j;
  }

  if (edits.length === 0) return null;
  edits.sort((a, b) => b.start - a.start); // back-to-front so offsets stay valid
  let out = src;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  if (out === src) return null;
  return { code: out };
}

// ---------- CLI ----------

const HELP = `collapse-comments - collapse multiline comments to one line

Usage: collapse-comments [options]

Rewrites /* */ blocks and runs of adjacent // lines to a single line so the
editor owns soft-wrapping. Prose JSDoc /** */ (no @tags) converts to // line
comment(s), one per paragraph; JSDoc with @tags and linter directives are left
untouched.

Options:
  -s, --src <dir>     Source directory to scan (default: ".")
  -e, --ext <list>    Comma-separated extensions (default: ".ts,.tsx,.js,.jsx,.mjs,.cjs,.mts,.cts")
      --skip <list>   Comma-separated dirs to skip (default: "node_modules,.next,.turbo,.git,dist,out,coverage")
      --dry-run       Print changes only, do not prompt or write (exit 1 if changes pending)
  -y, --yes           Apply without prompting (non-interactive)
  -h, --help          Show this help`;

async function main() {
  const { values } = parseArgs({
    options: {
      src: { type: "string", short: "s", default: "." },
      ext: {
        type: "string",
        short: "e",
        default: ".ts,.tsx,.js,.jsx,.mjs,.cjs,.mts,.cts",
      },
      skip: {
        type: "string",
        default: "node_modules,.next,.turbo,.git,dist,out,coverage",
      },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const rootDir = values.src;
  const extensions = values.ext.split(",").map((e) => e.trim()).filter(Boolean);
  const ignoredDirs = values.skip.split(",").map((s) => s.trim()).filter(Boolean);

  const files = await collectSourceFiles(rootDir, { extensions, ignoredDirs });

  const pending = [];
  for (const filePath of files) {
    const originalCode = await readFile(filePath, "utf8");
    const result = transformSource(originalCode);
    if (result && result.code !== originalCode) {
      pending.push({ filePath, code: result.code });
    }
  }

  if (pending.length === 0) {
    console.log("No matches found (collapse-comments).");
    return;
  }

  console.log(`Would update ${pending.length} file(s):`);
  for (const entry of pending) {
    console.log(`- ${toRelativePath(rootDir, entry.filePath)}`);
  }

  if (values["dry-run"]) {
    console.log("\n--dry-run: no changes written.");
    process.exitCode = 1;
    return;
  }

  let apply = values.yes;
  if (!apply) {
    if (!isInteractive()) {
      console.error("\nNon-interactive shell; pass --yes to apply or --dry-run to silence.");
      process.exitCode = 1;
      return;
    }
    apply = await confirm("\nApply changes?");
  }

  if (!apply) {
    console.log("Aborted. No files written.");
    return;
  }

  for (const entry of pending) {
    await writeFile(entry.filePath, entry.code, "utf8");
  }
  console.log(`\nUpdated ${pending.length} file(s).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
