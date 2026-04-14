import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

function pxToTailwind(px: number): string | null {
  const units = px / 4;
  const rounded = Math.round(units * 2) / 2;
  if (rounded === 0) {
    return null;
  }
  return rounded % 1 === 0 ? String(Math.floor(rounded)) : String(rounded);
}

function processFile(filePath: string): { changed: boolean; count: number } {
  const content = readFileSync(filePath, "utf-8");
  let count = 0;
  const result = content.replace(/\[(\d+(?:\.\d+)?)px\]/g, (match, val) => {
    const tw = pxToTailwind(Number.parseFloat(val));
    if (tw) {
      count++;
      return tw;
    }
    return match;
  });
  if (result !== content) {
    writeFileSync(filePath, result, "utf-8");
    return { changed: true, count };
  }
  return { changed: false, count: 0 };
}

function walkDir(dir: string, ext: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (
      stat.isDirectory() &&
      !entry.startsWith(".") &&
      entry !== "node_modules" &&
      entry !== ".next"
    ) {
      files.push(...walkDir(full, ext));
    } else if (stat.isFile() && extname(entry) === ext) {
      files.push(full);
    }
  }
  return files;
}

const root = process.cwd();
const files = walkDir(root, ".tsx");
let changedFiles = 0;
let totalReplacements = 0;

for (const f of files) {
  const { changed, count } = processFile(f);
  if (changed) {
    console.log(`  ${f.replace(root, "").replace(/\\/g, "/")} (${count})`);
    changedFiles++;
    totalReplacements += count;
  }
}

console.log(
  `\nDone. ${totalReplacements} replacements across ${changedFiles}/${files.length} files.`
);
