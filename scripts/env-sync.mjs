#!/usr/bin/env node
// Format every `.env*` file from the env schema, and report cross-file drift — without ever printing a value.
//
// Env files accumulate whatever order things were pasted in, and tidying one by hand means opening it — normally blocked so secrets stay out of context and scrollback. Worse, nothing knows what the full key set is supposed to be, so a variable added to one environment reaches the others only if someone remembers. This script derives both the layout and the expected key set from the schema file (`env.ts` by default), so the schema stays the single source of truth.
//
// The safety property is about OUTPUT, not input — the process must read the file to rewrite it. What it guarantees:
//   - No value is ever printed, logged, or included in a diff. Only key names, counts and section titles.
//   - Values are copied byte-for-byte from the right of the first `=`. Quoting, whitespace, `#` inside a value, multi-line values and dotenvx-encrypted blobs all survive untouched.
//   - A key present in the file but absent from the schema is never dropped — it lands in an "Uncategorised" section.
//   - Nothing is written unless the key set is unchanged; the rewrite is comments and order only. Two opt-in exceptions: `--scaffold` ADDS a schema key with an empty value, `--prune` REMOVES a key both absent from the schema and empty. Neither alters an existing value.
//
// Usage:
//   ux-mind-helpers env-sync                  # every .env* file present, in place
//   ux-mind-helpers env-sync --check          # exit 1 if unformatted or parity fails; writes nothing
//   ux-mind-helpers env-sync .env.local       # only these files
//   ux-mind-helpers env-sync --scaffold       # additionally add missing required keys, with an empty value
//   ux-mind-helpers env-sync --prune          # additionally drop keys absent from the schema AND empty
//
// See env-sync.md for full options + tradeoffs.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ICONS = { fail: "X", warn: "!", pass: "v" };

const DEFAULT_CONFIG = {
  schema: "env.ts",
  // `.env.claude` holds MCP/tooling credentials unrelated to the app schema, so formatting it against `env.ts` would file every one of its keys under Uncategorised. Excluded by default; override with --ignore.
  ignore: [".env.claude"],
};

// Backup copies are excluded from a directory sweep. Rewriting someone's `.env.local.rescue` defeats the reason they made it — found the hard way, an earlier version of this script did exactly that on its first real run.
const IGNORED_SUFFIX = /\.(bak|backup|rescue|orig|save|old|tmp|example\.local)$/;

// A key is `KEY=`, optionally `export KEY=`. Everything right of the first `=` is the value and is never inspected.
const ASSIGNMENT_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

