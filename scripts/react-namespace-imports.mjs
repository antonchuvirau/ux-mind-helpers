#!/usr/bin/env node
// Convert `import * as React` to named imports. Aliases DOM event types used
// generically (ReactMouseEvent<T>) to avoid shadowing globals needed by
// document.addEventListener. Rewrites bare DOM event params on JSX handlers.

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { confirm, isInteractive } from "./lib/prompt.mjs";
import { collectSourceFiles, toRelativePath } from "./lib/walk-files.mjs";

const REACT_IMPORT_PATTERN = /import\s+([^;]+?)\s+from\s+["']react["'];?/g;

// These exist as global DOM types. Importing them from React under the same
// name shadows the globals and breaks document.addEventListener handlers.
// When used with generic params (ReactMouseEvent<T>), they must stay as React types
// via a prefixed alias (ReactMouseEvent). When used without generic params,
// the global DOM type is used instead (no import needed).
//
// Pass 4 additionally rewrites *bare* DOM event param annotations
// (e.g. `(event: MouseEvent) =>`) into `ReactX<HTMLElement>` when the handler
// is bound to a JSX `on*` prop in the same file. Guarded against DOM callback
// usages (addEventListener / element.on*) so genuinely-DOM handlers stay bare.
const DOM_EVENT_TYPES = new Set([
  "AnimationEvent",
  "ClipboardEvent",
  "CompositionEvent",
  "DragEvent",
  "FocusEvent",
  "InputEvent",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "TouchEvent",
  "TransitionEvent",
  "UIEvent",
  "WheelEvent",
]);

function reactAlias(name) {
  return `React${name}`;
}

function parseNamedImports(block) {
  const names = [];
  const inner = block.trim().replace(/^\{/, "").replace(/\}$/, "");
  for (const name of inner.split(",")) {
    const trimmed = name.trim();
    if (trimmed) names.push(trimmed);
  }
  return names;
}

function parseImportSpecifiers(rawSpecifiers) {
  let specifiers = rawSpecifiers.trim();
  let isTypeOnly = false;
  if (specifiers.startsWith("type ")) {
    isTypeOnly = true;
    specifiers = specifiers.slice(5).trim();
  }

  let defaultImport = null;
  let namespaceImport = null;
  const namedImports = [];

  if (specifiers.startsWith("* as ")) {
    namespaceImport = specifiers.slice(5).trim();
    return { defaultImport, namespaceImport, namedImports, isTypeOnly };
  }

  if (specifiers.startsWith("{")) {
    namedImports.push(...parseNamedImports(specifiers));
    return { defaultImport, namespaceImport, namedImports, isTypeOnly };
  }

  const commaIndex = specifiers.indexOf(",");
  if (commaIndex === -1) {
    defaultImport = specifiers;
    return { defaultImport, namespaceImport, namedImports, isTypeOnly };
  }

  defaultImport = specifiers.slice(0, commaIndex).trim() || null;
  const rest = specifiers.slice(commaIndex + 1).trim();

  if (rest.startsWith("* as ")) {
    namespaceImport = rest.slice(5).trim();
  } else if (rest.startsWith("{")) {
    namedImports.push(...parseNamedImports(rest));
  }

  return { defaultImport, namespaceImport, namedImports, isTypeOnly };
}

function buildReactImport({ defaultImport, namedImports, isTypeOnly }) {
  const keyword = isTypeOnly ? "import type" : "import";
  const normalized = [...namedImports]
    .map((v) => {
      let trimmed = v.trim();
      // Inner "type" modifier is redundant (and invalid) inside `import type {}`.
      if (isTypeOnly) trimmed = trimmed.replace(/^type\s+/, "");
      return trimmed;
    })
    .filter(Boolean);

  if (defaultImport && normalized.length > 0) {
    return `${keyword} ${defaultImport}, { ${normalized.join(", ")} } from "react";`;
  }

  if (defaultImport) {
    return `${keyword} ${defaultImport} from "react";`;
  }

  if (normalized.length > 0) {
    return `${keyword} { ${normalized.join(", ")} } from "react";`;
  }

  return "";
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findGenericDomTypes(source, domTypeNames) {
  const generic = new Set();
  for (const name of domTypeNames) {
    if (new RegExp(`\\b${escapeRegExp(name)}<`).test(source)) {
      generic.add(name);
    }
  }
  return generic;
}

export function transformSource(sourceCode) {
  const reactImportMatches = [...sourceCode.matchAll(REACT_IMPORT_PATTERN)];
  if (reactImportMatches.length === 0) {
    return null;
  }

  let updatedCode = sourceCode;
  let changed = false;
  const changedMembers = new Set();

  // Pass 1: convert namespace imports (import * as React) to named imports.
  for (const match of reactImportMatches) {
    const wholeImport = match[0];
    const rawSpecifiers = match[1];
    const parsed = parseImportSpecifiers(rawSpecifiers);

    if (!parsed.namespaceImport) continue;

    const namespace = parsed.namespaceImport;

    const namespaceDomUsages = new Set();
    for (const domType of DOM_EVENT_TYPES) {
      if (
        new RegExp(
          `\\b${escapeRegExp(namespace)}\\.${escapeRegExp(domType)}\\b`
        ).test(updatedCode)
      ) {
        namespaceDomUsages.add(domType);
      }
    }
    const genericDomTypes = findGenericDomTypes(
      updatedCode,
      namespaceDomUsages
    );

    const memberRegex = new RegExp(
      `\\b${escapeRegExp(namespace)}\\.([A-Za-z_$][\\w$]*)\\b`,
      "g"
    );
    const regularMembers = [];
    const aliasedDomTypes = new Set();

    updatedCode = updatedCode.replace(memberRegex, (_, memberName) => {
      changedMembers.add(memberName);

      if (DOM_EVENT_TYPES.has(memberName)) {
        if (genericDomTypes.has(memberName)) {
          aliasedDomTypes.add(memberName);
          return reactAlias(memberName);
        }
        return memberName;
      }

      regularMembers.push(memberName);
      return memberName;
    });

    const aliasImports = [...aliasedDomTypes].map(
      (n) => `type ${n} as ${reactAlias(n)}`
    );
    const mergedNamedImports = uniqueSorted([
      ...parsed.namedImports.filter((m) => !DOM_EVENT_TYPES.has(m)),
      ...regularMembers,
      ...aliasImports,
    ]);

    const replacementImport = buildReactImport({
      defaultImport: parsed.defaultImport,
      namedImports: mergedNamedImports,
      isTypeOnly: parsed.isTypeOnly,
    });

    const nextCode = replacementImport
      ? updatedCode.replace(wholeImport, replacementImport)
      : updatedCode.replace(`${wholeImport}\n`, "");

    if (nextCode !== updatedCode) {
      changed = true;
      updatedCode = nextCode;
      continue;
    }

    if (replacementImport && replacementImport !== wholeImport) {
      changed = true;
    }

    updatedCode = nextCode;
  }

  // Pass 2: fix already-converted files with bare DOM event types imported from React.
  for (const match of [...updatedCode.matchAll(REACT_IMPORT_PATTERN)]) {
    const wholeImport = match[0];
    const rawSpecifiers = match[1];
    const parsed = parseImportSpecifiers(rawSpecifiers);

    if (parsed.namespaceImport) continue;

    const domTypesInImport = parsed.namedImports.filter((m) =>
      DOM_EVENT_TYPES.has(m)
    );
    if (domTypesInImport.length === 0) continue;

    const genericDomTypes = findGenericDomTypes(updatedCode, domTypesInImport);
    const aliasImports = [];

    for (const domType of domTypesInImport) {
      if (genericDomTypes.has(domType)) {
        const alias = reactAlias(domType);
        updatedCode = updatedCode.replace(
          new RegExp(`(?<![\\w.])${escapeRegExp(domType)}<`, "g"),
          `${alias}<`
        );
        aliasImports.push(`type ${domType} as ${alias}`);
      }
    }

    const cleanedNamedImports = [
      ...parsed.namedImports.filter((m) => !DOM_EVENT_TYPES.has(m)),
      ...aliasImports,
    ];
    const replacementImport = buildReactImport({
      defaultImport: parsed.defaultImport,
      namedImports: cleanedNamedImports,
      isTypeOnly: parsed.isTypeOnly,
    });

    const nextCode = replacementImport
      ? updatedCode.replace(wholeImport, replacementImport)
      : updatedCode.replace(`${wholeImport}\n`, "");

    if (nextCode !== updatedCode) {
      changed = true;
      updatedCode = nextCode;
    }
  }

  // Pass 3: DOM event types used generically in code but not yet imported.
  for (const match of [...updatedCode.matchAll(REACT_IMPORT_PATTERN)]) {
    const wholeImport = match[0];
    const rawSpecifiers = match[1];
    const parsed = parseImportSpecifiers(rawSpecifiers);

    if (parsed.namespaceImport) continue;

    const newAliasImports = [];

    for (const domType of DOM_EVENT_TYPES) {
      const alias = reactAlias(domType);
      const alreadyPresent = parsed.namedImports.some(
        (m) => m === domType || m.includes(`as ${alias}`)
      );
      if (alreadyPresent) continue;

      if (!new RegExp(`(?<![\\w.])${escapeRegExp(domType)}<`).test(updatedCode))
        continue;

      updatedCode = updatedCode.replace(
        new RegExp(`(?<![\\w.])${escapeRegExp(domType)}<`, "g"),
        `${alias}<`
      );
      newAliasImports.push(`type ${domType} as ${alias}`);
    }

    if (newAliasImports.length === 0) continue;

    const mergedNamedImports = uniqueSorted([
      ...parsed.namedImports,
      ...newAliasImports,
    ]);
    const replacementImport = buildReactImport({
      defaultImport: parsed.defaultImport,
      namedImports: mergedNamedImports,
      isTypeOnly: parsed.isTypeOnly,
    });

    if (!replacementImport) continue;

    const nextCode = updatedCode.replace(wholeImport, replacementImport);
    if (nextCode !== updatedCode) {
      changed = true;
      updatedCode = nextCode;
      break;
    }
  }

  // Pass 4: bare DOM event params on handlers consumed by JSX `on*` props.
  {
    const neededAliases = new Set();
    const edits = [];

    for (const domType of DOM_EVENT_TYPES) {
      const alias = reactAlias(domType);

      const namedRegex = new RegExp(
        `\\((\\s*\\w+\\??\\s*):\\s*${escapeRegExp(domType)}\\s*\\)\\s*=>`,
        "g"
      );
      for (const m of updatedCode.matchAll(namedRegex)) {
        const matchStart = m.index;
        const handlerName = findHandlerName(updatedCode, matchStart);
        const inlineJsx = isInlineJsxArrow(updatedCode, matchStart);

        if (
          !(
            inlineJsx ||
            (handlerName && isJsxPropBound(updatedCode, handlerName))
          )
        ) {
          continue;
        }

        if (isPrecededByAddEventListener(updatedCode, matchStart)) continue;
        if (handlerName && isDomListenerBound(updatedCode, handlerName))
          continue;
        if (handlerName && isDomOnPropAssigned(updatedCode, handlerName))
          continue;

        const innerRegex = new RegExp(`:\\s*${escapeRegExp(domType)}\\s*\\)`);
        const inner = innerRegex.exec(m[0]);
        if (!inner) continue;

        const sliceStart = matchStart + inner.index;
        const sliceEnd = sliceStart + inner[0].length;
        const replacement = inner[0].replace(
          new RegExp(`:\\s*${escapeRegExp(domType)}(\\s*)\\)`),
          `: ${alias}<HTMLElement>$1)`
        );

        edits.push({ start: sliceStart, end: sliceEnd, replacement });
        neededAliases.add(domType);
      }
    }

    if (edits.length > 0) {
      edits.sort((a, b) => b.start - a.start);
      let nextCode = updatedCode;
      for (const edit of edits) {
        nextCode =
          nextCode.slice(0, edit.start) +
          edit.replacement +
          nextCode.slice(edit.end);
      }

      const reactImports = [...nextCode.matchAll(REACT_IMPORT_PATTERN)];
      if (reactImports.length > 0) {
        const match = reactImports[0];
        const wholeImport = match[0];
        const parsed = parseImportSpecifiers(match[1]);

        const aliasImports = [];
        for (const domType of neededAliases) {
          const alias = reactAlias(domType);
          const alreadyPresent = parsed.namedImports.some(
            (m) => m === domType || m.includes(`as ${alias}`)
          );
          if (!alreadyPresent) {
            aliasImports.push(`type ${domType} as ${alias}`);
          }
        }

        const mergedNamedImports = uniqueSorted([
          ...parsed.namedImports,
          ...aliasImports,
        ]);
        const replacementImport = buildReactImport({
          defaultImport: parsed.defaultImport,
          namedImports: mergedNamedImports,
          isTypeOnly: parsed.isTypeOnly,
        });

        if (replacementImport && replacementImport !== wholeImport) {
          nextCode = nextCode.replace(wholeImport, replacementImport);
        }

        for (const domType of neededAliases) {
          changedMembers.add(domType);
        }

        updatedCode = nextCode;
        changed = true;
      }
    }
  }

  if (!changed) {
    return null;
  }

  return {
    code: updatedCode,
    members: uniqueSorted([...changedMembers]),
  };
}

function findHandlerName(source, matchStart) {
  const windowStart = Math.max(0, matchStart - 300);
  const window = source.slice(windowStart, matchStart);

  const assignRegex =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?\s*=\s*(?:useCallback\s*\(\s*)?$/;
  const assignMatch = assignRegex.exec(window);
  if (assignMatch) return assignMatch[1];

  const fnRegex = /\bfunction\s+([A-Za-z_$][\w$]*)\s*$/;
  const fnMatch = fnRegex.exec(window);
  if (fnMatch) return fnMatch[1];

  return null;
}

function isInlineJsxArrow(source, matchStart) {
  const windowStart = Math.max(0, matchStart - 80);
  const window = source.slice(windowStart, matchStart);
  return /on[A-Z]\w*\s*=\s*\{\s*$/.test(window);
}

function isPrecededByAddEventListener(source, matchStart) {
  const windowStart = Math.max(0, matchStart - 240);
  const window = source.slice(windowStart, matchStart);
  return /(?:add|remove)EventListener\s*\(\s*["'][^"']+["']\s*,\s*$/s.test(
    window
  );
}

function isDomListenerBound(source, name) {
  return new RegExp(
    `(?:add|remove)EventListener\\s*\\(\\s*["'][^"']+["']\\s*,\\s*${escapeRegExp(name)}\\b`,
    "s"
  ).test(source);
}

function isJsxPropBound(source, name) {
  return new RegExp(`on[A-Z]\\w*\\s*=\\s*\\{\\s*${escapeRegExp(name)}\\b`).test(
    source
  );
}

function isDomOnPropAssigned(source, name) {
  return new RegExp(`\\.\\s*on[a-z]+\\s*=\\s*${escapeRegExp(name)}\\b`).test(
    source
  );
}

// ---------- CLI ----------

const HELP = `react-namespace-imports - convert 'import * as React' to named imports

Usage: react-namespace-imports [options]

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
  for (const filePath of files) {
    const originalCode = await readFile(filePath, "utf8");
    const result = transformSource(originalCode);
    if (!result) continue;
    if (result.code === originalCode) continue;
    pending.push({ filePath, code: result.code, members: result.members });
  }

  if (pending.length === 0) {
    console.log("No matches found (react-namespace-imports).");
    return;
  }

  console.log(`Would update ${pending.length} file(s):`);
  for (const entry of pending) {
    const rel = toRelativePath(rootDir, entry.filePath);
    const members =
      entry.members.length > 0 ? ` -> [${entry.members.join(", ")}]` : "";
    console.log(`- ${rel}${members}`);
  }

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
