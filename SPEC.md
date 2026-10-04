# Plan Editor — Spec

## What it is

A single self-contained HTML file (`index.html`) — SVG + vanilla
JavaScript, with the [polygon-clipping](https://github.com/mfogel/polygon-clipping)
library vendored inline — that runs locally by double-clicking. No install,
no server, no build step, works offline.

It's an interactive, editable floor-plan tool with any number of
**levels** sharing one coordinate frame. It ships with **no default floor
plan** — a new project starts with a single blank level ("Level 1"), and you
build a plan by adding rooms and levels in-app or opening a previously saved
`.json` file.

## Core model

- The plan is an ordered array of **levels**
  (`data = {levels:[...], activeLevelId}`). Each level is
  `{id, name, visible, points, walls, rooms}`: `id` is a unique string
  (`lvl0`, `lvl1`, ...), `name` is a user-editable display name, and
  `visible` controls whether the level is drawn as a shadow when it isn't the
  active level.
- Each level is a graph of **corner points** joined by **walls**, where
  walls are *derived* from room loops (a room is an ordered loop of point
  ids; an edge shared by two rooms is a single wall).
- Rooms that share a corner share the same point id — so moving a corner
  moves every wall anchored to it.
- All levels live in one coordinate frame (feet), so every other level
  marked `visible` can be shown beneath the active one as a shadow overlay
  (gated by the master "Show other levels as shadow" toggle).
- Coordinates are in feet; drawing is done at real-world scale.

## Features

### Editing

- Drag a corner (moves all anchored walls), drag a wall (slides the whole
  section, locked to its perpendicular axis, with ①/② badges showing which
  end moves), or drag a room by its name (moves the whole room).
- Edit a wall's exact length (choose which end stays fixed); edit a
  corner's X/Y; nudge rooms by the snap step.
- Add room, rename room (live), delete room, divide wall (insert a midpoint
  into all rooms sharing it), delete corner (shrinks a room, or deletes it
  below 3 corners with confirmation).
- Constrain a corner angle to 90° or a typed value, with a per-room
  dropdown (labeled by room name) to pick which room's corner when a point
  is shared. Applied once (not a live solver).

### Snapping

- Dragging a corner snaps to nearby corners, to wall lines (splits the wall
  into a T-junction on release), and to alignment guides (x/y). Dragging a
  room snaps its corners the same way. Snapped corners weld on release.
- Hold Alt to bypass snapping; Detach junction / Detach room to separate
  welded geometry and move it independently.

### Rooms & levels

- **Cut tool**: a selected room subtracts its shape from any overlapping
  rooms (boolean difference), adding boundary points so they conform;
  fully-covered rooms are removed; keeps the largest piece if a cut would
  split/hole a room.
- **Lock geometry**: freezes a room (detaches it, blocks moving it/its
  walls/corners, excludes it from snapping/welding) so moving a connected
  room can't reshape it.
- Level tabs in the titleblock (one per level; click to switch,
  double-click to rename, "+" adds a blank "Level N" and switches to it);
  cross-level shadow overlay of all other visible levels; toggles for shadow,
  dimensions, room names & area, grid, and snap step; fit-to-view; pan/zoom.
- Dimensions render inside each room so labels never overlap the neighbor
  across a shared wall.

### State

- Undo (lazy — only real changes; adding/renaming a level is undoable),
  Reset (back to a single blank level), and Save/Open JSON for local
  persistence. No browser storage is used — everything round-trips through
  a downloaded `.json` file.
- Saved JSON shape: `{name, schemaVersion, activeLevelId, levels:[...]}`
  (`name` is the project name; levels are stored without internal indices).
- **Schema versioning**: every persisted plan carries an integer
  `schemaVersion` (currently `CURRENT_SCHEMA_VERSION = 1`). Loading runs the
  object through `migrateData`, an ordered chain where `migrations[i]`
  upgrades version `i` to `i+1`; a file with no `schemaVersion` is version 0,
  the legacy two-floor `{main, basement}` shape, which migrates to two levels
  "Main" and "Basement" (Main active). To change the persisted shape, append
  a migration function and bump `CURRENT_SCHEMA_VERSION` — never change the
  shape silently. Files from a newer schema version are refused.

## Design

Drafting-table aesthetic: warm paper canvas, graphite active walls,
blueprint-blue shadow levels, drafting-red selection/markup, monospace
measurement readouts, and a titleblock header with a live
coordinate/length status readout.

## Known limits / open items

- Angle constraints (90° or typed) are one-shot, not persistent constraints
  — a live solver isn't implemented.
- Cut keeps only the largest piece when a cut would split a room or create
  a hole (the single-loop room model can't hold holes/multiple pieces).
- Point/room-id and level-id counters are synced on every load/build
  (`syncIds`), to avoid new points colliding with existing ids and
  corrupting unrelated rooms — this was a real bug that has since been
  fixed. Level ids get the same treatment, and duplicate/missing level ids
  in a loaded file are re-minted.

## Possible next steps (discussed, not built)

- Persistent/"keep-square" corner constraints.
- Cut that keeps every piece as its own room.
- Cross-level snapping/alignment; hard-linking shared exterior corners
  across levels.
- A richer level panel (list with per-level visibility eye toggles,
  reorder/delete levels).
- A "repair" scan to flag plans corrupted by the old point-id bug.
- Optional 3D view.
