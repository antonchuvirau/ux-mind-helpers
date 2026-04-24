#!/usr/bin/env node
// Rename lucide-react imports to the Icon-suffixed form (Check -> CheckIcon).

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { confirm, isInteractive } from "./lib/prompt.mjs";
import { collectSourceFiles, toRelativePath } from "./lib/walk-files.mjs";

const LUCIDE_IMPORT_PATTERN =
  /import\s+([^;]+?)\s+from\s+["']lucide-react["'];?/g;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function parseNamedImports(block) {
  const inner = block.trim().replace(/^\{/, "").replace(/\}$/, "");
  const names = [];
  for (const name of inner.split(",")) {
    const trimmed = name.trim();
    if (trimmed) names.push(trimmed);
  }
  return names;
}

function parseSpecifier(raw) {
  let rest = raw.trim();
  let isTypeOnly = false;
  if (rest.startsWith("type ")) {
    isTypeOnly = true;
    rest = rest.slice(5).trim();
  }
  const asMatch = rest.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
  if (asMatch) {
    return {
      source: asMatch[1],
      local: asMatch[2],
      aliased: true,
      isTypeOnly,
    };
  }
  return { source: rest, local: rest, aliased: false, isTypeOnly };
}

function formatSpecifier(spec) {
  const prefix = spec.isTypeOnly ? "type " : "";
  if (spec.aliased) return `${prefix}${spec.source} as ${spec.local}`;
  return `${prefix}${spec.source}`;
}

function parseImportSpecifiers(rawSpecifiers) {
  let specifiers = rawSpecifiers.trim();
  let isTypeOnly = false;
  if (specifiers.startsWith("type ")) {
    isTypeOnly = true;
    specifiers = specifiers.slice(5).trim();
  }
  if (!specifiers.startsWith("{")) {
    return { isTypeOnly, namedImports: [] };
  }
  return { isTypeOnly, namedImports: parseNamedImports(specifiers) };
}

function buildLucideImport({ isTypeOnly, specifiers }) {
  if (specifiers.length === 0) return "";
  const keyword = isTypeOnly ? "import type" : "import";
  const formatted = specifiers.map(formatSpecifier);
  return `${keyword} { ${formatted.join(", ")} } from "lucide-react";`;
}

