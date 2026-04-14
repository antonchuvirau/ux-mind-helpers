#!/usr/bin/env node
// Tailwind v4 arbitrary-value migration
// Programmatically converts arbitrary values to predefined Tailwind classes.
// Parses @theme block from CSS for project-specific radius/leading tokens.
// Optional JSON config for color mappings.
//
// Usage (run from target project root):
//   node path/to/migrate-tailwind-arbitraries.mjs              # apply changes
//   node path/to/migrate-tailwind-arbitraries.mjs --dry-run    # preview only
//   node path/to/migrate-tailwind-arbitraries.mjs --verbose    # show each replacement
//   node path/to/migrate-tailwind-arbitraries.mjs --dry-run --verbose
//
// Config flags:
//   --css <path>       CSS theme file (default: styles/globals.css)
//   --mappings <path>  Static mappings JSON (default: migrate-tailwind-mappings.json in cwd)
//   --dirs <d1,d2>     Directories to scan (default: app,components)

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    css: { type: "string", default: "styles/globals.css" },
    mappings: { type: "string", default: "migrate-tailwind-mappings.json" },
    dirs: { type: "string", default: "app,components" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(`migrate-tailwind-arbitraries — replace arbitrary Tailwind values with predefined classes

Usage: node migrate-tailwind-arbitraries.mjs [options]

Options:
      --dry-run          Preview changes without writing
      --verbose          Show each replacement
      --css <path>       CSS theme file (default: styles/globals.css)
      --mappings <path>  Static mappings JSON (default: migrate-tailwind-mappings.json)
      --dirs <d1,d2>     Directories to scan (default: app,components)
  -h, --help             Show this help`);
  process.exit(0);
}

const ROOT = resolve(".");
const DRY_RUN = values["dry-run"];
const VERBOSE = values.verbose;

// ---------------------------------------------------------------------------
// Config: paths to scan, CSS theme file, optional mappings
// ---------------------------------------------------------------------------

const SCAN_DIRS = values.dirs.split(",").map((d) => d.trim());
const CSS_THEME_FILE = values.css;
const MAPPINGS_FILE = values.mappings;

// ---------------------------------------------------------------------------
// Top-level regex constants (biome: useTopLevelRegex)
// ---------------------------------------------------------------------------

const THEME_BLOCK_RE = /@theme\s+inline\s*\{([\s\S]*?)\n\}/;
const RADIUS_DECL_RE = /--radius-(\w[\w-]*):\s*([^;]+);/g;
const PX_VALUE_RE = /^(\d+(?:\.\d+)?)px$/;
const REM_VALUE_RE = /^(\d+(?:\.\d+)?)rem$/;
const BASE_RADIUS_RE = /--radius:\s*(\d+(?:\.\d+)?)(px|rem)/;
const CALC_RADIUS_RE = /calc\(var\(--radius\)\s*([+-])\s*(\d+(?:\.\d+)?)px\)/;
const LEADING_DECL_RE = /--leading-(\w[\w-]*):\s*([^;]+);/g;
const PARSE_VALUE_RE = /^(-?\d+\.?\d*)(px|rem|em|ms|s|%)?$/;

// ---------------------------------------------------------------------------
// Parse @theme block from CSS for project-specific tokens
// ---------------------------------------------------------------------------

/**
 * Parse CSS @theme block for custom radius and leading values.
 * @returns {{ radius: Map<number, string>, leading: Map<number, string> }}
 */
