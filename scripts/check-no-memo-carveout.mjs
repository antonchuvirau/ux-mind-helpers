#!/usr/bin/env node
// React Compiler interior-mutability carve-out lint.
//
// Some libraries violate React's "hooks return immutable values" rule. The
// React Compiler stale-caches their reads, producing UI that doesn't update.
// The fix is the `"use no memo"` directive on consuming code. This script
// enforces that directive on files matching configured rules.
//
// Biome/Ultracite does not ship the equivalent ESLint rule
// (`react-hooks/incompatible-library`), so this script fills the gap.
//
// Usage:
//   pnpm dlx github:antonchuvirau/ux-mind-helpers check-no-memo-carveout
//   ux-mind-helpers check-no-memo-carveout --src components,hooks,app,lib
//   ux-mind-helpers check-no-memo-carveout --config ./scripts/carveout.json
//
// See check-no-memo-carveout.md for full options + config schema.

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  collectSourceFiles,
  DEFAULT_IGNORED_DIRS,
  toRelativePath,
} from "./lib/walk-files.mjs";

const ICONS = { fail: "X", warn: "!", pass: "v" };

// Default rules. Mirrors the canonical React Compiler `incompatible-library`
// list (https://github.com/facebook/react/blob/main/compiler/packages/babel-plugin-react-compiler/src/HIR/DefaultModuleTypeProvider.ts)
// plus project-extended RHF rules from maintainer-reported issues
// (#11910, #12298, #12524) and a watch-list of state libraries commonly
// adopted later (mobx, zustand, @tanstack/react-query).
const DEFAULT_CONFIG = {
  src: ["components", "hooks", "app", "lib", "src"],
  extensions: [".ts", ".tsx"],
  ignoredDirs: DEFAULT_IGNORED_DIRS,
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
      reason:
        "useReactTable() returns an instance whose methods (getRowModel, getHeaderGroups, ...) return interior-mutated state.",
      references: [
        "https://github.com/facebook/react/pull/31820",
        "https://github.com/TanStack/table/issues/5567",
      ],
    },
    {
      name: "TanStack Virtual",
      enforced: true,
      imports: ["@tanstack/react-virtual"],
      reason:
        "useVirtualizer() shares the same interior-mutability pattern as useReactTable.",
      references: ["https://github.com/TanStack/virtual/issues/736"],
    },
    {
      name: "react-hook-form interior hooks",
      enforced: true,
      hooks: ["useFormState", "useWatch", "useFieldArray", "useController"],
      reason:
        "v7.x violates React's hook-immutability contract. These hooks subscribe to mutable refs via useRef.",
      references: [
        "https://github.com/react-hook-form/react-hook-form/issues/12298",
        "https://github.com/orgs/react-hook-form/discussions/12524",
      ],
    },
    {
      name: "react-hook-form legacy watch()",
      enforced: true,
      methods: [{ name: "watch", requiresImportFrom: "react-hook-form" }],
      reason:
        "form.watch() in render is broken under Compiler. Replace with useWatch({ control, name }).",
      references: [
        "https://github.com/react-hook-form/react-hook-form/issues/11910",
      ],
    },
    {
      name: "MobX observer",
      enforced: false,
      imports: ["mobx-react", "mobx-react-lite"],
      reason:
        "observer() HOC breaks Compiler memoization. Components wrapped with observer() need \"use no memo\".",
      references: [
        "https://react.dev/reference/eslint-plugin-react-hooks/lints/incompatible-library",
      ],
    },
    {
      name: "zustand",
      enforced: false,
      imports: ["zustand"],
      reason:
        "Selectors that return non-primitive values can stale-cache under Compiler. Audit selector return shapes.",
      references: [],
    },
    {
      name: "TanStack Query",
      enforced: false,
      imports: ["@tanstack/react-query"],
      reason:
        "Generally Compiler-safe. Audit useQueries/useInfiniteQuery on adoption — their return shapes are more complex.",
      references: [],
    },
  ],
};

function parseArgs(argv) {
  const args = {
    configPath: null,
    src: null,
    extensions: null,
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
    } else if (a === "--cwd" && argv[i + 1]) {
      args.cwd = path.resolve(argv[i + 1]);
      i++;
    }
  }
  return args;
}

