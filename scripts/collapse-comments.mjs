#!/usr/bin/env node
// Collapse multiline comments to a single line so the editor owns soft-wrapping.
//
// - Non-JSDoc block comments /* ... */ with newlines -> one-line /* a b c */
// - Runs of adjacent, same-indent, standalone // lines -> one // line
// - JSDoc /** ... */ is left untouched (its line structure is semantic).
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

// Walk the source, emitting { kind, start, end } for every comment. Strings and
// template literals are skipped char-by-char (same loop shape as the other
// codemods' maskStringsAndComments) so a // or /* inside a string is ignored.
function scanComments(src) {
  const comments = [];
  let i = 0;
  const n = src.length;
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
      i = j;
      continue;
    }
    i++;
  }
  return comments;
}

// Collapse block-comment inner text: strip leading `*`/whitespace per line,
// join non-empty lines with single spaces.
function collapseBlock(raw) {
  const inner = raw.slice(2, -2); // drop /* and */
  const body = inner
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s?/, "").trimEnd())
    .filter((line) => line.length > 0)
    .join(" ")
    .trim();
  return `/* ${body} */`;
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
    if (c.text.startsWith("/**") && c.text !== "/**/") continue; // JSDoc
    if (!c.text.includes("\n")) continue; // already one line
    const collapsed = collapseBlock(c.text);
    if (collapsed !== c.text) edits.push({ start: c.start, end: c.end, text: collapsed });
  }

  // Group standalone // lines that are adjacent + same indent into runs.
  const lineComments = comments.filter((c) => c.kind === "line" && c.standalone);
  let i = 0;
  while (i < lineComments.length) {
    const first = lineComments[i];
    let j = i + 1;
    while (
      j < lineComments.length &&
      lineComments[j].line === lineComments[j - 1].line + 1 &&
      lineComments[j].indent === first.indent
    ) {
      j++;
    }
    if (j - i >= 2) {
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

Rewrites non-JSDoc /* */ blocks and runs of adjacent // lines to a single line
so the editor owns soft-wrapping. JSDoc /** */ is left untouched.

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