function parseThemeTokens(cssPath) {
  const radius = new Map();
  const leading = new Map();

  if (!existsSync(cssPath)) {
    console.warn(`⚠ CSS theme file not found: ${cssPath}`);
    return { radius, leading };
  }

  const css = readFileSync(cssPath, "utf8");

  // Extract @theme inline { ... } block
  const themeMatch = css.match(THEME_BLOCK_RE);
  if (!themeMatch) {
    return { radius, leading };
  }
  const themeBlock = themeMatch[1];

  // Parse --radius-* declarations
  // Handles: direct px values, var() references, calc() expressions
  for (const m of themeBlock.matchAll(RADIUS_DECL_RE)) {
    const name = m[1]; // e.g. "xs", "2xl"
    const value = m[2].trim();

    // Direct px value
    const pxMatch = value.match(PX_VALUE_RE);
    if (pxMatch) {
      radius.set(Number.parseFloat(pxMatch[1]), name);
      continue;
    }

    // rem value
    const remMatch = value.match(REM_VALUE_RE);
    if (remMatch) {
      radius.set(Number.parseFloat(remMatch[1]) * 16, name);
      continue;
    }

    // var(--radius) reference → need base radius value
    if (value === "var(--radius)") {
      const baseMatch = themeBlock.match(BASE_RADIUS_RE);
      if (baseMatch) {
        const base =
          baseMatch[2] === "rem"
            ? Number.parseFloat(baseMatch[1]) * 16
            : Number.parseFloat(baseMatch[1]);
        radius.set(base, name);
      }
      continue;
    }

    // calc(var(--radius) + Npx) or calc(var(--radius) - Npx)
    const calcMatch = value.match(CALC_RADIUS_RE);
    if (calcMatch) {
      const baseMatch = themeBlock.match(BASE_RADIUS_RE);
      if (baseMatch) {
        const base =
          baseMatch[2] === "rem"
            ? Number.parseFloat(baseMatch[1]) * 16
            : Number.parseFloat(baseMatch[1]);
        const offset = Number.parseFloat(calcMatch[2]);
        const result = calcMatch[1] === "+" ? base + offset : base - offset;
        radius.set(result, name);
      }
    }
  }

  // Always add "full" for 9999px / 100%
  radius.set(9999, "full");

  // Parse --leading-* declarations
  for (const m of themeBlock.matchAll(LEADING_DECL_RE)) {
    const name = m[1]; // e.g. "110", "120"
    const value = Number.parseFloat(m[2].trim());
    if (!Number.isNaN(value)) {
      leading.set(value, name);
    }
  }

  return { radius, leading };
}

// ---------------------------------------------------------------------------
// Load optional static mappings from JSON
// ---------------------------------------------------------------------------