const HELP = `check-no-memo-carveout — React Compiler interior-mutability lint guard

Usage:
  ux-mind-helpers check-no-memo-carveout [options]

Options:
  --src, -s <dirs>     Comma-separated source directories to scan
                       Default: components,hooks,app,lib,src (existing only)
  --ext, -e <exts>     Comma-separated extensions (default: .ts,.tsx)
  --config <path>      Path to a JSON config that overrides defaults
                       Auto-detected at <cwd>/check-no-memo-carveout.config.json
                       or <cwd>/scripts/check-no-memo-carveout.config.json
  --cwd <path>         Run as if invoked from <path> (default: process.cwd())
  --help, -h           Show this message

Exit codes:
  0  no enforced violations (advisories may have been logged)
  1  one or more enforced rules fired
  2  internal error (config parse, etc.)`;

async function autoDetectConfig(cwd) {
  for (const candidate of [
    "check-no-memo-carveout.config.json",
    "scripts/check-no-memo-carveout.config.json",
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
  return merged;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

function hasValueImport(source, pkg) {
  const re = new RegExp(
    `^\\s*import\\s+(?!type\\s)[^;]*from\\s+["']${escapeRegex(pkg)}["']`,
    "m"
  );
  return re.test(source);
}

function callsHook(source, hookName) {
  return new RegExp(`\\b${escapeRegex(hookName)}\\s*\\(`).test(source);
}

function callsMethod(source, methodName) {
  // Match `.watch(` (method call) and `watch(` (destructured function call)
  // but not `useWatch(` or `someWatch(` or string-literal "watch(".
  // Lookbehind excludes identifier chars and `use` prefix; period is allowed.
  const escaped = escapeRegex(methodName);
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}\\s*\\(`).test(source);
}

export function ruleMatches(rule, source) {
  const reasons = [];

  for (const pkg of rule.imports ?? []) {
    if (hasValueImport(source, pkg)) reasons.push(`imports ${pkg}`);
  }
  for (const hook of rule.hooks ?? []) {
    if (callsHook(source, hook)) reasons.push(`calls ${hook}()`);
  }
  for (const method of rule.methods ?? []) {
    if (
      hasValueImport(source, method.requiresImportFrom) &&
      callsMethod(source, method.name)
    ) {
      reasons.push(
        `calls .${method.name}() with import from ${method.requiresImportFrom}`
      );
    }
  }
  return reasons;
}

export function hasAnyDirective(source, directives) {
  return directives.some((d) => source.includes(d));
}

export async function runCarveoutCheck({ cwd, config }) {
  const enforced = [];
  const advisories = [];

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
      if (hasAnyDirective(source, config.directives)) continue;

      for (const rule of config.rules) {
        const matches = ruleMatches(rule, source);
        if (matches.length === 0) continue;

        const entry = {
          path: toRelativePath(cwd, filePath),
          ruleName: rule.name,
          reasons: matches,
          reason: rule.reason,
          references: rule.references ?? [],
        };
        (rule.enforced ? enforced : advisories).push(entry);
      }
    }
  }

  return { enforced, advisories };
}

function printAdvisories(advisories) {
  if (advisories.length === 0) return;
  console.warn(
    `\n${ICONS.warn} React Compiler carve-out advisory — ${advisories.length} watch-list match(es). Review on adoption:\n`
  );
  for (const a of advisories) {
    console.warn(`  ${a.path}`);
    console.warn(`    rule: ${a.ruleName}`);
    for (const r of a.reasons) console.warn(`      - ${r}`);
    console.warn(`    note: ${a.reason}`);
  }
  console.warn("");
}

function printEnforced(enforced) {
  console.error(
    `${ICONS.fail} React Compiler carve-out violation — ${enforced.length} file(s) need the "use no memo" directive:\n`
  );
  for (const o of enforced) {
    console.error(`  ${o.path}`);
    console.error(`    rule: ${o.ruleName}`);
    for (const r of o.reasons) console.error(`      - ${r}`);
    console.error(`    why: ${o.reason}`);
    for (const ref of o.references) console.error(`      ${ref}`);
  }
  console.error(
    `\nFix: add "use no memo"; at file top (after "use client") OR as the first statement of the offending function body.\n`
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

  const { enforced, advisories } = await runCarveoutCheck({
    cwd: args.cwd,
    config,
  });

  printAdvisories(advisories);

  if (enforced.length > 0) {
    printEnforced(enforced);
    return 1;
  }

  console.log(
    `${ICONS.pass} React Compiler carve-out: all enforced rules pass${
      advisories.length > 0 ? " (advisories noted above)" : ""
    }${overrides ? ` [config: ${path.relative(args.cwd, overrides.path)}]` : " [defaults]"}`
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
      console.error("check-no-memo-carveout failed:", err);
      process.exit(2);
    });
}
