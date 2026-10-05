# Plan Editor — Spec

## What it is

A static multi-file app (`index.html` plus its `css/` and `js/` folders) —
SVG + vanilla JavaScript, with the [polygon-clipping](https://github.com/mfogel/polygon-clipping)
library vendored under `js/vendor/` — that runs locally by double-clicking
`index.html` from the project folder (the folder has to travel together; it's
no longer a single file you can email on its own). No install, no server, no
build step, works offline.

It's an interactive, editable floor-plan tool with any number of
**levels** sharing one coordinate frame. It ships with **no default floor
plan** — a new project starts with a single blank level ("Level 1"), and you
build a plan by adding rooms and levels in-app or opening a previously saved
`.json` file.

## Core model

- The plan is an ordered array of **levels**
  (`data = {levels:[...], activeLevelId}`). Each level is
  `{id, name, visible, points, walls, rooms, wallProps, defaultThickness}`:
  `id` is a unique string (`lvl0`, `lvl1`, ...), `name` is a user-editable
  display name, and `visible` controls whether the level is drawn as a
  shadow when it isn't the active level.
- **Wall thickness**: each level has a `defaultThickness` (feet; 4.5" =
  2x4 + drywall for a new level). `wallProps` is a sparse dict keyed by the
  wall's canonical key (`wallKey(a,b)`: the two point ids sorted and joined
  with `|`; a wall's id is `"w_"+key`) holding per-wall overrides
  `{thickness?, open?, openings?}`. A wall without an explicit `thickness` inherits the
  level default. `open: true` marks an open-concept (no-wall) edge: it has
  zero effective thickness and never also stores a thickness.
  `effThickness(f,w)` is the single source of a wall's thickness. Topology
  edits re-key `wallProps` via `remapWallRefs` (split → both halves; weld /
  corner delete → merged wall keeps the first wall's thickness, is open only
  if all inputs were; detach → both sides), and `deriveWalls` prunes entries
  whose wall no longer exists. Cut doesn't carry props over to edges it
  recreates.
- **Wall openings**: `wallProps[key].openings = [{id, type, along, width,
  swing?, hand?, room?}]`. `type` is a `js/catalog.js` entry (door 3',
  window 3', sliding door 6', garage door 9' defaults). `along` is the
  distance from the key's lower (sorted) id endpoint to the opening's
  CENTER, in feet. Doors carry `swing` ("in" = toward the interior of
  `room`, "out" = away from it) and `hand` (hinge side as seen from the swing
  side, facing the wall); sliding doors reuse `hand` for the front panel.
  An opening must lie fully on its wall, at least 2" from any other opening
  on it; placement/edits move to the nearest position that fits and are
  refused if none does. Not allowed on open walls (flagging a wall open
  later hides, doesn't delete, its openings). Re-keying: split → the half
  holding the opening's center, re-based into that half's frame, trimmed at
  the split point if it straddled it; merge (weld / corner delete) → every
  contributor's openings concatenated, re-based into the merged wall's
  frame (direction flips handled), each to exactly one wall; detach → kept
  on the side that keeps the original ids when the wall is still shared,
  else moved (re-based) to the new key. A wall-length edit never changes
  stored offsets — an overhanging opening is only drawn clamped.
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
  end moves), or drag a room by its name (moves the whole room, together
  with every room welded to it — directly or through a chain of shared
  corners — so connected neighbours keep their shape; nudging does the
  same). A locked room is a hard boundary: it never moves, and an unlocked
  room still welded to it stays pinned at the shared corner.
- Overlapping geometry (e.g. coincident walls/corners left by Detach room /
  Detach junction): the first click selects what's on top; clicking again
  at the same spot (within 3px) selects the next wall/corner underneath,
  wrapping back to the top. A welded corner is a single point, so it never
  cycles. A selected wall faintly tints the room(s) it belongs to (subtler
  than a selected room's dashed outline).
- Edit a wall's exact length (choose which end stays fixed); edit a
  corner's X/Y; nudge rooms by the snap step. A View toggle switches
  between **centerline** length (endpoint to endpoint — the only option
  before this toggle existed) and **inside** length (a chosen adjacent
  room's interior clear length along that wall; a shared wall lets you pick
  which side). Typing a desired inside length solves for the exact
  centerline length that produces it (by search against the real interior
  geometry, not an approximation), so it's exact even at a corner where the
  relationship between the two lengths isn't linear. The toggle also
  controls the on-canvas dimension labels (one per wall at centerline, or
  one per adjacent room at interior length) and is a session preference,
  not saved with the plan.
- Draw a room: `N` is the rectangle tool (click two opposite corners);
  `Shift+N` is the freeform tool (click each corner — segments lock to
  horizontal/vertical unless Ctrl/Cmd is held — and click the first corner
  again to close; self-intersecting outlines are rejected). Both snap and
  weld onto existing corners/walls like a dragged corner (Alt bypasses),
  Esc cancels, and pressing the same key again exits the tool. New rooms
  are stored with a consistent winding (positive signed area in the y-down
  world frame, i.e. clockwise on screen).
- Add room, rename room (true in-place rename, same double-click pattern as
  the project/level name: double-click the name — in the Inspector, or its
  label on the plan — to edit, Enter commits, Escape reverts, blur commits;
  undoable. A newly added or drawn room enters this edit mode immediately,
  ready to type over), delete room, divide wall (insert a midpoint into all
  rooms sharing it), delete corner (shrinks a room, or deletes it below 3
  corners with confirmation).
- Wall thickness: the sidebar "Walls" section sets the active level's
  default (2x4 + drywall 4.5", 2x6 + drywall 6.5", or a custom value; a bare
  number is inches). The wall inspector shows the wall's effective thickness
  and whether it comes from the level default or an override, lets you pick
  "Use level default", a preset, or a custom override, and has an "Open (no
  wall)" toggle (which disables the override). Walls draw as bands at their
  real thickness (square caps, minimum on-screen width); on the active
  level each band is clipped to its adjacent rooms' interior faces, so
  interior corners read as clean miters at any angle (exterior corners are
  still square-capped). Open edges draw as a thin dashed line with a wider
  invisible hit target, and aren't drawn in the shadow view. All of these
  are undoable.
- Wall openings: the wall inspector lists the wall's openings (click to
  select, ✕ to delete) and has "+ Door / Window / Sliding door / Garage
  door" buttons that place one at the wall's center (or the nearest free
  spot) and select it. The opening inspector edits center offset and width,
  swing (labeled by room: "Into Kitchen" / "Outward") and hinge side, and
  can delete it. On the plan each opening knocks a gap in the wall band with
  jamb ticks and a type symbol (door leaf + swing arc, window frame/glass
  lines, two offset sliding panels, dashed overhead garage door); drag it to
  slide it along its wall (grid-snapped, Alt bypasses; stops at the wall ends
  and 2" from neighbours). All undoable. Openings aren't drawn in the shadow
  view.
- Fixtures & furniture: `level.objects = [{id, type, roomId, w, d, mirror,
  x, y, rot, anchor}]` from the `js/catalog.js` fixture list, sized per
  instance. A free object (`anchor: null`) is dragged freely (grid-snapped),
  is reparented to the room containing it on drop, and moves with a
  whole-room translate/nudge of any room in its welded cluster; reshaping a
  room leaves it in place. An **anchored** object has
  `anchor = {wall, edge, along, gap}`: `wall` is a wall key, `edge` is the
  object edge facing it (`back`/`front` = its local depth ends `ld = ∓d/2`,
  `left`/`right` = its local width ends `lx = ∓w/2`, before mirroring),
  `along` is the object's center along the wall from the key's lower id
  (the openings convention), and `gap` is the distance from the wall's
  interior face on `roomId`'s side to that edge. Its `x/y/rot` are a cache
  rewritten by `resolveObjects` after every change (so it follows the wall
  as it moves, tilts or changes thickness, and is never carried by a room
  translate); if the wall stops being an edge of `roomId`'s loop it becomes
  free where it last was. Anchors re-key through split/merge/detach like
  openings (detach and corner-delete keep it on its own room's wall).
  Anchor via the inspector's "Measure from wall…" (then click a wall of the
  object's room; the facing edge, current along and current gap are kept)
  or by dropping a squared-up free object flush against a wall (Alt
  bypasses). Dragging an anchored object edits only `along` (clamped to the
  wall) and `gap` (≥ 0), with a live `42" from wall` readout; rotation is
  locked while anchored, and "Unanchor" frees it in place. All undoable.
- Interior geometry: each room has an interior-offset polygon — every edge
  pushed toward that room's interior (decided by the room's own signed
  area, not an assumed winding) by half its wall's effective thickness,
  with corners at the intersection of adjacent offset lines (`roomInterior`
  / `offsetPolygon`). A (near-)collinear vertex, or an intersection more
  than 10× the half-thickness from the vertex, falls back to projecting the
  vertex onto each offset line. Room area (plan label and Inspector "Floor
  area (inside walls)") is this interior area (`interiorArea`); `polyArea`
  remains the centerline area.
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
- Level panel in the titleblock (dropdown listing every level; click a level
  to switch, an eye toggle per level controls its shadow visibility,
  double-click a name for true in-place rename, "+ Add level" adds a blank
  "Level N" and switches to it); cross-level shadow overlay of all other
  visible levels; toggles for shadow, dimensions, room names & area, grid,
  and snap step; fit-to-view; pan/zoom.
- Dimensions render inside each room so labels never overlap the neighbor
  across a shared wall: every room running along a wall gets its own label
  (`wallSides`) showing that room's interior clear length along it, so a
  shared wall shows two labels, which can differ.

### State

- Undo (lazy — only real changes; adding/renaming a level is undoable),
  Reset (back to a single blank level), and Save/Open JSON for local
  persistence. No browser storage is used — everything round-trips through
  a downloaded `.json` file.
- Saved JSON shape: `{name, schemaVersion, activeLevelId, levels:[...]}`
  (`name` is the project name; levels are stored without internal indices).
- **Schema versioning**: every persisted plan carries an integer
  `schemaVersion` (currently `CURRENT_SCHEMA_VERSION = 2`; v1 → v2 adds
  `wallProps: {}` and `defaultThickness` = 4.5" to every level). Loading runs the
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
- Openings are lost on edges that the cut tool recreates, and can't span a
  T-junction (a split point always lands them on one side).
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
- Level reorder/delete from the level panel.
- A "repair" scan to flag plans corrupted by the old point-id bug.
- Optional 3D view.
