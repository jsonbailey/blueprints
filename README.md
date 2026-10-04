# Plan Editor

An interactive, self-contained floor-plan editor — SVG + vanilla JavaScript,
no build step, no server. Open `index.html` directly, or use it hosted on
GitHub Pages:

**https://jsonbailey.github.io/blueprints/**

See [SPEC.md](SPEC.md) for the full feature set and data model.

## Status: pre-1.0

This project is under active development and its save-file schema (the
`.json` you get from "Save" / give to "Open", and the local-storage format)
is still changing as features land. Every saved file and local-storage
record carries a `schemaVersion`, and the app upgrades older versions
forward automatically — but **until v1.0, no effort is made to support
every intermediate schema forever**; migrations only need to cover the
versions that actually shipped.

Once the current round of work (levels, wall thickness, local storage,
multi-project support) lands and is verified, that will become **v1.0**.
From that point on:

- Schema changes bump `schemaVersion` and ship a migration function, so
  files/projects saved under any released version keep opening correctly.
- Breaking changes to the save format are called out explicitly in commit
  messages and release notes, not made silently.
