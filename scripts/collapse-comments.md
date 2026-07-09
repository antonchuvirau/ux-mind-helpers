# collapse-comments

Collapses multiline comments to a single line so the editor owns soft-wrapping instead of hard-coded line breaks. JSDoc (`/** ... */`) is left untouched — its line structure is semantic (`@param`, tags).

## What it does

- **Non-JSDoc block comments** `/* ... */` spanning multiple lines → one line. Strips leading `*`/whitespace per line and joins with single spaces (`/* a\n * b */` → `/* a b */`).
- **Runs of `//` lines** that are adjacent, standalone (nothing but whitespace before `//`), and at the same indentation → merged into one `//` line.
- Ignores comment markers inside strings, template literals, and JSX (a hand-rolled scanner, no dependencies).

Left untouched: JSDoc `/** */`, single-line comments, trailing `//` after code, `//` lines separated by a blank line or at different indentation, and already-single-line comments (idempotent).

## Usage

```bash
# Interactive: scan, review, prompt [Y/n]
pnpm dlx github:antonchuvirau/ux-mind-helpers collapse-comments

# CI check (exit 1 if anything would change)
pnpm dlx github:antonchuvirau/ux-mind-helpers collapse-comments --dry-run

# Apply without prompting
pnpm dlx github:antonchuvirau/ux-mind-helpers collapse-comments --yes
```

Scope to a subtree with `--src`:

```bash
pnpm dlx github:antonchuvirau/ux-mind-helpers collapse-comments --src src/features
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

```ts
// Faceted-search semantics: each facet's counts EXCLUDE its own selection
// (so unselected options show "what if I picked this too") but apply every
// other facet's active selection.
const facets = build();

/* Prisma can't groupBy array columns,
   so misc tags have no counts. */
```

After:

```ts
// Faceted-search semantics: each facet's counts EXCLUDE its own selection (so unselected options show "what if I picked this too") but apply every other facet's active selection.
const facets = build();

/* Prisma can't groupBy array columns, so misc tags have no counts. */
```

## Note

If your formatter (Prettier, Biome) enforces a comment line length, it may re-wrap the collapsed lines back on the next format run. This tool still helps editors that soft-wrap comments to the viewport; the on-disk form is your formatter's call.
