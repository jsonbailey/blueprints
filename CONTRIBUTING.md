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
