# ux-mind-helpers

Reusable codemod scripts for UX Mind projects. Zero dependencies, Node.js 18+.

## Scripts

| Script | Description |
|--------|-------------|
| [fix-relative-imports](scripts/fix-relative-imports.md) | Replace `../` relative imports with path alias (`~/`, `@/`) |
| [migrate-tailwind-arbitraries](scripts/migrate-tailwind-arbitraries.md) | Convert arbitrary Tailwind values (`gap-[16px]`) to predefined classes (`gap-4`) |
| [convert-px.ts](scripts/convert-px.ts) | Simple px-to-Tailwind spacing converter |

## Usage

```bash
pnpm dlx --package github:antonchuvirau/ux-mind-helpers <script-name> [options]
```

## License

MIT
