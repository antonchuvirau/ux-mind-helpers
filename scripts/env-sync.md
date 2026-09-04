# env-sync

Format every `.env*` file from the env schema, and report cross-file drift — without ever printing a value.

## Why

Env files accumulate whatever order things were pasted in, and tidying one by hand means opening it — normally blocked so secrets stay out of context and scrollback. Worse, nothing knows what the full key set is *supposed* to be, so a variable added to one environment reaches the others only if someone remembers. The failures this catches are all silent today:

- A key assigned twice in one file — the last one wins, nothing warns.
- A **required** key missing from one environment, so that deploy fails at boot while the others are fine.
- A key set in an env file but never declared in the schema, so the app cannot read it no matter what it holds.
- A key declared in `server`/`client` but absent from `runtimeEnv` — invisible at runtime.

The schema file (`env.ts` by default) is the single source of truth for both the layout and the expected key set, so nothing is duplicated into this script.

## Usage

```bash
pnpm dlx github:antonchuvirau/ux-mind-helpers env-sync           # format every .env* in cwd
pnpm dlx github:antonchuvirau/ux-mind-helpers env-sync --check   # CI: exit 1 on drift, write nothing
ux-mind-helpers env-sync .env.local                              # only these files
ux-mind-helpers env-sync --scaffold                              # add missing required keys, empty
ux-mind-helpers env-sync --prune                                 # drop unknown AND empty keys
```

Wire it into the project:

```json
"env:check":  "pnpm dlx github:antonchuvirau/ux-mind-helpers env-sync --check",
"env:format": "pnpm dlx github:antonchuvirau/ux-mind-helpers env-sync"
```

## Options

| Option | Effect |
| --- | --- |
| `--check` | Exit 1 if any file is unformatted or parity fails. Writes nothing. |
| `--scaffold` | Also add each missing **required** schema key, with an empty value. |
| `--scaffold=all` | As above, including optional keys. |
| `--prune` | Also drop keys that are **both** absent from the schema **and** empty. |
| `--schema <path>` | Schema file to derive layout from. Default `env.ts`. |
| `--ignore <files>` | Comma-separated env files to skip. Default `.env.claude`. |
| `--cwd <path>` | Run as if invoked from `<path>`. |

Exit codes: `0` clean · `1` unformatted, missing required key, or duplicate key · `2` internal error (schema unreadable, or a rewrite that would change the key set).

## The safety property

The script must read the file to rewrite it. The guarantee is about **output**:

- **No value is ever printed, logged, or returned.** Only key names, counts and section titles. Asserted by the test suite.
- **Values are copied byte-for-byte** from the right of the first `=`. Quoting, whitespace, a `#` inside a value, multi-line values and dotenvx-encrypted blobs survive untouched.
- **A key absent from the schema is never dropped** — it lands under `Uncategorised`.
- **Nothing is written if the key set would change.** The rewrite is comments and order only; a round-trip that loses or gains a key aborts the file, untouched.

`--scaffold` and `--prune` are the only operations allowed to change a key set, which is why both are opt-in. Scaffolding only ever *adds*, and only with an empty value. Pruning only ever removes a key that is both unknown to the schema **and** empty — a key holding a value is relocated to `Uncategorised`, never deleted.

Backup copies (`.bak`, `.backup`, `.rescue`, `.orig`, `.save`, `.old`, `.tmp`) are skipped in a directory sweep. That guard exists because an earlier version reformatted a `.env.local.rescue` made moments before, which is exactly what a backup is for.

## Schema layout

Sections come from marker comments in the schema. Add them once:

```ts
server: {
  // ── Database
  // The primary connection string.
  DATABASE_URL: z.url(),

  // ── Stripe
  // Prefixes are documented and stable; length deliberately unpinned.
  STRIPE_SECRET_KEY: z.string().regex(STRIPE_SECRET_KEY_RE),
},
```

renders as:

```
# ── Database ──────────────────────────────────────────────────────────────────

# The primary connection string.
DATABASE_URL="postgresql://…"

# ── Stripe ────────────────────────────────────────────────────────────────────

# Prefixes are documented and stable; length deliberately unpinned.
STRIPE_SECRET_KEY="sk_test_…"
```

Key order follows declaration order in `server` then `client`. `NEXT_PUBLIC_*` keys reuse the same section titles, so a vendor's server and client halves render together.

## How the schema is parsed

Text, not an AST and not an import. It needs no TypeScript loader and cannot execute project code — and the two things the layout is built from (per-key comments and their grouping) are not reachable from a schema object anyway. Verified: t3-env's export enumerates key *names* only; the Zod schemas are not exposed, so optionality has to come from the text.

Four rules, each one a real case and each covered by a test:

- **`runtimeEnv` is never parsed.** It restates every key as `KEY: process.env.KEY`, so folding it into the same map overwrites each schema expression and reports every key as required.
- **A key's expression ends when it is bracket-balanced and terminated with `,`** — not at the next `KEY:`. Closing at the next key would swallow the comments and section markers sitting between two keys and attribute them to the key above.
- **A ternary counts as optional** if `.optional()` appears anywhere in it.
- **A `//` run directly above a key is that key's comment.** A blank line, a brace or a JSDoc block breaks the run.

`NODE_ENV` is excluded from the required set: the runtime supplies it, and no env file should set it.

### Generated keys

Some projects build keys at runtime rather than declaring them literally (e.g. spreading OAuth pairs from a provider list), which no text parser can see. Those keys are treated as unknown and render under `Uncategorised` rather than being lost. Declare them literally in the schema if you want them grouped.

## Tradeoffs

- **Extra keys never fail `--check`.** Tooling-only variables legitimately live in an env file without being in the app schema. They are always reported, never fatal.
- **Missing *optional* keys never fail.** Only a missing **required** key does.
- **`--check` reports; it does not fix.** Resolving a duplicate or adding a missing production key is a per-key decision, often against a live environment.
