# migrate-tailwind-arbitraries

Convert arbitrary Tailwind values to predefined classes. Parses your CSS `@theme` block for project-specific tokens (radius, leading). Supports optional JSON mappings for colors.

```
gap-[16px]  → gap-4
top-[-10px] → -top-2.5
rounded-[20px] → rounded-2xl  (from your @theme)
```

## Usage

```bash
# from target project root
pnpm dlx --package github:antonchuvirau/ux-mind-helpers migrate-tailwind-arbitraries --dry-run

# with custom paths
migrate-tailwind-arbitraries --css src/styles/app.css --dirs src --mappings tw-mappings.json
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--dry-run` | `false` | Preview changes without writing |
| `--verbose` | `false` | Show each replacement |
| `--css` | `styles/globals.css` | CSS file with `@theme` block |
| `--mappings` | `migrate-tailwind-mappings.json` | Optional JSON `[from, to]` pairs |
| `--dirs` | `app,components` | Comma-separated directories to scan |

## What it converts

| Category | Example | Logic |
|----------|---------|-------|
| Spacing (gap, p, m, w, h, inset, top/right/bottom/left, translate, basis, scroll, space) | `p-[1rem]` → `p-4` | `px / 4` → spacing unit |
| Font size | `text-[14px]` → `text-sm` | Named size lookup |
| Border radius | `rounded-[10px]` → `rounded-lg` | From `@theme --radius-*` |
| Line height | `leading-[1.2]` → `leading-120` | From `@theme --leading-*` + TW defaults |
| Opacity | `opacity-[50]` → `opacity-50` | Direct integer |
| Z-index | `z-[10]` → `z-10` | Direct integer |
| Duration | `duration-[300ms]` → `duration-300` | ms integer |
| Blur | `blur-[16px]` → `blur-lg` | Named size lookup |
| Negative values | `top-[-10px]` → `-top-2.5` | Inner/outer negative handling |
| Colors | via `--mappings` JSON | Static `[from, to]` pairs |

## Mappings file

For values that can't be derived programmatically (e.g. hex colors → theme tokens), create a JSON file:

```json
[
  ["bg-[#305cde]", "bg-header-button-bg"],
  ["text-[#f6f7f9]", "text-header-dropdown-bg"]
]
```

See [migrate-tailwind-mappings.example.json](migrate-tailwind-mappings.example.json) for a full example.

## Unconvertible values

Values the script can't convert (viewport units, calc(), percentages, aspect ratios) are reported at the end:

```
Remaining unconvertible arbitraries:
  max-h-[90dvh] (2x)
  w-[calc(100vw-40px)] (1x)
```
