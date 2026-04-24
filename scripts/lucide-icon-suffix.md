# lucide-icon-suffix

Appends the `Icon` suffix to `lucide-react` imports (`Check` → `CheckIcon`) and rewrites all in-file usages. Matches the lucide-react naming convention where every icon exports both the legacy bare name and the `*Icon` form; the `*Icon` form is the future-proof one.

## What it does

For each `from "lucide-react"` import:

- Skips specifiers that already end in `Icon`.
- Skips `import type` / specifier-level `type ` imports (type-only usages are safe and don't need renaming).
- Skips specifiers with **shadowing local bindings** in the same file (const/let/var, function, class, or imports from another module that share the name). Prints a warning for each skipped specifier.
- Preserves existing aliases (`{ Check as CheckboxIcon }` → `{ CheckIcon as CheckboxIcon }`).
- Drops duplicates if a file already imports both `Check` and `CheckIcon`.
- Ignores identifier matches inside strings, template literals, and comments (proper tokenization).

## Usage

```bash
# Interactive: scan, review, prompt [Y/n]
pnpm dlx --package github:antonchuvirau/ux-mind-helpers lucide-icon-suffix

# CI check
pnpm dlx --package github:antonchuvirau/ux-mind-helpers lucide-icon-suffix --dry-run

# CI fix
pnpm dlx --package github:antonchuvirau/ux-mind-helpers lucide-icon-suffix --yes
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `-s, --src <dir>` | `.` | Directory to scan. |
| `-e, --ext <list>` | `.ts,.tsx,.js,.jsx,.mjs,.cjs,.mts,.cts` | Comma-separated extensions. |
| `--skip <list>` | `node_modules,.next,.turbo,.git,dist,out,coverage` | Directory names to skip. |
| `--dry-run` | off | Print changes and exit 1; never prompt, never write. |
| `-y, --yes` | off | Apply without prompting. Required in non-interactive shells. |
| `-h, --help` | — | Show help. |

## Example

Before:

```tsx
import { Check, ChevronDown, Trash2 } from "lucide-react";

export function Row() {
  return (
    <>
      <Check />
      <ChevronDown />
      <Trash2 />
    </>
  );
}
```

After:

```tsx
import { CheckIcon, ChevronDownIcon, Trash2Icon } from "lucide-react";

export function Row() {
  return (
    <>
      <CheckIcon />
      <ChevronDownIcon />
      <Trash2Icon />
    </>
  );
}
```

## Warnings

If an icon name collides with a local binding the script prints e.g.:

```
- components/check-list.tsx: shadowing: "Check" has a conflicting local binding; skipped
```

Review and rename the local binding by hand, then re-run.
