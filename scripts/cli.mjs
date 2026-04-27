#!/usr/bin/env node
// Dispatcher: forwards `ux-mind-helpers <script> [args]` to the matching
// script file. Single-bin design works around `pnpm dlx --package <gh-url>`
// failing to expose non-default bins on Windows.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const SCRIPTS = {
  "fix-relative-imports": "fix-relative-imports.mjs",
  "migrate-tailwind-arbitraries": "migrate-tailwind-arbitraries.mjs",
  "react-namespace-imports": "react-namespace-imports.mjs",
  "lucide-icon-suffix": "lucide-icon-suffix.mjs",
  "check-no-memo-carveout": "check-no-memo-carveout.mjs",
};

const HELP = `ux-mind-helpers — reusable codemod scripts for UX Mind projects

Scripts:
  fix-relative-imports          Replace ../ imports with path alias (~/, @/)
  migrate-tailwind-arbitraries  Convert arbitrary Tailwind values to predefined classes
  react-namespace-imports       Flatten 'import * as React' to named imports
  lucide-icon-suffix            Append 'Icon' suffix to lucide-react imports
  check-no-memo-carveout        React Compiler interior-mutability lint guard

Usage:
  pnpm dlx github:antonchuvirau/ux-mind-helpers <script> [options]
  pnpm dlx github:antonchuvirau/ux-mind-helpers <script> --help`;

const [, , cmd, ...args] = process.argv;

if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(HELP);
  process.exit(0);
}

const file = SCRIPTS[cmd];
if (!file) {
  console.error(`Unknown script: ${cmd}\n`);
  console.log(HELP);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(here, file), ...args], {
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
