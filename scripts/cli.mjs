#!/usr/bin/env node
// Dispatcher: forwards `ux-mind-helpers <script> [args]` to the matching
// script file. Single-bin design works around `pnpm dlx --package <gh-url>`
// failing to expose non-default bins on Windows.

import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));

// Auto-discover every scripts/*.mjs (except this dispatcher) so a new codemod
// shows up in `--help` the moment its file lands — no manual registry to sync.
// A script's one-line description is the first `// ...` comment in its file.
function discoverScripts() {
  const scripts = {};
  for (const file of readdirSync(here)) {
    if (!file.endsWith(".mjs") || file === "cli.mjs") continue;
    const name = file.slice(0, -4);
    const firstComment = readFileSync(join(here, file), "utf8")
      .split("\n")
      .find((line) => line.startsWith("// "));
    scripts[name] = {
      file,
      desc: firstComment ? firstComment.slice(3).trim() : "",
    };
  }
  return scripts;
}

const SCRIPTS = discoverScripts();

function buildHelp() {
  const names = Object.keys(SCRIPTS).sort();
  const pad = Math.max(...names.map((n) => n.length));
  const lines = names.map((n) => `  ${n.padEnd(pad)}  ${SCRIPTS[n].desc}`);
  return `ux-mind-helpers — reusable codemod scripts for UX Mind projects

Scripts:
${lines.join("\n")}

Usage:
  pnpm dlx github:antonchuvirau/ux-mind-helpers <script> [options]
  pnpm dlx github:antonchuvirau/ux-mind-helpers <script> --help`;
}

const HELP = buildHelp();

const [, , cmd, ...args] = process.argv;

if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(HELP);
  process.exit(0);
}

const entry = SCRIPTS[cmd];
if (!entry) {
  console.error(`Unknown script: ${cmd}\n`);
  console.log(HELP);
  process.exit(1);
}

const child = spawn(process.execPath, [join(here, entry.file), ...args], {
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