/** @type {[string, string][]} */
function loadStaticMappings(path) {
  if (!existsSync(path)) {
    return [];
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(data)) {
      console.warn("⚠ Mappings file must be a JSON array of [from, to] pairs");
      return [];
    }
    return data;
  } catch (e) {
    console.warn(`⚠ Failed to parse mappings file: ${e.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

/** @returns {{ num: number, unit: string } | null} */
function parseValue(raw) {
  const m = raw.match(PARSE_VALUE_RE);
  if (!m) {
    return null;
  }
  return { num: Number.parseFloat(m[1]), unit: m[2] || "" };
}

/** Convert px (or rem) to spacing-scale token. Returns string or null. */
function pxToSpacing(num, unit) {
  let px = num;
  if (unit === "rem") {
    px = num * 16;
  } else if (unit && unit !== "px") {
    return null;
  }

  if (px === 0) {
    return "0";
  }
  if (px === 1 && unit === "px") {
    return "px";
  }

  const units = px / 4;
  if (units < 0) {
    return null; // negatives handled by caller
  }
  // Valid if integer or ends in .5
  if (Number.isInteger(units) || (units * 2) % 1 === 0) {
    return String(units);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Converter factories (parameterized by theme tokens)
// ---------------------------------------------------------------------------

function convertSpacing(raw) {
  const v = parseValue(raw);
  if (!v) {
    return null;
  }
  return pxToSpacing(Math.abs(v.num), v.unit);
}

const FONT_SIZE_MAP = new Map([
  [12, "xs"],
  [14, "sm"],
  [16, "base"],
  [18, "lg"],
  [20, "xl"],
  [24, "2xl"],
  [30, "3xl"],
  [36, "4xl"],
  [48, "5xl"],
  [60, "6xl"],
  [72, "7xl"],
  [96, "8xl"],
  [128, "9xl"],
]);

function convertFontSize(raw) {
  const v = parseValue(raw);
  if (!v) {
    return null;
  }
  let px = v.num;
  if (v.unit === "rem") {
    px = v.num * 16;
  } else if (v.unit && v.unit !== "px") {
    return null;
  }
  return FONT_SIZE_MAP.get(px) ?? null;
}

/** Create border-radius converter from parsed theme tokens */
function createRadiusConverter(radiusMap) {
  return function convertBorderRadius(raw) {
    if (raw === "100%" || raw === "100px" || raw === "9999px") {
      return "full";
    }
    const v = parseValue(raw);
    if (!v || (v.unit && v.unit !== "px")) {
      return null;
    }
    return radiusMap.get(v.num) ?? null;
  };
}

/** Create line-height converter from parsed theme tokens */
function createLeadingConverter(leadingMap) {
  // Merge with Tailwind defaults
  const merged = new Map([
    [1, "none"],
    [1.25, "tight"],
    [1.375, "snug"],
    [1.5, "normal"],
    [1.625, "relaxed"],
    [2, "loose"],
    ...leadingMap,
  ]);

  return function convertLeading(raw) {
    const v = parseValue(raw);
    if (!v) {
      return null;
    }
    // Unitless → named token
    if (!v.unit) {
      return merged.get(v.num) ?? null;
    }
    // px/rem → spacing scale
    if (v.unit === "px" || v.unit === "rem") {
      return pxToSpacing(v.num, v.unit);
    }
    return null;
  };
}

function convertOpacity(raw) {
  const v = parseValue(raw);
  if (!v || v.unit === "px") {
    return null;
  }
  if (v.unit === "%") {
    if (Number.isInteger(v.num) && v.num >= 0 && v.num <= 100) {
      return String(v.num);
    }
    return null;
  }
  // Handle decimal (0-1) notation
  if (!v.unit && v.num >= 0 && v.num <= 1) {
    const pct = Math.round(v.num * 100);
    return String(pct);
  }
  // Handle integer 0-100
  if (!v.unit && Number.isInteger(v.num) && v.num >= 0 && v.num <= 100) {
    return String(v.num);
  }
  return null;
}

function convertZIndex(raw) {
  const v = parseValue(raw);
  if (!v || v.unit) {
    return null;
  }
  if (Number.isInteger(v.num)) {
    return String(v.num);
  }
  return null;
}

function convertDuration(raw) {
  const v = parseValue(raw);
  if (!v) {
    return null;
  }
  if (v.unit === "ms" && Number.isInteger(v.num) && v.num >= 0) {
    return String(v.num);
  }
  if (v.unit === "s" && v.num >= 0) {
    return String(v.num * 1000);
  }
  return null;
}

const BLUR_MAP = new Map([
  [0, "none"],
  [4, "xs"],
  [8, "sm"],
  [12, "md"],
  [16, "lg"],
  [24, "xl"],
  [40, "2xl"],
  [64, "3xl"],
]);

function convertBlur(raw) {
  const v = parseValue(raw);
  if (!v || (v.unit && v.unit !== "px")) {
    return null;
  }
  return BLUR_MAP.get(v.num) ?? null;
}

// ---------------------------------------------------------------------------
// Prefix → converter mapping
// ---------------------------------------------------------------------------

function buildPrefixConverters(radiusMap, leadingMap) {
  /** @type {Record<string, (raw: string) => string | null>} */
  const converters = {};

  // Spacing-based utilities
  const spacingPrefixes = [
    "gap",
    "gap-x",
    "gap-y",
    "p",
    "px",
    "py",
    "pt",
    "pr",
    "pb",
    "pl",
    "ps",
    "pe",
    "m",
    "mx",
    "my",
    "mt",
    "mr",
    "mb",
    "ml",
    "ms",
    "me",
    "w",
    "h",
    "size",
    "min-w",
    "min-h",
    "max-w",
    "max-h",
    "inset",
    "inset-x",
    "inset-y",
    "top",
    "right",
    "bottom",
    "left",
    "start",
    "end",
    "space-x",
    "space-y",
    "scroll-m",
    "scroll-mx",
    "scroll-my",
    "scroll-mt",
    "scroll-mr",
    "scroll-mb",
    "scroll-ml",
    "scroll-p",
    "scroll-px",
    "scroll-py",
    "scroll-pt",
    "scroll-pr",
    "scroll-pb",
    "scroll-pl",
    "basis",
    "translate-x",
    "translate-y",
  ];
  for (const p of spacingPrefixes) {
    converters[p] = convertSpacing;
  }

  // Font size (text-[14px] — but NOT text-[#color])
  converters.text = convertFontSize;

  // Border radius (from theme)
  const convertRadius = createRadiusConverter(radiusMap);
  const radiusPrefixes = [
    "rounded",
    "rounded-t",
    "rounded-b",
    "rounded-l",
    "rounded-r",
    "rounded-tl",
    "rounded-tr",
    "rounded-bl",
    "rounded-br",
    "rounded-s",
    "rounded-e",
    "rounded-ss",
    "rounded-se",
    "rounded-es",
    "rounded-ee",
  ];
  for (const p of radiusPrefixes) {
    converters[p] = convertRadius;
  }

  // Line height (from theme + TW defaults)
  converters.leading = createLeadingConverter(leadingMap);

  converters.opacity = convertOpacity;
  converters.z = convertZIndex;
  converters.duration = convertDuration;
  converters.blur = convertBlur;

  return converters;
}

// Prefixes to skip entirely (use arbitrary values legitimately)
const EXCLUDED_PREFIXES = new Set([
  "transition",
  "grid-cols",
  "grid-rows",
  "aspect",
  "from",
  "via",
  "to",
  "data",
  "has",
  "group",
  "group-data",
  "group-has",
  "peer",
  "peer-data",
  "peer-has",
  "not",
  "in",
  "out",
  "bg-linear",
  "bg-radial",
  "bg-conic",
  "columns",
  "auto-cols",
  "auto-rows",
  "content",
  "tracking",
  "border",
]);

// ---------------------------------------------------------------------------
// Core migration logic
// ---------------------------------------------------------------------------

// Matches: optional negative, utility-[value]
const ARBITRARY_RE = /(?<=^|[\s"'`{,(])(-?)([\w][\w-]*)-\[([^\]]+)\]/g;

/**
 * Migrate a single string of content.
 * @param {string} content
 * @param {Record<string, (raw: string) => string | null>} prefixConverters
 * @param {[string, string][]} staticMappings
 * @returns {{ content: string, replacements: [string,string][], unconvertible: string[] }}
 */
function migrateContent(source, prefixConverters, staticMappings) {
  const replacements = [];
  const unconvertible = [];
  let result = source;

  // 1. Static mappings (from JSON config)
  for (const [from, to] of staticMappings) {
    if (result.includes(from)) {
      result = result.replaceAll(from, to);
      replacements.push([from, to]);
    }
  }

  // 2. Regex-based conversion
  result = result.replace(ARBITRARY_RE, (match, neg, prefix, rawValue) => {
    // Strip variant prefixes (e.g., "md:hover:mt" → "mt")
    const lastColon = prefix.lastIndexOf(":");
    const utilityPrefix = lastColon >= 0 ? prefix.slice(lastColon + 1) : prefix;
    const variantPart = lastColon >= 0 ? prefix.slice(0, lastColon + 1) : "";

    // Skip excluded prefixes
    if (EXCLUDED_PREFIXES.has(utilityPrefix)) {
      return match;
    }

    const converter = prefixConverters[utilityPrefix];
    if (!converter) {
      return match; // no converter for this prefix — silently skip
    }

    // Handle inner negatives: top-[-10px] → value is "-10px", prefix stays "top"
    const isInnerNeg = rawValue.startsWith("-");
    const cleanValue = isInnerNeg ? rawValue.slice(1) : rawValue;

    const result = converter(cleanValue);
    if (result === null) {
      unconvertible.push(match);
      return match;
    }

    // Build the replacement
    const isNeg = neg === "-" || isInnerNeg;
    const negPrefix = isNeg ? "-" : "";
    const replacement = `${negPrefix}${variantPart}${utilityPrefix}-${result}`;

    replacements.push([match, replacement]);
    return replacement;
  });

  return { content: result, replacements, unconvertible };
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

function collectFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === ".next" || entry === ".git") {
        continue;
      }
      results.push(...collectFiles(full));
    } else if ([".tsx", ".ts"].includes(extname(entry))) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// 1. Parse theme tokens