// A schema entry: exactly 4 spaces of indent, then `KEY:`. The indent is what distinguishes a declaration from a continuation line of the expression above it.
const SCHEMA_KEY_RE = /^ {4}([A-Z][A-Z0-9_]*):\s*(.*)$/;
// The top-level blocks of `createEnv({...})` that this script cares about.
const SCHEMA_BLOCK_RE = /^ {2}(server|client|runtimeEnv|experimental__runtimeEnv):\s*\{/;
// A section marker: `// ── Title`. The box-drawing run is what separates it from an ordinary comment.
const SECTION_MARKER_RE = /^\s*\/\/\s*─+\s*(.+?)\s*$/;
const LINE_COMMENT_RE = /^\s*\/\/ ?(.*)$/;

const RULE_WIDTH = 79;

const HEADER = {
  ".env.example":
    "Template for a real env file. Copy it, fill in the values, never commit the copy.\n\nThis file IS tracked in git — keep it secret-free.",
  default:
    "NOT committed — `.gitignore` covers `.env*`. See `.env.example` for the tracked template and the meaning of each variable.",
};

const headerTail = (schema) =>
  `Every variable here must also be declared in \`${schema}\` (schema + \`runtimeEnv\`), which validates the environment at startup — an undeclared variable is invisible to the app even when set.\n\nRead values with \`pnpm exec dotenvx run --strict -f <file> -- <command>\`. Never \`cat\` an env file.\n\nReformat with \`pnpm env:format\` — never by hand, and never by opening the file.`;

const divider = () => `# ${"─".repeat(RULE_WIDTH - 2)}`;

function sectionRule(title) {
  const prefix = `# ── ${title} `;
  return prefix + "─".repeat(Math.max(3, RULE_WIDTH - prefix.length));
}

function commentBlock(text) {
  return text.split("\n").map((line) => (line ? `# ${line}` : "#"));
}

/**
 * Splits an env file into `KEY -> raw value text`, preserving multi-line values.
 *
 * A value continues onto the next line while a quote opened on the first line is still open — how dotenvx writes encrypted blobs and how anyone writes a PEM key. Treating those lines as separate entries would corrupt them, so they are consumed whole.
 *
 * `duplicates` names every key assigned more than once. That is always a bug (the last assignment silently wins) and is invisible without a tool, so it is collected here rather than left to the caller to notice.
 */
export function parseAssignments(source) {
  const lines = source.split(/\r?\n/);
  const entries = new Map();
  const order = [];
  const duplicates = [];

  for (let i = 0; i < lines.length; i++) {
    const match = ASSIGNMENT_RE.exec(lines[i]);
    if (!match) continue;

    const key = match[1];
    let value = lines[i].slice(lines[i].indexOf("=") + 1);

    // Consume continuation lines while a quote opened on the first line is still open.
    const quote = /^\s*(['"`])/.exec(value)?.[1];
    if (quote) {
      let body = value.trimStart().slice(1);
      while (!body.includes(quote) && i + 1 < lines.length) {
        i++;
        value += `\n${lines[i]}`;
        body = lines[i];
      }
    }

    if (entries.has(key)) {
      if (!duplicates.includes(key)) duplicates.push(key);
    } else {
      order.push(key);
    }
    entries.set(key, value);
  }

  return { entries, order, duplicates };
}

/**
 * True when a key's accumulated expression is a complete declaration: every bracket opened is closed, and it ends with the `,` that separates one entry from the next.
 *
 * Strings and comments are stripped before counting, so a `(` inside a regex literal or an error message — `z.string().regex(/^sk_/, "must be (secret)")` — cannot leave the depth permanently unbalanced and swallow the rest of the block.
 */
function isExpressionComplete(text) {
  const stripped = text
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Regex literals, then each quote style. Ordered so a quote inside a regex (and vice versa) is consumed by whichever opened first.
    .replace(/\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*/g, "R")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");

  let depth = 0;
  for (const char of stripped) {
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
  }
  return depth <= 0 && /,\s*$/.test(stripped);
}

/**
 * Reads the env schema file as text and returns the declared keys, in declaration order, each with its section, comment and optionality.
 *
 * Text rather than an AST or an import, for three reasons: it needs no TypeScript loader, it cannot execute project code, and the two things a schema object does not expose anyway — the per-key comments and their grouping — are exactly what the layout is built from. (Verified: t3-env's export enumerates key names only; the Zod schemas are not reachable, so optionality has to come from here.)
 *
 * `runtimeEnv` is deliberately NOT parsed. It restates every key as `KEY: process.env.KEY`, so folding it into the same map overwrites each schema expression and reports every key as required.
 */
export function parseSchema(source) {
  const lines = source.split(/\r?\n/);
  const keys = new Map();

  let block = null;
  let section = null;
  let comment = [];
  let key = null;
  let expression = [];
  let keySection = null;
  let keyComment = [];

  const flush = () => {
    // `runtimeEnv` entries are restatements, not declarations — see the note above.
    if (key && block !== "runtimeEnv" && block !== "experimental__runtimeEnv" && !keys.has(key)) {
      const expr = expression.join(" ");
      keys.set(key, {
        block,
        section: keySection,
        comment: keyComment,
        optional: expr.includes(".optional()"),
      });
    }
    key = null;
    expression = [];
  };

  for (const line of lines) {
    const blockMatch = SCHEMA_BLOCK_RE.exec(line);
    if (blockMatch) {
      flush();
      block = blockMatch[1];
      section = null;
      comment = [];
      continue;
    }
    if (!block) continue;

    // A closing brace at 2-space indent ends the current block.
    if (/^ {2}\}/.test(line)) {
      flush();
      block = null;
      section = null;
      comment = [];
      continue;
    }

    const keyMatch = SCHEMA_KEY_RE.exec(line);
    if (keyMatch) {
      flush();
      key = keyMatch[1];
      expression = [keyMatch[2]];
      keySection = section;
      keyComment = comment;
      comment = [];
      // A single-line declaration (`FOO: z.string(),`) is already complete, so close it now rather than treating the next lines as its continuation.
      if (isExpressionComplete(keyMatch[2])) flush();
      continue;
    }

    // Inside a key's expression, a line is a continuation until the expression is balanced and terminated — which is what keeps a multi-line schema's trailing `.optional()` attached to its key. Closing on the *next* `KEY:` instead would be simpler but wrong: it swallows the comments and section markers that sit between two keys, attributing them to the key above.
    if (key) {
      expression.push(line.trim());
      if (isExpressionComplete(expression.join("\n"))) flush();
      continue;
    }

    const markerMatch = SECTION_MARKER_RE.exec(line);
    if (markerMatch) {
      section = markerMatch[1];
      comment = [];
      continue;
    }

    const commentMatch = LINE_COMMENT_RE.exec(line);
    if (commentMatch) {
      comment.push(commentMatch[1]);
      continue;
    }

    // Any other line (blank, a stray brace, a JSDoc block) breaks the comment run, so a comment only ever attaches to the key directly beneath it.
    comment = [];
  }
  flush();

  return keys;
}

/** Keys declared in `server`/`client` but absent from `runtimeEnv` are invisible at runtime — the app reads `undefined` no matter what the env file says. Cheap to detect here, so it is. */
export function findRuntimeEnvGaps(source) {
  const lines = source.split(/\r?\n/);
  const declared = new Set();
  const wired = new Set();
  let block = null;

  for (const line of lines) {
    const blockMatch = SCHEMA_BLOCK_RE.exec(line);
    if (blockMatch) {
      block = blockMatch[1];
      continue;
    }
    if (!block) continue;
    if (/^ {2}\}/.test(line)) {
      block = null;
      continue;
    }
    const keyMatch = SCHEMA_KEY_RE.exec(line);
    if (!keyMatch) continue;
    if (block === "runtimeEnv" || block === "experimental__runtimeEnv") wired.add(keyMatch[1]);
    else declared.add(keyMatch[1]);
  }

  // A spread (`...oauthRuntimeEnv`) wires keys this parser cannot see, so the check is skipped entirely rather than reporting false gaps.
  if (/^\s*\.\.\./m.test(source)) return [];
  return [...declared].filter((k) => !wired.has(k));
}

/** Renders one env file: schema order, schema comments, schema sections, then anything left over under "Uncategorised". */
export function render(filename, entries, schemaKeys, schemaPath) {
  const header = HEADER[filename] ?? HEADER.default;
  const out = [
    divider(),
    ...commentBlock(header),
    "#",
    ...commentBlock(headerTail(schemaPath)),
    divider(),
    "",
  ];

  // Group the schema's keys by section, preserving declaration order within each and section order by first appearance. A key with no marker above it groups under "" and renders without a rule.
  const sections = new Map();
  for (const [key, meta] of schemaKeys) {
    if (!entries.has(key)) continue;
    const title = meta.section ?? "";
    if (!sections.has(title)) sections.set(title, []);
    sections.get(title).push([key, meta]);
  }

  const placed = new Set();
  for (const [title, keys] of sections) {
    if (title) out.push(sectionRule(title), "");
    for (const [key, meta] of keys) {
      if (meta.comment.length > 0) out.push(...meta.comment.map((c) => (c ? `# ${c}` : "#")));
      out.push(`${key}=${entries.get(key)}`, "");
      placed.add(key);
    }
  }

  const leftover = [...entries.keys()].filter((key) => !placed.has(key));
  if (leftover.length > 0) {
    out.push(
      sectionRule("Uncategorised"),
      "",
      ...commentBlock(
        `Not declared in \`${schemaPath}\`. Add each to the schema (and to \`runtimeEnv\`) with a comment saying why it exists, or delete it.`
      ),
      ""
    );
    for (const key of leftover) out.push(`${key}=${entries.get(key)}`, "");
  }

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function parseArgs(argv) {
  const args = {
    check: false,
    scaffold: false,
    scaffoldAll: false,
    prune: false,
    schema: null,
    ignore: null,
    cwd: process.cwd(),
    help: false,
    files: [],
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--check") args.check = true;
    else if (a === "--scaffold") args.scaffold = true;
    else if (a === "--scaffold=all") {
      args.scaffold = true;
      args.scaffoldAll = true;
    } else if (a === "--prune") args.prune = true;
    else if (a === "--schema" && argv[i + 1]) {
      args.schema = argv[i + 1];
      i++;
    } else if (a === "--ignore" && argv[i + 1]) {
      args.ignore = argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (a === "--cwd" && argv[i + 1]) {
      args.cwd = path.resolve(argv[i + 1]);
      i++;
    } else if (!a.startsWith("--")) args.files.push(a);
  }
  return args;
}

const HELP = `env-sync - format every .env* file from the env schema, and report cross-file drift

Usage:
  ux-mind-helpers env-sync [files...] [options]

Options:
  --check              Exit 1 if any file is unformatted or parity fails.
                       Writes nothing. Use in CI.
  --scaffold           Also add each missing REQUIRED schema key, with an
                       empty value. Never alters an existing value.
  --scaffold=all       As above, including optional keys.
  --prune              Also drop keys that are BOTH absent from the schema
                       AND empty. A key holding a value is never removed.
  --schema <path>      Schema file to derive layout from (default: env.ts)
  --ignore <files>     Comma-separated env files to skip
                       Default: .env.claude
  --cwd <path>         Run as if invoked from <path> (default: process.cwd())
  --help, -h           Show this message

No value is ever printed. Output is key names, counts and section titles only.

Exit codes:
  0  every file formatted and parity clean
  1  unformatted file, missing required key, or duplicate key
  2  internal error (schema unreadable, key set would change)`;

function relative(cwd, file) {
  const rel = path.relative(cwd, file);
  return rel === "" ? path.basename(file) : rel;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const schemaPath = args.schema ?? DEFAULT_CONFIG.schema;
  const schemaFull = path.resolve(args.cwd, schemaPath);
  if (!existsSync(schemaFull)) {
    console.error(`${ICONS.fail} schema not found: ${schemaPath}`);
    console.error(`  Pass --schema <path> if the env schema lives elsewhere.`);
    return 2;
  }

  const schemaSource = readFileSync(schemaFull, "utf8");
  const schemaKeys = parseSchema(schemaSource);
  if (schemaKeys.size === 0) {
    console.error(`${ICONS.fail} no keys found in ${schemaPath} — expected \`server\`/\`client\` blocks with 4-space-indented KEY: entries.`);
    return 2;
  }

  const required = new Set(
    [...schemaKeys]
      // NODE_ENV is supplied by the runtime and must not be set in an env file, so it is never "missing".
      .filter(([key, meta]) => !meta.optional && key !== "NODE_ENV")
      .map(([key]) => key)
  );

  const ignore = new Set(args.ignore ?? DEFAULT_CONFIG.ignore);
  const targets =
    args.files.length > 0
      ? args.files.map((f) => path.resolve(args.cwd, f))
      : readdirSync(args.cwd)
          .filter(
            (name) =>
              name.startsWith(".env") && !IGNORED_SUFFIX.test(name) && !ignore.has(name)
          )
          .sort()
          .map((name) => path.join(args.cwd, name));

  if (targets.length === 0) {
    console.log("no .env* files found");
    return 0;
  }

  const optionalCount = schemaKeys.size - required.size;
  console.log(
    `env-sync — ${targets.length} file(s), ${schemaKeys.size} schema keys (${required.size} required, ${optionalCount} optional)\n`
  );

  const rows = [];
  const problems = [];
  let unformatted = 0;
  let failed = 0;

  for (const target of targets) {
    const filename = path.basename(target);
    const label = relative(args.cwd, target);

    if (!existsSync(target)) {
      console.error(`${ICONS.fail} ${label}: not found`);
      failed++;
      continue;
    }
    if (!statSync(target).isFile()) continue;

    const original = readFileSync(target, "utf8");
    const { entries, order, duplicates } = parseAssignments(original);

    if (entries.size === 0) {
      console.log(`${ICONS.warn} ${label}: no assignments, skipped`);
      continue;
    }

    // Only under --scaffold, and only ever with an empty value. `emptyStringAsUndefined` means a scaffolded `KEY=` reads as undefined: an optional key stays disabled, a required one fails at boot naming itself.
    const scaffolded = [];
    if (args.scaffold) {
      for (const [key, meta] of schemaKeys) {
        // `vercel env pull` writes and rotates this section itself; a placeholder would invite filling it in by hand.
        if (meta.section?.startsWith("Managed by")) continue;
        if (!args.scaffoldAll && meta.optional) continue;
        if (!entries.has(key)) {
          entries.set(key, "");
          order.push(key);
          scaffolded.push(key);
        }
      }
    }

    // The inverse of scaffolding, deliberately narrow: only keys the schema does not declare AND whose value is empty. A key with a value lands in Uncategorised, visible rather than deleted.
    const pruned = [];
    if (args.prune) {
      for (const key of [...entries.keys()]) {
        if (!schemaKeys.has(key) && entries.get(key).trim() === "") {
          entries.delete(key);
          order.splice(order.indexOf(key), 1);
          pruned.push(key);
        }
      }
    }

    const missingRequired = [...required].filter((key) => !entries.has(key));
    const missingOptional = [...schemaKeys.keys()].filter(
      (key) => !entries.has(key) && !required.has(key) && key !== "NODE_ENV"
    );
    const extra = [...entries.keys()].filter((key) => !schemaKeys.has(key));

    rows.push({
      label,
      keys: entries.size,
      missReq: missingRequired.length,
      missOpt: missingOptional.length,
      extra: extra.length,
      dup: duplicates.length,
    });

    if (missingRequired.length > 0)
      problems.push(`${label} missing required: ${missingRequired.join(", ")}`);
    if (duplicates.length > 0)
      problems.push(`${label} duplicate: ${duplicates.join(", ")}`);

    const next = render(filename, entries, schemaKeys, schemaPath);

    // Refuse to write if the rewrite would change which keys exist. Comments and order are the only sanctioned edits, so a key-set difference means the parser mishandled something — most likely an exotic value — and writing would lose data.
    const after = parseAssignments(next);
    const lost = order.filter((key) => !after.entries.has(key));
    const gained = after.order.filter((key) => !entries.has(key));
    if (lost.length > 0 || gained.length > 0) {
      console.error(
        `${ICONS.fail} ${label}: ABORTED — key set would change (lost: ${lost.join(", ") || "none"}; gained: ${gained.join(", ") || "none"}). File left untouched.`
      );
      failed++;
      continue;
    }

    // Reported per file rather than only in a summary at the end: a parity failure returns before any summary, and "is this file formatted?" is a separate question from "does it have the right keys?".
    if (next === original) {
      console.log(`${ICONS.pass} ${label}: already formatted`);
      continue;
    }

    unformatted++;
    if (args.check) continue;

    writeFileSync(target, next);
    const notes = [];
    if (scaffolded.length > 0) notes.push(`added empty: ${scaffolded.join(", ")}`);
    if (pruned.length > 0) notes.push(`pruned empty: ${pruned.join(", ")}`);
    console.log(
      `${ICONS.pass} ${label}: formatted${notes.length > 0 ? ` — ${notes.join("; ")}` : ""}`
    );
  }

  if (rows.length > 0) {
    const width = Math.max(4, ...rows.map((r) => r.label.length));
    console.log(
      `\n  ${"file".padEnd(width)}  keys  missReq  missOpt  extra  dup`
    );
    for (const r of rows) {
      console.log(
        `  ${r.label.padEnd(width)}  ${String(r.keys).padStart(4)}  ${String(r.missReq).padStart(7)}  ${String(r.missOpt).padStart(7)}  ${String(r.extra).padStart(5)}  ${String(r.dup).padStart(3)}`
      );
    }
  }

  const gaps = findRuntimeEnvGaps(schemaSource);
  if (gaps.length > 0)
    problems.push(
      `${schemaPath}: declared but absent from runtimeEnv (invisible at runtime): ${gaps.join(", ")}`
    );

  if (problems.length > 0) {
    console.error("");
    for (const problem of problems) console.error(`  ${ICONS.fail} ${problem}`);
  }

  if (failed > 0) return 2;
  // An extra key is reported, never fatal — tooling-only variables legitimately live in an env file without being declared in the app schema.
  if (problems.length > 0) return 1;
  if (args.check && unformatted > 0) {
    console.error(
      `\n${ICONS.fail} ${unformatted} file(s) not formatted. Run \`pnpm env:format\` to fix. No values were read into this output.`
    );
    return 1;
  }
  return 0;
}

// Only run when invoked directly, so the test can import the pure functions above. `pathToFileURL` rather than a string compare: on Windows `process.argv[1]` is a drive path (`D:\...`) while `import.meta.url` is a `file:///D:/...` URL, and hand-rolling that conversion gets the drive letter and escaping wrong.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
