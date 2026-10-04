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
3. **Wall thickness** — per-level default + per-wall override, standard
   presets (2x4+drywall, 2x6+drywall), interior-offset dimensions/area, plus
   an `open` flag for open-concept (no-wall) edges and the generalized
   `remapWallRefs` re-keying infrastructure that item 4 and item 5 both need.
4. **Wall openings** — doors/windows/sliding doors, built on item 3's
   `wallProps`/`remapWallRefs` infrastructure.
5. **Room-relative object placement** — furniture/fixture catalog, with
   optional wall-anchored placement (distance + position derived from a
   host wall's interior face). Sequenced **after** items 3-4, not before —
   see "Item 5" below for why.
6. **Local storage autosave** — debounced, reuses `schemaVersion`/`migrateData`.
7. **Hamburger menu + multi-project switcher** — backed by item 6.

(Numbering above reflects final build order. Items 3-5 were reordered from
an earlier draft of this roadmap after a second architecture review found
object placement and wall openings both need infrastructure that wall
thickness introduces — see each item's section for the reasoning.)

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

## Bug fix bundled with item 2 — connected rooms must move together

**Confirmed bug in existing (shipped) behavior**, queued here rather than
fixed immediately because the fix touches the exact whole-room-drag code in
`js/app.js` that both the in-flight cleanup commit (0.5) and item 2's
interaction-dispatch rewrite are already restructuring — fixing it
separately right now risks a throwaway merge conflict.

**Root cause:** dragging a room by its name (whole-room translate) and
nudging a room (arrow keys) both currently move only that room's own
`room.loop` points. When two rooms are welded along a shared wall, the
shared corners belong to *both* rooms' loops — so translating one room's
loop drags the shared corners away from the neighboring room's other
(unshared) corners, stretching/distorting the neighbor instead of leaving
its shape intact.

**Fix:** before translating, compute the full connected component of rooms
transitively sharing welded points with the dragged room (flood-fill /
union-find over shared point ids across all rooms in the level — not just
direct neighbors, since a chain of 3+ welded rooms should all move together).
Translate every point in that unioned set by the same `{dx,dy}` delta,
instead of just the dragged room's own loop. Apply this to both the
whole-room drag gesture and `nudgeRoom`. **Respect locked rooms**: per the
existing "Lock geometry" feature, a locked room's points can't be moved —
stop the flood-fill from propagating through a point that belongs to a
locked room (the dragged room's cluster should stop at a locked neighbor's
shared wall, not drag it along or silently skip it).

**Cross-reference for item 5 (object placement):** once this lands, a
whole-room drag can move *multiple* rooms in one gesture. Item 5's "free
objects carry along by the room's `{dx,dy}` on `roomDrag`/`nudgeRoom`" rule
must apply per-room across the entire moved cluster, not just the directly-
dragged room — otherwise furniture in a connected neighbor room would be
left behind while its room's walls move out from under it.

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
- **On completing a room (either tool), immediately put the room-name field
  into edit mode, focused and ready to type** — no extra click to select it
  first. Apply the same fix to the existing "+ New room" button at the same
  time (same underlying selection/inspector-render path, currently just
  missing the focus step) — don't ship two different behaviors for
  "a room was just created" depending on which entry point made it.
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

## Item 3 — wall thickness + `wallProps` + `remapWallRefs`

`level.wallProps`, keyed by a **canonicalized endpoint-id pair** (sort the
two point ids so the key doesn't depend on which room's loop created the
wall — don't key off `w.a`/`w.b` directly, since `w.a` is arbitrary).
Holds `{thickness, open, openings:[...]}` per wall (openings populated in
item 4; `object.anchor` in item 5 references this same wall-key identity).

- **Unset thickness means "use the level default"** — don't eagerly copy the
  default into every wall's props, or changing the level default later won't
  propagate to walls that never got an explicit override.
- **`open` flag for open-concept (no-wall) edges** — a wall can be flagged
  `wallProps[key].open = true` instead of getting a full-length opening
  entry. Reasoning (from the second architecture review): a full-length
  "open passage" opening breaks the split/length-change rules below (every
  split point falls inside it; a length change leaves a stub or needs
  clamping), while a flag has no length and both problems vanish. Define
  `effThickness(w) = open ? 0 : (thickness ?? level.defaultThickness)` and
  use it everywhere thickness is consulted — an effective thickness of 0
  means the interior-offset code needs no special case (offset is to the
  centerline). Don't draw a wall line for an open edge, but keep a thin
  dashed hit-target on the active level so it stays selectable/draggable
  (hidden in the shadow view). Doors/windows can't be placed on an open
  wall (disallow in the inspector); if an edge with existing openings is
  later flagged open, hide (don't delete) those openings. On merge, the
  result is open only if both merged walls were.
- **Interior dimensions/area:** offset each wall's centerline inward by half
  its `effThickness`, direction determined by **that room's winding order**
  (signed area) — a shared wall has a different interior face per side, so
  the current single `dimension label → w.room` assumption needs to become
  per-side. Intersect adjacent offset lines for interior corners. Handle
  collinear-neighbor and T-junction cases explicitly — parallel offset lines
  don't intersect.
- **`remapWallRefs(level, op)`** — one generalized re-keying function
  covering *both* `wallProps` openings and item 5's `object.anchor`
  references, since both are just "a reference to a wall key plus an
  along-wall offset" and both need identical handling on every
  topology-changing operation:
  - *Split* (`divideWall`, `insertPointOnWall`): copy thickness/`open` to
    both halves. Assign each opening/anchor to whichever half contains its
    position (for an anchor, use the object's center), shifting the second
    half's offsets by the split position. Decide and document the policy
    for an opening that straddles the split point (clamp, reject, or keep
    on the larger half) — not yet decided, flag as an open call during
    implementation.
  - *Merge* (`weldPoints` or `deletePoint` collapsing two wall keys into
    one): concatenate openings/shift anchors' `along` by the first wall's
    length; pick one thickness (e.g. keep the first wall's); result is
    `open` only if both inputs were. Drop props entirely if a weld collapses
    a wall to zero length.
  - *Detach* (`detachRoom`, `detachCorner`): a previously-shared wall
    becomes two overlapping walls. Copy thickness/`open` to both, but
    assign any opening to only one side (duplicating it onto both would
    show two doors) — an object anchor follows the new wall key belonging
    to its own `roomId`.
  - *Wall gone entirely*: an anchor whose wall key no longer exists (or is
    no longer in its object's `roomId`'s loop) becomes unanchored — see
    item 5 — rather than erroring or orphaning data.
  - *Length changes* (wall-length edit): clamp an opening's **displayed**
    position if it would overhang a shortened wall; never mutate the stored
    offset data.
  - *Accepted gaps* (document, don't solve): openings are lost on edges that
    `cutRoom` recreates; openings/anchors can't span a T-junction.
- **Selection model:** `sel` needs to address an opening by
  `{wallKey, openingId}`. With `renderInspector` already refactored into a
  lookup table (cleanup commit), add `object` and `opening` as two more
  entries rather than more branches.

## Item 4 — wall openings

Doors (swing direction + a flip/mirror option for left/right-handed),
windows, and sliding doors. Each has an offset along its host wall, measured
from **the lower id of the wall's sorted endpoint pair** (stable regardless
of which room's loop defined `w.a`/`w.b`). Built entirely on item 3's
`wallProps`/`remapWallRefs` design above — no new wall-identity mechanism
needed. (Open-concept "no wall" edges are a `wallProps` flag from item 3,
not an opening type — see above.)

## Item 5 — room-relative object placement

**Sequenced after items 3-4, not before** (revised from an earlier draft of
this roadmap): a wall-anchored object's position depends on the wall's
*interior face*, which doesn't exist until item 3's thickness/`effThickness`
machinery lands, and reuses item 3's `remapWallRefs` wall-identity handling
directly rather than building a second mechanism. Building object anchors
before interior faces exist would mean every anchored object jumps by half
the wall's thickness once item 3 ships, unless migrated — not worth it when
reordering avoids the problem entirely.

**Why not plain absolute coordinates** (the original design for this item,
since revised): real placement intent is relative to a wall — "the island's
front edge is 42 inches from the wall behind it" — not a level-coordinate
pair. Absolute coordinates don't capture that, and don't follow the wall if
it moves.

**Why not a general constraint solver**: a single wall anchor per object
(no object-to-object anchors, no chains, no cycles) covers the realistic
case without building a solver. Object-to-object anchoring (e.g. "butt this
cabinet against its neighbor") is explicitly deferred — handle it as a
one-time snap-on-drop computed at drop time, not a stored, maintained
relationship.

**Data shape:**
```
level.objects = [{
  id, type, roomId, w, d, mirror,
  x, y, rot,          // free: authoritative. anchored: last-resolved cache, rewritten by resolveObjects()
  anchor: null | {
    wall:  "pA|pB",   // canonical sorted endpoint key — same identity as wallProps
    edge:  "back"|"front"|"left"|"right",  // which object edge faces the wall; fixes rot relative to the wall
    along: ft,        // object center along the wall, measured from the lower-id endpoint (same convention as openings)
    gap:   ft         // perpendicular distance from the wall's INTERIOR face on roomId's side to `edge`
  }
}]
```

- **Why a single perpendicular distance isn't enough on its own**: it fixes
  only one degree of freedom. `along` (position along the wall) and `rot`
  (derived from the wall's current angle) must also be tracked/derived, or
  the object stops being parallel to its wall as soon as that wall rotates
  via a corner drag.
- **`resolveObjects(level)`** runs after every commit and during drags,
  before render. For each anchored object, (re)computes `x`, `y`, `rot` from
  the wall's current geometry, the interior face on `roomId`'s side (via
  item 3's `effThickness`), and `edge`. The resolved values are cached in
  `x`/`y`/`rot` (not solved fresh on every read) so a vanished anchor leaves
  the object exactly where it last was.
- **Anchor becomes invalid** (wall key no longer exists, or no longer
  belongs to `roomId`'s loop) → set `anchor = null`. The object becomes a
  free object at its last resolved position — this uniformly covers a
  deleted, cut, or otherwise-vanished host wall, no special-case code needed.
- **`roomId` decides which face**: a shared wall has two interior faces;
  `roomId` says which one the gap is measured from, and also decides which
  side an anchor follows through a `detachRoom`/`detachCorner` operation.
- **Movement rules — never apply both to the same object:**
  - *Anchored* objects follow their wall automatically via `resolveObjects`
    — they do **not** need the whole-room-translate carry-along.
  - *Free* (unanchored) objects use the original movement rule: they move
    only on a whole-room translate (`roomDrag`/`nudgeRoom`, both of which
    already compute a clean `{dx,dy}` delta to carry them along by).
    Reshaping a room (corner/wall drag, divide, cut, length/angle edit)
    intentionally leaves a free object in place — correct behavior, not a
    limitation to document.
- **Dragging:**
  - *Anchored*: dragging edits `along`/`gap` in the wall's local frame, with
    snapping and a live readout (e.g. `42" from wall`). Never silently
    breaks the anchor — breaking it is an explicit "Unanchor" action in the
    inspector. Rotation is disabled while anchored (it's derived).
  - *Free*: drag/rotate freely as planned originally; the inspector shows a
    computed, **unstored** "distance to nearest wall" readout for reference.
- **Anchoring flow** (matches the CAD-style flow this was modeled on): an
  inspector "Measure from wall…" action enters a pick-wall interaction mode
  (one more entry in `tools.js`) — pick the object edge, then the wall, then
  type the gap. Optionally, dropping a free object within snap tolerance of
  a wall inside its room auto-anchors it.
- **Reparenting:** on drop, a point-in-polygon test against all rooms
  reassigns `roomId` (for both free and anchored objects — an anchored
  object's wall must belong to its new `roomId`'s loop, or it unanchors).
  Deleting a room deletes its objects (with confirmation) or sets
  `roomId = null` (orphaned) — decide which when implementing.
- **Out of scope for v1** (explicitly deferred, don't build): object-to-object
  anchors, more than one constraint per object, a general constraint solver.
- **Fallback if item 5 must ship before item 3 for some reason**: ship free
  placement only (`anchor` always `null`, field reserved in the schema), add
  anchoring once item 3/4 land. Do not ship anchors measured from the wall
  *centerline* and redefine their meaning later — that silently breaks saved
  data.