const cssPath = join(ROOT, CSS_THEME_FILE);
const { radius, leading } = parseThemeTokens(cssPath);

if (VERBOSE) {
  console.log("Parsed theme tokens:");
  if (radius.size > 0) {
    console.log(
      `  radius: ${[...radius.entries()].map(([px, name]) => `${px}px→${name}`).join(", ")}`
    );
  }
  if (leading.size > 0) {
    console.log(
      `  leading: ${[...leading.entries()].map(([val, name]) => `${val}→${name}`).join(", ")}`
    );
  }
  console.log();
}

// 2. Build converters from theme
const prefixConverters = buildPrefixConverters(radius, leading);

// 3. Load optional static mappings
const mappingsPath = join(ROOT, MAPPINGS_FILE);
const staticMappings = loadStaticMappings(mappingsPath);
if (staticMappings.length > 0) {
  console.log(
    `Loaded ${staticMappings.length} static mappings from ${MAPPINGS_FILE}`
  );
}

// 4. Scan and migrate
const dirs = SCAN_DIRS.map((d) => join(ROOT, d));
const files = dirs.flatMap(collectFiles);

console.log(`Scanning ${SCAN_DIRS.join(", ")} for .ts/.tsx files...`);
console.log(`Found ${files.length} files${DRY_RUN ? " (dry run)" : ""}\n`);

