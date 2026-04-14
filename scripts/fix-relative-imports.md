# fix-relative-imports

Replace `../` relative imports with path alias imports (e.g. `~/`). Same-directory imports (`./`) are left untouched.

```
import { foo } from "../../lib/foo";
// becomes
import { foo } from "~/lib/foo";
```

## Usage

```bash
pnpm dlx --package github:antonchuvirau/ux-mind-helpers fix-relative-imports --src . --alias "~/"
```

## Options

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--src` | `-s` | `src` | Source directory to scan |
| `--alias` | `-a` | `~/` | Alias prefix (e.g. `~/`, `@/`, `@src/`) |
| `--ext` | `-e` | `.ts,.tsx` | Comma-separated file extensions |
| `--skip` | | `node_modules,.next,.git,dist,public` | Dirs to skip |
| `--dry-run` | | `false` | Preview changes without writing |

## How it works

1. Walks files matching `--ext` inside `--src`, skipping `--skip` dirs
2. Finds `from "../..."` imports (regex, not AST)
3. Resolves relative path to absolute, then makes it relative to `--src`
4. Prepends `--alias` to produce the final import path

~80 LOC, zero dependencies.
