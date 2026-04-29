# ux-mind-helpers

Reusable codemod scripts for UX Mind projects. Zero dependencies, Node.js 18+.

## Scripts

| Script | Description |
|--------|-------------|
| [fix-relative-imports](scripts/fix-relative-imports.md) | Replace `../` relative imports with path alias (`~/`, `@/`) |
| [migrate-tailwind-arbitraries](scripts/migrate-tailwind-arbitraries.md) | Convert arbitrary Tailwind values (`gap-[16px]`) to predefined classes (`gap-4`) |
| [react-namespace-imports](scripts/react-namespace-imports.md) | Flatten `import * as React` to named imports; alias DOM event types used generically |
| [lucide-icon-suffix](scripts/lucide-icon-suffix.md) | Append `Icon` suffix to `lucide-react` imports (`Check` → `CheckIcon`) |
| [check-no-memo-carveout](scripts/check-no-memo-carveout.md) | React Compiler interior-mutability lint guard (TanStack Table/Virtual, react-hook-form, MobX, zustand, react-query) |
| [check-icon-button-label](scripts/check-icon-button-label.md) | Flag icon-only `<Button>`s missing `aria-label`/`aria-labelledby`/`title` (polymorphic-donut systems) |

## Usage

```bash
pnpm dlx github:antonchuvirau/ux-mind-helpers <script-name> [options]
```

Most scripts default to an interactive flow: scan, print changes, prompt `[Y/n]`. Pass `--dry-run` to preview without prompting, or `--yes` to auto-apply (for CI).

## Tests

```bash
pnpm test
```

## License

MIT
