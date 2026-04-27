# check-no-memo-carveout

React Compiler 1.0 interior-mutability lint guard. Fails CI when a file uses an incompatible library/hook without declaring the `"use no memo"` directive.

## Why this exists

React Compiler 1.0 ships its own ESLint rule (`react-hooks/incompatible-library`). Biome/Ultracite does not implement an equivalent. Projects on Biome lose the guard. This script fills the gap — config-driven, zero deps, Node 18+.

## Usage

```bash
# Run with built-in defaults (TanStack Table/Virtual + RHF + zustand/mobx/react-query advisories)
pnpm dlx github:antonchuvirau/ux-mind-helpers check-no-memo-carveout

# Override scanned directories
pnpm dlx github:antonchuvirau/ux-mind-helpers check-no-memo-carveout --src components,hooks,app

# Use a project-local config
pnpm dlx github:antonchuvirau/ux-mind-helpers check-no-memo-carveout --config ./scripts/carveout.json
```

Auto-detects a config at:
- `<cwd>/check-no-memo-carveout.config.json`
- `<cwd>/scripts/check-no-memo-carveout.config.json`

If neither exists, the script ships with sensible defaults that cover the libraries on the React team's official `incompatible-library` list plus project-extended RHF rules.

## Wire into package.json

```json
{
  "scripts": {
    "lint": "biome check && pnpm dlx github:antonchuvirau/ux-mind-helpers check-no-memo-carveout"
  }
}
```

## Options

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--src` | `-s` | `components,hooks,app,lib,src` | Comma-separated source dirs to scan (existing dirs only) |
| `--ext` | `-e` | `.ts,.tsx` | Comma-separated extensions |
| `--config` | | (auto-detect) | Path to JSON config overriding defaults |
| `--cwd` | | `process.cwd()` | Project root |
| `--help` | `-h` | | Show usage |

## Exit codes

- `0` — no enforced violations (advisories may have been logged)
- `1` — one or more enforced rules fired
- `2` — internal error (config parse, etc.)

## Built-in rules

### Enforced (CI-failing)

- **TanStack Table** — value import from `@tanstack/react-table`
- **TanStack Virtual** — value import from `@tanstack/react-virtual`
- **react-hook-form interior hooks** — calls to `useFormState`, `useWatch`, `useFieldArray`, `useController`
- **react-hook-form legacy `watch()`** — `.watch(` call paired with a value import from `react-hook-form`

### Advisory (warns, exits 0)

- **MobX observer** — value import from `mobx-react` or `mobx-react-lite`
- **zustand** — value import from `zustand`
- **TanStack Query** — value import from `@tanstack/react-query`

## Config schema

A project-local config replaces the built-in defaults. To extend rather than replace, copy the defaults from `check-no-memo-carveout.mjs` and add your entries.

```json
{
  "src": ["components", "hooks", "app", "lib"],
  "extensions": [".ts", ".tsx"],
  "ignoredDirs": [".git", ".next", "node_modules", "dist"],
  "directives": ["\"use no memo\"", "'use no memo'", "\"use no forget\"", "'use no forget'"],
  "rules": [
    {
      "name": "TanStack Table",
      "enforced": true,
      "imports": ["@tanstack/react-table"],
      "reason": "useReactTable returns interior-mutated instance.",
      "references": ["https://..."]
    },
    {
      "name": "RHF interior hooks",
      "enforced": true,
      "hooks": ["useFormState", "useWatch", "useFieldArray", "useController"],
      "reason": "Subscribe via interior mutation."
    },
    {
      "name": "RHF legacy watch()",
      "enforced": true,
      "methods": [{ "name": "watch", "requiresImportFrom": "react-hook-form" }],
      "reason": "form.watch() in render is broken under Compiler."
    },
    {
      "name": "zustand (watch-list)",
      "enforced": false,
      "imports": ["zustand"],
      "reason": "Audit selector return shapes."
    }
  ]
}
```

### Rule fields

- `name` — shown in error/advisory output. Human-friendly.
- `enforced` — `true` fails CI, `false` warns only.
- `imports` (optional) — packages whose **value** import (not `import type`) triggers the rule. Type-only imports erase at compile time and are correctly excluded.
- `hooks` (optional) — function names whose call (`hookName(...)`) triggers the rule, regardless of import path.
- `methods` (optional) — `[{ name, requiresImportFrom }]`. Method-call detection (`.methodName(`); only fires when a value import from `requiresImportFrom` is also present (avoids false positives on unrelated `.watch()` calls).
- `reason` — one-line explanation shown in output.
- `references` (optional) — list of upstream-issue URLs.

A rule fires if **any** of `imports`/`hooks`/`methods` matches. A file is flagged if at least one rule fires AND no `directives` substring is present.

## How it works

1. Walks `src` directories, filtering by `extensions`, skipping `ignoredDirs`.
2. For each file, checks if any `directives` substring is present — if yes, skips entirely (file already opted out).
3. Otherwise iterates rules, recording matches.
4. Prints advisories first, then enforced violations.
5. Exits 1 if any enforced rule fired.

~250 LOC, zero runtime dependencies.

## Limitations

- **Heuristic detection.** The script greps for imports and call-sites — it doesn't parse AST. False positives are possible. Mitigation: add the directive (cost is zero) or refactor the false-positive call.
- **No fix-it mode.** The script only reports — it does not insert directives automatically. Directive placement (file vs function level) is a design choice.
- **No type-aware checks.** A file that destructures a TanStack Table instance imported from a wrapper module won't be flagged.

## When Biome ships an equivalent rule

This script can be retired in favor of the built-in lint rule. Until then, this fills the gap on Biome-only projects.

## References

- [react.dev `incompatible-library` rule](https://react.dev/reference/eslint-plugin-react-hooks/lints/incompatible-library)
- [React Compiler `DefaultModuleTypeProvider.ts` — canonical incompat list](https://github.com/facebook/react/blob/main/compiler/packages/babel-plugin-react-compiler/src/HIR/DefaultModuleTypeProvider.ts)
- [react-hook-form#11910 — `watch()` broken](https://github.com/react-hook-form/react-hook-form/issues/11910)
- [react-hook-form#12298 — interior mutability](https://github.com/react-hook-form/react-hook-form/issues/12298)
