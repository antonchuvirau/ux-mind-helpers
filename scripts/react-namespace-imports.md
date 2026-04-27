# react-namespace-imports

Converts `import * as React from "react"` to named imports. Aliases DOM event types used generically (e.g. `React.MouseEvent<T>`) to `ReactMouseEvent` so they do not shadow the global DOM types that `document.addEventListener` relies on.

## What it does

Four passes over each file:

1. **Namespace flatten** — `import * as React` becomes `import { useState, useCallback, ... }`. Members used generically from `DOM_EVENT_TYPES` get the `ReactX` alias; non-generic uses keep the bare name and resolve to the global DOM type.
2. **Rewrite already-converted files** — files with bare DOM-event types imported from React have their generic usages aliased to `ReactX`; non-generic DOM-event imports are removed (global DOM type takes over).
3. **Fill missing aliases** — generic `X<T>` usages without a corresponding React import get a `ReactX` alias added.
4. **Rewrite JSX handler params** — `(event: MouseEvent) =>` becomes `(event: ReactMouseEvent<HTMLElement>) =>` when the handler is bound to a JSX `on*` prop. Guarded against `addEventListener` / `element.on*` assignments so genuine DOM handlers stay bare.

Covered DOM event types: `AnimationEvent`, `ClipboardEvent`, `CompositionEvent`, `DragEvent`, `FocusEvent`, `InputEvent`, `KeyboardEvent`, `MouseEvent`, `PointerEvent`, `TouchEvent`, `TransitionEvent`, `UIEvent`, `WheelEvent`.

## Usage

```bash
# Interactive: scan, review, prompt [Y/n]
pnpm dlx github:antonchuvirau/ux-mind-helpers react-namespace-imports

# Scoped to a subdirectory
pnpm dlx github:antonchuvirau/ux-mind-helpers react-namespace-imports --src app

# CI check (exits 1 if changes pending, never writes)
pnpm dlx github:antonchuvirau/ux-mind-helpers react-namespace-imports --dry-run

# CI fix (auto-apply without prompt)
pnpm dlx github:antonchuvirau/ux-mind-helpers react-namespace-imports --yes
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `-s, --src <dir>` | `.` | Directory to scan. |
| `-e, --ext <list>` | `.ts,.tsx,.js,.jsx,.mjs,.cjs,.mts,.cts` | Comma-separated extensions to include. |
| `--skip <list>` | `node_modules,.next,.turbo,.git,dist,out,coverage` | Directory names to skip. |
| `--dry-run` | off | Print changes and exit 1; never prompt, never write. |
| `-y, --yes` | off | Apply without prompting. Required in non-interactive shells. |
| `-h, --help` | — | Show help. |

## Example

Before:

```tsx
import * as React from "react";

function Button() {
  const onClick = React.useCallback((event: MouseEvent) => {
    event.preventDefault();
  }, []);
  return <button onClick={onClick}>x</button>;
}
```

After:

```tsx
import { type MouseEvent as ReactMouseEvent, useCallback } from "react";

function Button() {
  const onClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
  }, []);
  return <button onClick={onClick}>x</button>;
}
```
