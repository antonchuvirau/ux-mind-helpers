#!/usr/bin/env node
// Fixture-based tests for react-namespace-imports.
// Each fixture has an input + expected output; the transform must produce the
// expected output on first run and be idempotent on the second run.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { transformSource } from "../scripts/react-namespace-imports.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(
  __dirname,
  "__fixtures__",
  "react-event-handlers"
);

function normalize(code) {
  return code.replace(/\r\n/g, "\n").replace(/\s+$/u, "\n");
}

function lineDiff(expected, actual) {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const max = Math.max(expectedLines.length, actualLines.length);
  const lines = [];
  for (let i = 0; i < max; i++) {
    const e = expectedLines[i];
    const a = actualLines[i];
    if (e === a) continue;
    if (e !== undefined) lines.push(`- ${i + 1}: ${e}`);
    if (a !== undefined) lines.push(`+ ${i + 1}: ${a}`);
  }
  return lines.join("\n");
}

async function runFixture(name) {
  const inputPath = path.join(FIXTURE_DIR, `${name}.input.tsx.txt`);
  const outputPath = path.join(FIXTURE_DIR, `${name}.output.tsx.txt`);

  const [inputRaw, expectedRaw] = await Promise.all([
    readFile(inputPath, "utf8"),
    readFile(outputPath, "utf8"),
  ]);

  const input = normalize(inputRaw);
  const expected = normalize(expectedRaw);

  const firstResult = transformSource(input);
  const firstCode = normalize(firstResult ? firstResult.code : input);

  if (firstCode !== expected) {
    return {
      name,
      pass: false,
      reason: "output mismatch",
      expected,
      actual: firstCode,
    };
  }

  const secondResult = transformSource(firstCode);
  const secondCode = normalize(secondResult ? secondResult.code : firstCode);

  if (secondCode !== firstCode) {
    return {
      name,
      pass: false,
      reason: "not idempotent",
      expected: firstCode,
      actual: secondCode,
    };
  }

  return { name, pass: true };
}

async function main() {
  const entries = await readdir(FIXTURE_DIR);
  const names = [
    ...new Set(
      entries
        .filter((f) => f.endsWith(".input.tsx.txt"))
        .map((f) => f.replace(/\.input\.tsx\.txt$/u, ""))
    ),
  ].sort();

  if (names.length === 0) {
    console.error("No fixtures found.");
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  for (const name of names) {
    const result = await runFixture(name);
    if (result.pass) {
      console.log(`PASS ${name}`);
    } else {
      failed += 1;
      console.log(`FAIL ${name} (${result.reason})`);
      console.log(lineDiff(result.expected, result.actual));
    }
  }

  console.log(
    `\n${names.length - failed}/${names.length} fixtures passed${failed ? ` (${failed} failed)` : ""}.`
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
