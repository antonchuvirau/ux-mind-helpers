import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

export async function confirm(question, { defaultYes = true } = {}) {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(question + suffix)).trim().toLowerCase();
    if (answer === "") return defaultYes;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export function isInteractive() {
  return stdin.isTTY === true && stdout.isTTY === true;
}
