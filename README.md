# fix-relative-ts-imports

Replace `../` relative imports with path alias imports (e.g. `~/`). Zero dependencies.

```
import { foo } from "../../lib/foo";
// becomes
import { foo } from "~/lib/foo";
```

Same-directory imports (`./`) are left untouched.

## Usage

```bash
# from GitHub
pnpm dlx github:antonchuvirau/fix-relative-ts-imports --src src --alias "~/"

# or npx
npx github:antonchuvirau/fix-relative-ts-imports --src src --alias "~/"

# or run locally
node bin.mjs --src src --alias "~/"
```

## Options

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--src` | `-s` | `src` | Source directory to scan |
| `--alias` | `-a` | `~/` | Alias prefix (e.g. `~/`, `@/`, `@src/`) |
| `--ext` | `-e` | `.ts,.tsx` | Comma-separated file extensions |
| `--skip` | | `node_modules,.next,.git,dist,public` | Comma-separated dirs to skip |
| `--dry-run` | | `false` | Preview changes without writing |
| `--help` | `-h` | | Show help |

## Examples

```bash
# Preview what would change
fix-relative-ts-imports --src src --alias "~/" --dry-run

# Use @/ alias instead
fix-relative-ts-imports --src src --alias "@/"

# Include .js and .jsx files
fix-relative-ts-imports --src src --ext ".ts,.tsx,.js,.jsx"

# Skip additional directories
fix-relative-ts-imports --src src --skip "node_modules,.git,dist,generated"
```

## How it works

1. Walks all files matching `--ext` inside `--src`, skipping `--skip` dirs
2. Finds `from "../..."` imports (regex, not AST — fast and predictable)
3. Resolves the relative path to an absolute path, then makes it relative to `--src`
4. Prepends `--alias` to produce the final import path

## Requirements

- Node.js 18+ (uses `node:util` `parseArgs`)

## Why not X?

| Package | Issue |
|---------|-------|
| `ts-path-alias-fixer` | Resolves to absolute OS paths on Windows, no `--ignore`, rewrites `./` imports too, 27 transitive deps |
| `relative-to-alias` | Abandoned (5 years), 6 deps, 55 downloads/week |
| ESLint `no-relative-import-paths` | Enforcement only, not a one-shot codemod |

This tool is ~80 LOC with zero dependencies.
