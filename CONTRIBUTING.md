# Contributing

## Commit messages

Commit titles (the first line) must follow
[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[optional scope]: <description>
```

Common types used in this repo:

- `feat` — a new feature
- `fix` — a bug fix
- `docs` — documentation only (README, SPEC, ARCHITECTURE, comments)
- `refactor` — code change that neither fixes a bug nor adds a feature
- `chore` — tooling, config, CI, `.gitignore`, etc.

Examples:

```
feat: add level selector panel with visibility toggles
fix: connected rooms no longer distort when a neighbor is moved
docs: record wall-thickness design in ARCHITECTURE.md
chore: ignore .claude/ agent worktree directory
```

Breaking changes to the saved-plan schema (see README.md's versioning
policy) should use `!` after the type/scope (e.g. `feat!: ...`) and explain
the break in the commit body.

The rest of the message body is free-form — explain *why*, not just *what*,
same as the existing history in this repo.

## Tests

```
npm test
```

(or directly: `node --test test/*.test.js`, Node 18+, no install needed —
the app and its test suite have zero npm dependencies; `package.json` exists
only to hold this script.)

The suite lives in `test/`:

- `test/dom-stub.js` / `test/harness.js` — a minimal, hand-rolled DOM/SVG
  stub and a loader that reads the real `<script src>` list out of
  `index.html` and executes all the app's files, in that exact order, inside
  a sandboxed Node `vm` context. `harness.js`'s `run(fn, ...args)` is the
  main thing test files use — see its doc comment for why it exists (the
  app's top-level `let`/`const` globals aren't visible as plain properties
  on the sandbox from outside, and values returned naively from the sandbox
  don't compare correctly with `assert.deepStrictEqual` since the sandbox is
  a separate JS realm).
- `test/*.test.js` — the actual tests, run via Node's built-in test runner.

**What this suite catches**: syntax errors, load-order bugs (a script using
something before it's defined), and wrong logic in pure functions — geometry
math, the data model, persistence/migration, and the interaction/drawing-
tool logic driven programmatically.

**What it does NOT catch** — be honest with yourself about this before
treating a green run as "verified": actual rendering correctness, CSS/
layout, real browser pointer-event/focus quirks (e.g. platform-specific
Ctrl+click behavior), or anything visual. A real manual check in an actual
browser is still worth doing for interaction-heavy changes.

When you add a feature that touches testable logic (the data model,
geometry, persistence, interaction handlers), add tests for it in the same
change — this suite is meant to accumulate, not be rebuilt from scratch by
whoever reviews the next thing.
