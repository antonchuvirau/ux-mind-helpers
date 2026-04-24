import { readdir } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_IGNORED_DIRS = [
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "out",
];

export const DEFAULT_EXTENSIONS = [
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
];

export async function collectSourceFiles(rootDir, options = {}) {
  const ignoredDirs = new Set(options.ignoredDirs ?? DEFAULT_IGNORED_DIRS);
  const extensions = new Set(options.extensions ?? DEFAULT_EXTENSIONS);
  const files = [];

  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          await walk(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) continue;
      if (!extensions.has(path.extname(entry.name))) continue;

      files.push(fullPath);
    }
  }

  await walk(rootDir);
  return files;
}

export function toRelativePath(rootDir, filePath) {
  return path.relative(rootDir, filePath).replaceAll("\\", "/");
}
