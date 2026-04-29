#!/usr/bin/env node
// Icon-only Button accessible-name lint.
//
// Polymorphic-donut button systems (e.g. coss-ui) collapse explicit `icon-*`
// size variants into a `:has(>svg:only-child)` auto-detection rule. The
// trade-off: the icon now provides no visible text, so the button needs an
// explicit accessible name via `aria-label`/`aria-labelledby`/`title`.
//
// This script flags icon-only Buttons missing that label so CI catches the
// regression instead of relying on dev-time review.
//
// Usage:
//   pnpm dlx github:antonchuvirau/ux-mind-helpers check-icon-button-label
//   ux-mind-helpers check-icon-button-label --src components,app
//   ux-mind-helpers check-icon-button-label --components Button,InputGroupButton
//
// See check-icon-button-label.md for full options + tradeoffs.

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  collectSourceFiles,
  DEFAULT_IGNORED_DIRS,
  toRelativePath,
} from "./lib/walk-files.mjs";

const ICONS = { fail: "X", warn: "!", pass: "v" };

const DEFAULT_CONFIG = {
  src: ["components", "app", "src"],
  extensions: [".tsx"],
  ignoredDirs: DEFAULT_IGNORED_DIRS,
  // Components covered. Defaults to coss-ui's Button family. Override via
  // --components or config to add project-specific button wrappers.
  components: ["Button", "InputGroupButton"],
  // Regex (matched against the icon child's tag name) that identifies
  // an svg/icon component. Default matches any PascalCase name ending
  // in `Icon` — the lucide-icon-suffix codemod's convention.
  iconNamePattern: "^[A-Z][A-Za-z0-9_]*Icon$",
  // Props that satisfy "accessible name". Spread props (`{...rest}`) also
  // satisfy — assumed to forward a label dynamically.
  labelProps: ["aria-label", "aria-labelledby", "title"],
};

function parseArgs(argv) {
  const args = {
    configPath: null,
    src: null,
    extensions: null,
    components: null,
    iconNamePattern: null,
    cwd: process.cwd(),
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--config" && argv[i + 1]) {
      args.configPath = argv[i + 1];
      i++;
    } else if ((a === "--src" || a === "-s") && argv[i + 1]) {
      args.src = argv[i + 1].split(",").map((p) => p.trim()).filter(Boolean);
      i++;
    } else if ((a === "--ext" || a === "-e") && argv[i + 1]) {
      args.extensions = argv[i + 1]
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => (p.startsWith(".") ? p : `.${p}`));
      i++;
    } else if (a === "--components" && argv[i + 1]) {
      args.components = argv[i + 1]
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      i++;
    } else if (a === "--icon-pattern" && argv[i + 1]) {
      args.iconNamePattern = argv[i + 1];
      i++;
    } else if (a === "--cwd" && argv[i + 1]) {
      args.cwd = path.resolve(argv[i + 1]);
      i++;
    }
  }
  return args;
}

const HELP = `check-icon-button-label - icon-only Button accessible-name lint

Usage:
  ux-mind-helpers check-icon-button-label [options]

Options:
  --src, -s <dirs>         Comma-separated source directories to scan
                           Default: components,app,src (existing only)
  --ext, -e <exts>         Comma-separated extensions (default: .tsx)
  --components <names>     Comma-separated component names to lint
                           Default: Button,InputGroupButton
  --icon-pattern <regex>   Regex matched against icon child tag name
                           Default: ^[A-Z][A-Za-z0-9_]*Icon$
  --config <path>          JSON config that overrides defaults
                           Auto-detected at <cwd>/check-icon-button-label.config.json
                           or <cwd>/scripts/check-icon-button-label.config.json
  --cwd <path>             Run as if invoked from <path> (default: process.cwd())
  --help, -h               Show this message

Exit codes:
  0  no violations
  1  one or more icon-only buttons missing aria-label / aria-labelledby / title
  2  internal error (config parse, etc.)`;

async function autoDetectConfig(cwd) {
  for (const candidate of [
    "check-icon-button-label.config.json",
    "scripts/check-icon-button-label.config.json",
  ]) {
    const fullPath = path.join(cwd, candidate);
    try {
      const raw = await readFile(fullPath, "utf8");
      return { path: fullPath, json: JSON.parse(raw) };
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
  }
  return null;
}

async function loadConfig(args) {
  if (args.configPath) {
    const fullPath = path.resolve(args.cwd, args.configPath);
    const raw = await readFile(fullPath, "utf8");
    return { path: fullPath, json: JSON.parse(raw) };
  }
  return autoDetectConfig(args.cwd);
}

function mergeConfig(defaults, overrides, args) {
  const merged = { ...defaults, ...(overrides ?? {}) };
  if (args.src) merged.src = args.src;
  if (args.extensions) merged.extensions = args.extensions;
  if (args.components) merged.components = args.components;
  if (args.iconNamePattern) merged.iconNamePattern = args.iconNamePattern;
  return merged;
}

// Strip JSX block comments and surrounding whitespace from a fragment so
// the body-shape detector ignores them.
function stripCommentsAndWhitespace(s) {
  return s.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "").trim();
}