function maskStringsAndComments(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out.push("\0".repeat(stop - i));
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out.push("\0".repeat(stop - i));
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
      out.push("\0".repeat(j - i));
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
      out.push("\0".repeat(j - i));
      i = j;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

function hasShadowingBinding(masked, name) {
  const escaped = escapeRegExp(name);
  const patterns = [
    new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\b`),
    new RegExp(`\\bfunction\\s+${escaped}\\b`),
    new RegExp(`\\bclass\\s+${escaped}\\b`),
    new RegExp(
      `import\\s+[^;]*\\b${escaped}\\b[^;]*from\\s+["'](?!lucide-react["'])[^"']+["']`
    ),
  ];
  return patterns.some((re) => re.test(masked));
}

function rewriteIdentifier(src, masked, oldName, newName) {
  const re = new RegExp(`(?<![\\w.$])${escapeRegExp(oldName)}(?![\\w$])`, "g");
  let out = "";
  let lastIndex = 0;
  for (const match of masked.matchAll(re)) {
    out += src.slice(lastIndex, match.index) + newName;
    lastIndex = match.index + oldName.length;
  }
  out += src.slice(lastIndex);
  return out;
}

function needsSuffix(name) {
  return !name.endsWith("Icon");
}

export function transformSource(sourceCode) {
  const imports = [...sourceCode.matchAll(LUCIDE_IMPORT_PATTERN)];
  if (imports.length === 0) return null;

  let updated = sourceCode;
  let masked = maskStringsAndComments(sourceCode);
  let changed = false;
  const renamedMembers = new Set();
  const warnings = [];

  for (const match of imports) {
    const whole = match[0];
    const parsed = parseImportSpecifiers(match[1]);
    if (parsed.namedImports.length === 0) continue;

    const specs = parsed.namedImports.map(parseSpecifier);
    const localUsageRewrites = [];
    const existingSources = new Set(specs.map((s) => s.source));

    const nextSpecs = [];
    const droppedSpecs = new Set();
    let specsChanged = false;

    for (const spec of specs) {
      if (parsed.isTypeOnly || spec.isTypeOnly) {
        nextSpecs.push(spec);
        continue;
      }
      if (!needsSuffix(spec.source)) {
        nextSpecs.push(spec);
        continue;
      }
      const newSource = `${spec.source}Icon`;

      if (spec.aliased) {
        nextSpecs.push({ ...spec, source: newSource });
        renamedMembers.add(spec.source);
        specsChanged = true;
        continue;
      }

      if (existingSources.has(newSource)) {
        droppedSpecs.add(spec.source);
      } else {
        nextSpecs.push({ ...spec, source: newSource, local: newSource });
      }

      if (hasShadowingBinding(masked, spec.source)) {
        warnings.push(
          `shadowing: "${spec.source}" has a conflicting local binding; skipped`
        );
        if (droppedSpecs.has(spec.source)) {
          droppedSpecs.delete(spec.source);
        } else {
          nextSpecs.pop();
          nextSpecs.push(spec);
        }
        continue;
      }

      localUsageRewrites.push({ from: spec.source, to: newSource });
      renamedMembers.add(spec.source);
      specsChanged = true;
    }

    if (!specsChanged) continue;

    const seen = new Set();
    const dedupedSpecs = [];
    for (const spec of nextSpecs) {
      const key = formatSpecifier(spec);
      if (seen.has(key)) continue;
      seen.add(key);
      dedupedSpecs.push(spec);
    }

    const replacement = buildLucideImport({
      isTypeOnly: parsed.isTypeOnly,
      specifiers: dedupedSpecs,
    });

    if (replacement && replacement !== whole) {
      updated = updated.replace(whole, replacement);
      masked = maskStringsAndComments(updated);
      changed = true;
    }

    for (const { from, to } of localUsageRewrites) {
      const before = updated;
      updated = rewriteIdentifier(updated, masked, from, to);
      if (updated !== before) {
        masked = maskStringsAndComments(updated);
        changed = true;
      }
    }
  }

  if (!changed && warnings.length === 0) return null;

  return {
    code: updated,
    members: uniqueSorted([...renamedMembers]),
    warnings,
  };
}

// ---------- CLI ----------

const HELP = `lucide-icon-suffix - append 'Icon' suffix to lucide-react imports

Usage: lucide-icon-suffix [options]

Scans files, prints the list of changes, and prompts to apply.

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
  const ignoredDirs = values.skip
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const files = await collectSourceFiles(rootDir, { extensions, ignoredDirs });

  const pending = [];
  const warned = [];
  for (const filePath of files) {
    const originalCode = await readFile(filePath, "utf8");
    const result = transformSource(originalCode);
    if (!result) continue;
    const changed = result.code !== originalCode;
    if (changed) {
      pending.push({ filePath, code: result.code, members: result.members });
    }
    if (result.warnings && result.warnings.length > 0) {
      warned.push({ filePath, warnings: result.warnings });
    }
  }

  if (pending.length === 0 && warned.length === 0) {
    console.log("No matches found (lucide-icon-suffix).");
    return;
  }

  if (pending.length > 0) {
    console.log(`Would update ${pending.length} file(s):`);
    for (const entry of pending) {
      const rel = toRelativePath(rootDir, entry.filePath);
      const members =
        entry.members.length > 0 ? ` -> [${entry.members.join(", ")}]` : "";
      console.log(`- ${rel}${members}`);
    }
  }

  if (warned.length > 0) {
    console.log(`\nWarnings in ${warned.length} file(s):`);
    for (const entry of warned) {
      const rel = toRelativePath(rootDir, entry.filePath);
      for (const warning of entry.warnings) {
        console.log(`- ${rel}: ${warning}`);
      }
    }
  }

  if (pending.length === 0) return;

  if (values["dry-run"]) {
    console.log("\n--dry-run: no changes written.");
    process.exitCode = 1;
    return;
  }

  let apply = values.yes;
  if (!apply) {
    if (!isInteractive()) {
      console.error(
        "\nNon-interactive shell; pass --yes to apply or --dry-run to silence."
      );
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
