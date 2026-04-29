# check-icon-button-label

Lint guard for icon-only Buttons that lack an accessible name. Fails CI when a `<Button>` (or configured wrapper) wraps a single `<*Icon />` child without `aria-label` / `aria-labelledby` / `title`.

## Why this exists

Polymorphic-donut button systems (e.g. coss-ui) collapse explicit `icon-*` size variants into a `:has(>svg:only-child)` auto-detection rule. The visual works, but the icon provides no accessible name. Screen readers announce the button as unlabelled. Biome/Ultracite has no rule that catches this exact pattern; jsx-a11y's `control-has-associated-label` is ESLint-only.

This script fills the gap — config-driven, zero deps, Node 18+.

## Usage

```bash
# Defaults: scan components/app/src for <Button>/<InputGroupButton>
pnpm dlx github:antonchuvirau/ux-mind-helpers check-icon-button-label

# Custom button wrappers
pnpm dlx github:antonchuvirau/ux-mind-helpers check-icon-button-label \
  --components Button,InputGroupButton,IconButton

# Custom icon naming pattern (default = PascalCase ending in `Icon`)
pnpm dlx github:antonchuvirau/ux-mind-helpers check-icon-button-label \
  --icon-pattern "^(Lucide|Hero)[A-Z][A-Za-z0-9_]*$"
```

Auto-detects a config at:
- `<cwd>/check-icon-button-label.config.json`
- `<cwd>/scripts/check-icon-button-label.config.json`

## Wire into package.json

```json
{
  "scripts": {
    "lint": "biome check && pnpm dlx github:antonchuvirau/ux-mind-helpers check-no-memo-carveout && pnpm dlx github:antonchuvirau/ux-mind-helpers check-icon-button-label"
  }
}
```

## Options

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--src` | `-s` | `components,app,src` | Comma-separated source dirs to scan (existing only) |
| `--ext` | `-e` | `.tsx` | Comma-separated extensions |
| `--components` | | `Button,InputGroupButton` | Component names to lint |
| `--icon-pattern` | | `^[A-Z][A-Za-z0-9_]*Icon$` | Regex matched against icon child tag name |
| `--config` | | (auto-detect) | Path to JSON config overriding defaults |
| `--cwd` | | `process.cwd()` | Project root |
| `--help` | `-h` | | Show usage |

## Exit codes

- `0` — no violations
- `1` — one or more icon-only buttons missing an accessible name
- `2` — internal error (config parse, etc.)

## What gets flagged

```tsx
// FAIL — icon-only, no accessible name
<Button>
  <XIcon />
</Button>

// FAIL — paired tag, still icon-only
<Button variant="ghost">
  <SearchIcon></SearchIcon>
</Button>
```

## What does NOT get flagged

```tsx
// OK — aria-label
<Button aria-label="Close"><XIcon /></Button>

// OK — aria-labelledby / title also satisfy
<Button aria-labelledby="lbl"><XIcon /></Button>
<Button title="Close"><XIcon /></Button>

// OK — visible text provides accessible name
<Button><XIcon /> Close</Button>

// OK — spread props (assumed to forward a label)
<Button {...closeProps}><XIcon /></Button>

// SKIPPED — self-closing, children come from elsewhere (render slot)
<PopoverTrigger render={<Button variant="ghost" />}>
  <XIcon />
</PopoverTrigger>
```

## Config schema

```json
{
  "src": ["components", "app", "src"],
  "extensions": [".tsx"],
  "ignoredDirs": [".git", ".next", "node_modules", "dist"],
  "components": ["Button", "InputGroupButton"],
  "iconNamePattern": "^[A-Z][A-Za-z0-9_]*Icon$",
  "labelProps": ["aria-label", "aria-labelledby", "title"]
}
```

## How it works

1. Walks `src` directories, filtering by `extensions`, skipping `ignoredDirs`.
2. For each file, finds every `<Button` / `<InputGroupButton` opening tag (excluding `<ButtonGroup`, `</Button>`, etc.).
3. Walks character-by-character through the opening tag, tracking JSX expressions `{...}` so a `>` inside a prop expression doesn't terminate early.
4. If the tag is self-closing (`<Button … />`), skips — children come from a parent `render` slot and aren't statically visible.
5. Otherwise finds the matching `</Button>` accounting for nesting, then checks if the body (after stripping JSX block comments and whitespace) is exactly one icon child whose tag name matches `iconNamePattern`.
6. If so AND the opening tag carries no spread (`{...x}`) and none of `labelProps` are present, reports a violation.
7. Exits 1 if any violations were reported.

~330 LOC, zero runtime dependencies.

## Limitations

- **Heuristic detection.** Regex-based, not AST-based. False negatives are tolerated; false positives are minimised by skipping spread-props, paired-tag-with-text, and self-closing forms.
- **Self-closing render slots are skipped.** `<PopoverTrigger render={<Button variant="ghost" />}>{children}</PopoverTrigger>` may still need a label, but the children come from outside the Button — out of scope for this script. Catch via dev-time review or a runtime warning inside Button.
- **Wrapped icons not detected.** `<Button><span><Icon /></span></Button>` is not flagged (icon isn't the direct child) — but the polymorphic-donut auto-detection wouldn't fire either, so the visual would also be off.
- **Naming convention assumed.** Default `iconNamePattern` matches PascalCase ending in `Icon`. Project-internal icons that don't match (e.g. `BreadcrumbEllipsis`) are silently ignored. Override `--icon-pattern` if your convention differs.
- **No fix-it mode.** Reports only.

## When Biome / jsx-a11y ships an equivalent rule

This script can be retired in favor of the built-in lint rule. Until then, it fills the gap on Biome-only projects that adopt the polymorphic-donut button pattern.

## References

- [W3C ARIA: Button accessible name](https://www.w3.org/WAI/ARIA/apg/patterns/button/)
- [jsx-a11y `control-has-associated-label`](https://github.com/jsx-eslint/eslint-plugin-jsx-a11y/blob/main/docs/rules/control-has-associated-label.md)
- [Polymorphic-donut pattern (`:has(>svg:only-child)`)](https://developer.mozilla.org/en-US/docs/Web/CSS/:has)
