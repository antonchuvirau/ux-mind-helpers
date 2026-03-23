#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    src: { type: "string", short: "s", default: "src" },
    alias: { type: "string", short: "a", default: "~/" },
    ext: { type: "string", short: "e", default: ".ts,.tsx" },
    skip: { type: "string", default: "node_modules,.next,.git,dist,public" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(`fix-relative-ts-imports — replace ../ imports with path alias

Usage: fix-relative-ts-imports [options]

Options:
  -s, --src <dir>     Source directory to scan (default: "src")
  -a, --alias <str>   Alias prefix to use (default: "~/")
  -e, --ext <list>    Comma-separated extensions (default: ".ts,.tsx")
      --skip <list>   Comma-separated dirs to skip (default: "node_modules,.next,.git,dist,public")
      --dry-run       Preview changes without writing
  -h, --help          Show this help`);
  process.exit(0);
}

const srcDir = resolve(values.src);
const alias = values.alias.endsWith("/") ? values.alias : `${values.alias}/`;
const extensions = new Set(values.ext.split(",").map((e) => e.trim()));
const skipDirs = new Set(values.skip.split(",").map((s) => s.trim()));
const dryRun = values["dry-run"];

/** Matches `from "../..."` (1+ levels up). Ignores `from "./"` (same-dir). */
const RELATIVE_UP_RE = /from "(\.\.\/[^"]+)"/g;

function walk(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) results.push(...walk(join(dir, entry.name)));
    } else if (extensions.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
      results.push(join(dir, entry.name));
    }
  }
  return results;
}

let fixed = 0;
const files = walk(srcDir);

const srcDirPosix = srcDir.replaceAll("\\", "/");

for (const file of files) {
  const content = readFileSync(file, "utf8");
  const fileDirPosix = dirname(file).replaceAll("\\", "/");

  const updated = content.replace(RELATIVE_UP_RE, (_match, relPath) => {
    const abs = posix.normalize(posix.join(fileDirPosix, relPath));
    const rel = abs.startsWith(srcDirPosix)
      ? abs.slice(srcDirPosix.length + 1)
      : relative(srcDir, abs).replaceAll("\\", "/");
    return `from "${alias}${rel}"`;
  });

  if (updated !== content) {
    if (dryRun) {
      console.log(`  would fix: ${relative(process.cwd(), file).replaceAll("\\", "/")}`);
    } else {
      writeFileSync(file, updated);
    }
    fixed++;
  }
}

if (fixed > 0) {
  console.log(`\n${dryRun ? "[dry-run] " : ""}fixed ${fixed} file(s)`);
} else {
  console.log("no relative imports to fix");
}