let totalChanged = 0;
let totalReplacements = 0;
/** @type {Map<string, number>} */
const allUnconvertible = new Map();

for (const file of files) {
  const original = readFileSync(file, "utf8");
  const { content, replacements, unconvertible } = migrateContent(
    original,
    prefixConverters,
    staticMappings
  );

  if (replacements.length > 0) {
    totalChanged++;
    totalReplacements += replacements.length;
    const rel = file.replace(ROOT, "").replace(/\\/g, "/");

    if (VERBOSE) {
      console.log(`${DRY_RUN ? "[DRY RUN] " : ""}${rel}:`);
      for (const [from, to] of replacements) {
        console.log(`  ${from} → ${to}`);
      }
    } else {
      console.log(
        `${DRY_RUN ? "[DRY RUN] " : "✓"} ${rel} (${replacements.length} replacements)`
      );
    }

    if (!DRY_RUN) {
      writeFileSync(file, content, "utf8");
    }
  }

  for (const u of unconvertible) {
    allUnconvertible.set(u, (allUnconvertible.get(u) || 0) + 1);
  }
}

// Summary
console.log(`\n${"─".repeat(60)}`);
console.log(`Files scanned: ${files.length}`);
console.log(`Files ${DRY_RUN ? "would change" : "changed"}: ${totalChanged}`);
console.log(
  `Replacements ${DRY_RUN ? "planned" : "made"}: ${totalReplacements}`
);

if (allUnconvertible.size > 0) {
  console.log("\nRemaining unconvertible arbitraries:");
  const sorted = [...allUnconvertible.entries()].sort((a, b) => b[1] - a[1]);
  for (const [value, count] of sorted) {
    console.log(`  ${value} (${count}×)`);
  }
}

if (!DRY_RUN && totalChanged > 0) {
  console.log("\nRun: pnpm format && pnpm typecheck");
}
