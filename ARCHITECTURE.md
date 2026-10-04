# Architecture & roadmap

Living design doc for planned work on the plan editor. SPEC.md describes
what's shipped; this describes what's next and the decisions behind it, so
every implementation step builds on the same assumptions instead of each
subagent re-deriving them. Update this file as decisions change — don't let
it go stale.

## Roadmap (in order)

0. **File split** — single `index.html` into separate CSS/JS files (classic
   `<script src>`, no ES modules, no build step — modules break the
   double-click/`file://` use case; see SPEC.md's offline goal).
0.5. **Cleanup commit** (see below) — land before new features build on top.
1. **Level selector UI** — panel replacing the tab row: click to switch, an
   eye toggle per level (shadow visibility), an add button, and
   double-click-to-rename as true in-place editing (no `prompt()` dialog).
2. **Room-drawing hotkeys** — `N` (rectangle) / `Shift+N` (freeform) tools.
3. **Room-relative object placement** — furniture/fixture catalog.
4. **Wall thickness** — per-level default + per-wall override, standard
   presets (2x4+drywall, 2x6+drywall), interior-offset dimensions/area.
5. **Wall openings** — doors/windows/sliding doors, built on item 4's
   `wallProps` infrastructure.
6. **Local storage autosave** — debounced, reuses `schemaVersion`/`migrateData`.
7. **Hamburger menu + multi-project switcher** — backed by item 6.

## File layout (post-split, with planned additions)

| File | Contents |
|---|---|
| `index.html` | Markup only + `<link>`/`<script src>` tags |
| `css/app.css` | Styles |
| `js/vendor/polygon-clipping.min.js` | Vendored lib, untouched |
| `js/model.js` | Pure geometry/topology: `buildLevel`, `deriveWalls`, `indexLevel`, `makeLevel`, `cutRoom`, `syncIds`, `polyArea`, `centroid`, `fmtFt`/`parseLen`, snapping-computation helpers. Also where `wallProps` re-keying lives (item 4), next to the topology ops it hooks into. |
| `js/persist.js` | `CURRENT_SCHEMA_VERSION`, `migrations`, `migrateData`, `stripIdx`, `loadData`, `freshData` |
| `js/state.js` | `data`, `sel`, `opts`, `view`, `history`, `snapshot`/`captureState`/`commitCaptured`/`undo`, `activeLevel`/`otherLevels` |
| `js/render.js` | `render`, `drawGrid`, `drawLevel`, coordinate transforms, `el(...)` |
| `js/inspector.js` | `renderInspector` as a lookup table keyed by selection type |
| `js/app.js` | Pointer/key event dispatch (routes to `js/tools.js` handlers), DOM wiring, startup |
| `js/tools.js` *(new, item 2)* | Interaction state machine: one `interaction = {kind, ...}` object + a handler table keyed by `kind`, replacing the `drag`/`wallDrag`/`roomDrag`/`pan` globals. Holds the rectangle and freeform room-drawing tools. Build this refactor as the **first commit of item 2** — items 2/3/5 add 8+ interaction modes, too many for ad-hoc if-chains. |
| `js/catalog.js` *(new, item 3, extended item 5)* | Extensible array of placeable types: `{type, label, w, d, draw(g,w,d)}` for fixtures (item 3) and openings (item 5). Load before `render.js`/`inspector.js`. |
| `js/geometry.js` *(new, optional, item 4)* | Pure math apart from topology: signed area, offset-line intersection, point-in-polygon, self-intersection checks. Needed by thickness, drawing-tool validation, and object room-reparenting. |
| `js/storage.js` *(new, item 6)* | Or fold into `persist.js` — local-storage autosave, reusing `migrateData`. |
| `js/nav.js` *(new, item 7)* | Hamburger menu / project switcher. |

## Cleanup commit (0.5) — required before item 2 starts

1. `esc()` helper — fixes an existing unescaped-`innerHTML` bug (room rename).
2. `commit()`/`markDirty()` helper centralizing the ~25 scattered
   `snapshot(); mutate; render()` call sites — needed before autosave (item 6)
   can hook a single place.
3. `loadData` refactored to a pure deserializer (returns new state rather than
   mutating the global `data`).
4. `renderInspector` split into a lookup table keyed by selection type — item
   4/5 add `object` and `opening` selection types, which should just be two
   more table entries, not more branches in one function.
5. **Serialization field list must be shared, not duplicated.** `stripIdx`
   and `loadData` each hardcode the same field list
   (`{id,name,visible,points,walls,rooms}`) independently. Any new per-level
   field (`objects`, `wallProps`, `defaultThickness`) will silently vanish
   from save/undo/autosave unless both lists are updated. Fix: one shared
   field list, or serialize everything not prefixed `_`.
6. **`syncIds` must scan every id-bearing collection generically**, not just
   points and rooms — object ids and opening ids need the same
   collision-avoidance treatment (this is the same bug class SPEC.md
   documents as already fixed once for points; don't reintroduce it for new
   id types).
7. **Keyboard handler needs an `isTypingTarget(e)` guard** (input/select/
   contenteditable) before any global shortcut fires — today Ctrl/Cmd+Z
   inside an inspector field triggers plan-undo instead of text-undo; adding
   `N`/`Shift+N` makes this worse (typing "N" in a room-name field would
   trigger the drawing tool). Use `e.code === "KeyN"` for reliable detection
   regardless of Shift. Esc priority: cancel an active tool first, then clear
   selection.

## Item 2 — room-drawing hotkeys

- `N`: rectangle tool. Crosshair cursor, click corner A, live preview
  rectangle, click corner B completes an axis-aligned 4-point room. Esc
  cancels.
- `Shift+N`: freeform tool. Click to place each vertex in sequence with a
  live preview edge. Each new segment defaults to axis-locked
  (horizontal/vertical) from the previous vertex; holding `Ctrl` while
  placing a vertex toggles that lock off for a free angle. **Completes only
  by clicking back on/near the starting vertex** — no Enter/double-click
  shortcut to finish an open polyline. Esc cancels.
- Implementation notes:
  - Ctrl+click triggers the native context menu on some platforms —
    `preventDefault` on `contextmenu` while a draw tool is active, and
    confirm cross-browser/Mac behavior before assuming Ctrl is the final
    modifier (Meta may be needed as a Mac alternative).
  - Walls/corners/room-labels have their own `pointerdown` handlers that
    `stopPropagation()` — while a draw tool is active, route all pointer
    events through the tool dispatcher first (e.g. disable `pointer-events`
    on existing geometry, or check `interaction.kind` before existing
    per-element handlers run) so clicking existing geometry doesn't start a
    drag instead of placing a vertex.
  - Lock the axis before computing snap, then snap only along the locked
    axis. Create new vertices through the existing point-creation path so
    they join/weld onto existing corners like any other point.
  - Validate freeform shapes: reject fewer than 3 vertices or
    self-intersecting edges.
  - New loops should use a consistent winding order. Item 4's interior-offset
    code must use signed area regardless, since older data and `cutRoom`
    output aren't guaranteed to follow it.

## Item 3 — room-relative object placement

**Data shape:** `level.objects = [{id, type, roomId, x, y, w, d, rot, mirror}]`
— absolute level coordinates plus a parent `roomId`. Rotation is an
independent SVG `transform`, unrelated to the room's own geometry.

**Why not anchored to a room corner or centroid** (both considered and
rejected): a corner anchor drifts on any operation that moves that specific
corner — including a wall drag through it (roughly half of all wall drags
touch a rectangle's first corner), `deletePoint` changing which corner is
first, and `cutRoom` rebuilding loops starting at an arbitrary vertex (a full
jump, not a drift). A centroid anchor is better but still moves on operations
like "Divide wall" that change the vertex count/positions without changing
the room's footprint. Absolute coordinates avoid both failure modes entirely.

**Movement rule:** objects move with their room **only on a whole-room
translate** — `roomDrag` and `nudgeRoom`, both of which already compute a
clean `{dx,dy}` delta; carry the room's objects along by that same delta.
Reshaping a room (corner drag, wall drag, length/angle edit, divide, cut)
intentionally leaves its objects in place — this is correct behavior, not a
limitation to document.

**Reparenting:** on drop, a point-in-polygon test against all rooms
reassigns `roomId`. Deleting a room deletes its objects (with confirmation)
or sets `roomId = null` (orphaned) — decide which when implementing.

**Sequencing note:** if fixtures should snap against walls (cabinets,
toilets flush to a wall), that wants interior wall faces, which don't exist
until item 4. Current plan: build item 3 without wall-snapping (room-level
snapping only, same as existing room drag), revisit wall-snapping as a
refinement after item 4 lands. (Alternative considered: move item 3 after
item 5 entirely — rejected for now to avoid delaying a simple, independent
feature behind the hardest remaining geometry work.)

## Item 4 — wall thickness + `wallProps`

`level.wallProps`, keyed by a **canonicalized endpoint-id pair** (sort the
two point ids so the key doesn't depend on which room's loop created the
wall — don't key off `w.a`/`w.b` directly, since `w.a` is arbitrary).
Holds `{thickness, openings:[...]}` per wall (openings populated in item 5).

- **Unset thickness means "use the level default"** — don't eagerly copy the
  default into every wall's props, or changing the level default later won't
  propagate to walls that never got an explicit override.
- **Interior dimensions/area:** offset each wall's centerline inward by half
  its thickness, direction determined by **that room's winding order**
  (signed area) — a shared wall has a different interior face per side, so
  the current single `dimension label → w.room` assumption needs to become
  per-side. Intersect adjacent offset lines for interior corners. Handle
  collinear-neighbor and T-junction cases explicitly — parallel offset lines
  don't intersect.
- **Per-operation `wallProps` rules** (needed for item 5's openings to
  survive topology edits, so design these now even though openings aren't
  populated yet):
  - *Split* (`divideWall`, `insertPointOnWall`): copy thickness to both
    halves. Assign each opening to whichever half contains it, shifting the
    second half's offsets by the split position. Decide and document the
    policy for an opening that straddles the split point (clamp, reject, or
    keep on the larger half) — not yet decided, flag as an open call during
    implementation.
  - *Merge* (`weldPoints` or `deletePoint` collapsing two wall keys into
    one): concatenate openings, shifting the second wall's offsets by the
    first wall's length; pick one thickness (e.g. keep the first wall's).
    Drop props entirely if a weld collapses a wall to zero length.
  - *Detach* (`detachRoom`, `detachCorner`): a previously-shared wall becomes
    two overlapping walls. Copy thickness to both, but assign any opening to
    only one side — duplicating it onto both would show two doors.
  - *Length changes* (wall-length edit): clamp an opening's **displayed**
    position if it would overhang a shortened wall; never mutate the stored
    offset data.
  - *Accepted gaps* (document, don't solve): openings are lost on edges that
    `cutRoom` recreates; openings can't span a T-junction.
- **Selection model:** `sel` needs to address an opening by
  `{wallKey, openingId}`. With `renderInspector` already refactored into a
  lookup table (cleanup commit), add `object` and `opening` as two more
  entries rather than more branches.

## Item 5 — wall openings

Doors (swing direction + a flip/mirror option for left/right-handed),
windows, and sliding doors. Each has an offset along its host wall, measured
from **the lower id of the wall's sorted endpoint pair** (stable regardless
of which room's loop defined `w.a`/`w.b`). Built entirely on item 4's
`wallProps`/openings design above — no new wall-identity mechanism needed.