// Find the index of the matching closing tag `</name>` starting at
// position `from`, accounting for nested `<name...>` opens. Returns -1
// if the depth never balances (malformed source).
function findMatchingClose(source, name, from) {
  const open = new RegExp(`<${name}\\b`, "g");
  const close = new RegExp(`</${name}\\s*>`, "g");
  let depth = 1;
  let i = from;
  while (i < source.length && depth > 0) {
    open.lastIndex = i;
    close.lastIndex = i;
    const o = open.exec(source);
    const c = close.exec(source);
    if (!c) return -1;
    if (o && o.index < c.index) {
      depth++;
      i = o.index + o[0].length;
    } else {
      depth--;
      if (depth === 0) return c.index;
      i = c.index + c[0].length;
    }
  }
  return -1;
}

// Return true when `props` (the raw text between `<Component` and the
// closing `>` of the opening tag) carries an accessible-name prop or
// any spread (assumed to forward a label).
function hasAccessibleName(props, labelProps) {
  if (/\{\s*\.\.\./.test(props)) return true;
  for (const prop of labelProps) {
    const re = new RegExp(`(?<![A-Za-z0-9_-])${prop}\\s*=`);
    if (re.test(props)) return true;
  }
  return false;
}

// Return the icon tag name when `body` is exactly one self-closing or
// paired icon child (matching iconNameRe), else null.
function detectIconOnlyChild(body, iconNameRe) {
  const trimmed = stripCommentsAndWhitespace(body);
  if (!trimmed) return null;

  let m = trimmed.match(/^<([A-Za-z_][A-Za-z0-9_]*)\b[^>]*\/>$/);
  if (m && iconNameRe.test(m[1])) return m[1];

  m = trimmed.match(
    /^<([A-Za-z_][A-Za-z0-9_]*)\b[^>]*>\s*<\/([A-Za-z_][A-Za-z0-9_]*)\s*>$/
  );
  if (m && m[1] === m[2] && iconNameRe.test(m[1])) return m[1];

  return null;
}

// 1-based line/column for an offset.
function offsetToLineCol(source, offset) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

export function findViolations(source, config) {
  const violations = [];
  const iconNameRe = new RegExp(config.iconNamePattern);

  for (const name of config.components) {
    // Match `<Name` followed by whitespace or `>`. Excludes `<NameFoo`
    // (e.g. ButtonGroup) and `</Name>`.
    const openRe = new RegExp(`<${name}(?=[\\s>])`, "g");
    let m;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
    while ((m = openRe.exec(source)) !== null) {
      const tagStart = m.index;

      // Walk to the end of the opening tag, tracking JSX expressions
      // `{...}` so a `>` inside an expression doesn't terminate early.
      let i = tagStart + m[0].length;
      let depth = 0;
      let selfClosing = false;
      let tagEnd = -1;
      while (i < source.length) {
        const ch = source[i];
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        else if (depth === 0) {
          if (ch === "/" && source[i + 1] === ">") {
            selfClosing = true;
            tagEnd = i + 2;
            break;
          }
          if (ch === ">") {
            tagEnd = i + 1;
            break;
          }
        }
        i++;
      }
      if (tagEnd === -1) continue;

      const props = source.slice(
        tagStart + m[0].length,
        tagEnd - (selfClosing ? 2 : 1)
      );
      const labeled = hasAccessibleName(props, config.labelProps);

      // Self-closing `<Button ... />` means children come from elsewhere
      // (typically a `render` slot). We can't see them — skip silently.
      if (selfClosing) continue;

      const closeIdx = findMatchingClose(source, name, tagEnd);
      if (closeIdx === -1) continue;

      const body = source.slice(tagEnd, closeIdx);
      const iconName = detectIconOnlyChild(body, iconNameRe);
      if (!iconName) continue;
      if (labeled) continue;

      const { line, col } = offsetToLineCol(source, tagStart);
      violations.push({ component: name, iconName, line, col });
    }
  }
  return violations;
}

export async function runIconButtonLabelCheck({ cwd, config }) {
  const findings = [];

  for (const srcDir of config.src) {
    const fullDir = path.resolve(cwd, srcDir);
    let files;
    try {
      files = await collectSourceFiles(fullDir, {
        ignoredDirs: config.ignoredDirs,
        extensions: config.extensions,
      });
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }

    for (const filePath of files) {
      const source = await readFile(filePath, "utf8");
      const violations = findViolations(source, config);
      if (violations.length === 0) continue;
      findings.push({ path: toRelativePath(cwd, filePath), violations });
    }
  }

  return findings;
}

function printFindings(findings) {
  const total = findings.reduce((n, f) => n + f.violations.length, 0);
  console.error(
    `${ICONS.fail} Icon-only button missing accessible name - ${total} site(s) across ${findings.length} file(s):\n`
  );
  for (const f of findings) {
    console.error(`  ${f.path}`);
    for (const v of f.violations) {
      console.error(
        `    ${v.line}:${v.col}  <${v.component}> with only <${v.iconName} /> - add aria-label / aria-labelledby / title`
      );
    }
  }
  console.error(
    `\nFix: <Button aria-label="Describe action"><FooIcon /></Button>\n`
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const overrides = await loadConfig(args);
  const config = mergeConfig(
    DEFAULT_CONFIG,
    overrides ? overrides.json : null,
    args
  );

  const findings = await runIconButtonLabelCheck({ cwd: args.cwd, config });

  if (findings.length > 0) {
    printFindings(findings);
    return 1;
  }

  console.log(
    `${ICONS.pass} Icon-only button labels: all ${config.components.join("/")} sites OK${
      overrides
        ? ` [config: ${path.relative(args.cwd, overrides.path)}]`
        : " [defaults]"
    }`
  );
  return 0;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`;

if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("check-icon-button-label failed:", err);
      process.exit(2);
    });
}
