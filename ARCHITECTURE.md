# Architecture & roadmap

Design doc for planned work on the plan editor. SPEC.md describes what's
shipped; this describes what's next and the reasoning behind it, so every
implementation step builds on the same assumptions instead of each subagent
re-deriving them. Describes the target design, not how it was decided —
keep entries prescriptive, and delete a roadmap item once it ships (shipped
behavior belongs in SPEC.md).

## Roadmap

2. **Room-drawing hotkeys** — `N` (rectangle) / `Shift+N` (freeform) tools.
2.5. **Unify room naming with the double-click-in-place pattern** — see
   detailed section below.
3. **Wall thickness** — per-level default + per-wall override, standard
   presets (2x4+drywall, 2x6+drywall), interior-offset dimensions/area, plus
   an `open` flag for open-concept (no-wall) edges and the generalized
   `remapWallRefs` re-keying infrastructure that items 4 and 5 both need.
4. **Wall openings** — doors/windows/sliding doors/garage doors, built on
   item 3's `wallProps`/`remapWallRefs` infrastructure.
5. **Room-relative object placement** — furniture/fixture catalog, with
   optional wall-anchored placement (distance + position derived from a
   host wall's interior face). Depends on items 3-4 — see "Item 5" below.
6. **Local storage autosave** — debounced, reuses `schemaVersion`/`migrateData`.
7. **Hamburger menu + multi-project switcher** — backed by item 6.

(Numbering starts at 2 because earlier items have shipped and moved to
SPEC.md. Keep remaining numbers stable as items complete — don't renumber —
since they're cross-referenced throughout this document and in commit
messages.)

## File layout

| File | Contents |
|---|---|
| `index.html` | Markup only + `<link>`/`<script src>` tags |
| `css/app.css` | Styles |
| `js/vendor/polygon-clipping.min.js` | Vendored lib, untouched |
| `js/model.js` | Pure geometry/topology: `buildLevel`, `deriveWalls`, `indexLevel`, `makeLevel`, `cutRoom`, `syncIds`, `polyArea`, `centroid`, `fmtFt`/`parseLen`, snapping-computation helpers. `wallProps` re-keying (item 3) lives here too, next to the topology ops it hooks into. |
| `js/persist.js` | `CURRENT_SCHEMA_VERSION`, `migrations`, `migrateData`, `stripIdx`, `loadData`, `freshData` |
| `js/state.js` | `data`, `sel`, `opts`, `view`, `history`, `snapshot`/`captureState`/`commitCaptured`/`undo`, `commit`/`markDirty`, `activeLevel`/`otherLevels` |
| `js/render.js` | `render`, `drawGrid`, `drawLevel`, coordinate transforms, `el(...)` |
| `js/inspector.js` | `renderInspector` as a lookup table keyed by selection type |
| `js/app.js` | Pointer/key event dispatch, DOM wiring, startup |
| `js/tools.js` *(item 2)* | Interaction state machine: one `interaction = {kind, ...}` object + a handler table keyed by `kind`, replacing ad-hoc per-gesture globals. Holds the rectangle and freeform room-drawing tools. |
| `js/catalog.js` *(item 4, extended item 5)* | Extensible array of placeable types: `{type, label, w, d, draw(g,w,d)}` for wall openings (item 4) and room fixtures (item 5). Load before `render.js`/`inspector.js`. |
| `js/geometry.js` *(optional, item 3)* | Pure math apart from topology: signed area, offset-line intersection, point-in-polygon, self-intersection checks. Needed by thickness, drawing-tool validation, and object room-reparenting. |
| `js/storage.js` *(item 6)* | Or fold into `persist.js` — local-storage autosave, reusing `migrateData`. |
| `js/nav.js` *(item 7)* | Hamburger menu / project switcher. |

## Bug: connected rooms must move together

Dragging a room by its name (whole-room translate) and nudging a room
(arrow keys) must move every room transitively welded to it, not just the
dragged room's own `room.loop` points. When two rooms share a wall, the
shared corners belong to both rooms' loops — so translating only one room's
loop stretches the neighbor instead of carrying it along.

**Fix:** before translating, compute the full connected component of rooms
transitively sharing welded points with the dragged room (flood-fill /
union-find over shared point ids across all rooms in the level — not just
direct neighbors, since a chain of 3+ welded rooms should all move
together). Translate every point in that unioned set by the same `{dx,dy}`
delta. Apply to both the whole-room drag gesture and `nudgeRoom`. **Respect
locked rooms**: stop the flood-fill from propagating through a point that
belongs to a locked room — a locked room's points never move, and the
dragged cluster stops at a locked neighbor's shared wall rather than
dragging it along or silently detaching.

**Cross-reference for item 5:** once this is fixed, a whole-room drag can
move multiple rooms in one gesture. Item 5's "free objects carry along by
the room's `{dx,dy}` on `roomDrag`/`nudgeRoom`" rule must apply per-room
across the entire moved cluster, not just the directly-dragged room.

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
  first. The existing "+ New room" button gets the same fix — "a room was
  just created" must behave identically regardless of entry point.
- Implementation notes:
  - Ctrl+click triggers the native context menu on some platforms —
    `preventDefault` on `contextmenu` while a draw tool is active. Confirm
    cross-browser/Mac behavior before assuming Ctrl is the final modifier
    (Meta may be needed as a Mac alternative).
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
  - New loops use a consistent winding order. Item 3's interior-offset code
    must use signed area regardless, since older data and `cutRoom` output
    aren't guaranteed to follow it.

## Item 2.5 — unify room naming with the double-click-in-place pattern

Room naming should match the double-click-in-place pattern the project name
and level name already use, in both places the room name appears:

- **On the plan canvas**: the room name is rendered as SVG `<text>` (in
  `drawLevel`'s label group, `js/render.js`) — not an HTML element, so
  `contenteditable` doesn't apply directly to it. Double-clicking the
  on-canvas name needs a small HTML overlay (a plain `<input>` or a
  `contenteditable` `div`) positioned absolutely at the label's current
  screen coordinates (via the same `toScreen()` transform `drawLevel`
  already uses) when editing starts, removed when editing ends. Either
  track pan/zoom while the overlay is open, or simplest: disable
  pan/zoom while it's open, closing it on blur/Enter/Escape same as the
  level-rename pattern.
- **In the Inspector panel**: replace the `<input id="roomName">` with a
  plain text span showing the name, double-click to enter the same in-place
  edit mode (follow `startRenameLevel`'s control-flow pattern in
  `js/app.js`: Enter commits and blurs, Escape cancels and reverts, blur
  commits — not a live-every-keystroke update).
- **Room renames must go through `commit()`** (undoable, matching every
  other mutation) — not a direct mutation with no snapshot.
- **Supersedes item 2's room-creation-focus mechanism**: item 2 focuses
  `#roomName` as a plain input. Once this item lands, "immediately ready to
  type" instead means entering the new in-place-edit mode on the name
  display — update the post-creation behavior in both `addRoom()`
  (`js/app.js`) and the `N`/`Shift+N` tools' room-completion path to match.

## Item 3 — wall thickness + `wallProps` + `remapWallRefs`

`level.wallProps`, keyed by a **canonicalized endpoint-id pair** (sort the
two point ids so the key doesn't depend on which room's loop created the
wall — don't key off `w.a`/`w.b` directly, since `w.a` is arbitrary).
Holds `{thickness, open, openings:[...]}` per wall (openings populated in
item 4; `object.anchor` in item 5 references this same wall-key identity).

- **Unset thickness means "use the level default"** — don't eagerly copy the
  default into every wall's props, or changing the level default later won't
  propagate to walls that never got an explicit override.
- **`open` flag for open-concept (no-wall) edges** — a wall is flagged
  `wallProps[key].open = true` rather than getting a full-length opening
  entry, because a full-length opening would need special-case handling
  everywhere a wall's length or split point is touched (every split point
  would fall inside it; a length change would leave a stub), while a flag
  has no length and both problems vanish. Define
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
  its `effThickness`, direction determined by that room's winding order
  (signed area) — a shared wall has a different interior face per side, so
  dimension labels must be per-side, not a single `w.room` assumption.
  Intersect adjacent offset lines for interior corners. Handle
  collinear-neighbor and T-junction cases explicitly — parallel offset lines
  don't intersect.
- **`remapWallRefs(level, op)`** — one generalized re-keying function
  covering both `wallProps` openings and item 5's `object.anchor`
  references, since both are "a reference to a wall key plus an along-wall
  offset" and both need identical handling on every topology-changing
  operation:
  - *Split* (`divideWall`, `insertPointOnWall`): copy thickness/`open` to
    both halves. Assign each opening/anchor to whichever half contains its
    position (for an anchor, use the object's center), shifting the second
    half's offsets by the split position. Decide and document the policy
    for an opening that straddles the split point (clamp, reject, or keep
    on the larger half) when implementing.
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
    no longer in its object's `roomId`'s loop) becomes unanchored (see
    item 5) rather than erroring or orphaning data.
  - *Length changes* (wall-length edit): clamp an opening's **displayed**
    position if it would overhang a shortened wall; never mutate the stored
    offset data.
  - *Accepted gaps* (document, don't solve): openings are lost on edges that
    `cutRoom` recreates; openings/anchors can't span a T-junction.
- **Selection model:** `sel` needs to address an opening by
  `{wallKey, openingId}`. `renderInspector`'s lookup table gets `object` and
  `opening` as two more entries.

## Item 4 — wall openings

Doors (swing direction + a flip/mirror option for left/right-handed),
windows, sliding doors, and garage doors (same mechanism as a door — wide,
typically no swing arc to draw, just an opening-width marker on the wall —
but its own catalog entry since it reads differently on a plan and is the
clearance being checked against a parked car/truck from item 5's catalog).
Each has an offset along its host wall, measured from the lower id of the
wall's sorted endpoint pair (stable regardless of which room's loop defined
`w.a`/`w.b`). Built entirely on item 3's `wallProps`/`remapWallRefs` design —
no new wall-identity mechanism needed. (Open-concept "no wall" edges are a
`wallProps` flag from item 3, not an opening type.)

## Item 5 — room-relative object placement

**Catalog** (`js/catalog.js`, extensible array — adding an entry should
never require touching placement/rendering logic elsewhere): cabinets,
sink, stove, toilet, shower, tub, table, stairs, car, truck. Vehicles are
placed and fit-checked like any other fixture, just bigger, and are the
reason a garage-door catalog entry (item 4) exists. Use realistic default
dimensions a user can resize per-instance (`w`/`d` below are per-object, not
fixed by type): roughly 6' x 15' for a car, 6.5' x 20' for a truck, as a
reasonable starting box.

**Depends on items 3-4**: a wall-anchored object's position depends on the
wall's interior face (item 3's `effThickness`), and reuses item 3's
`remapWallRefs` wall-identity handling directly rather than building a
second mechanism.

**Design**: placement is anchored to a wall, not stored as a plain
absolute coordinate — real placement intent is relative to a wall ("the
island's front edge is 42 inches from the wall behind it"), and an object
anchored to a wall should follow it when the wall moves. A single wall
anchor per object (no object-to-object anchors, no chains, no cycles) is
the full scope — not a general constraint solver. Object-to-object
anchoring (e.g. "butt this cabinet against its neighbor") is out of scope;
handle it as a one-time snap-on-drop computed at drop time, not a stored,
maintained relationship.

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

- A single perpendicular distance (`gap`) isn't enough on its own — it
  fixes only one degree of freedom. `along` (position along the wall) and
  `rot` (derived from the wall's current angle) must also be
  tracked/derived, or the object stops being parallel to its wall once the
  wall rotates via a corner drag.
- **`resolveObjects(level)`** runs after every commit and during drags,
  before render. For each anchored object, (re)computes `x`, `y`, `rot` from
  the wall's current geometry, the interior face on `roomId`'s side (via
  `effThickness`), and `edge`. The resolved values are cached in `x`/`y`/`rot`
  (not solved fresh on every read) so a vanished anchor leaves the object
  exactly where it last was.
- **Anchor becomes invalid** (wall key no longer exists, or no longer
  belongs to `roomId`'s loop) → set `anchor = null`. The object becomes a
  free object at its last resolved position — this uniformly covers a
  deleted, cut, or otherwise-vanished host wall, no special-case code needed.
- **`roomId` decides which face**: a shared wall has two interior faces;
  `roomId` says which one the gap is measured from, and also decides which
  side an anchor follows through a `detachRoom`/`detachCorner` operation.
- **Movement rules — never apply both to the same object:**
  - *Anchored* objects follow their wall automatically via `resolveObjects`
    — they do not need the whole-room-translate carry-along.
  - *Free* (unanchored) objects move only on a whole-room translate
    (`roomDrag`/`nudgeRoom`, both of which already compute a clean `{dx,dy}`
    delta to carry them along by). Reshaping a room (corner/wall drag,
    divide, cut, length/angle edit) leaves a free object in place.
- **Dragging:**
  - *Anchored*: dragging edits `along`/`gap` in the wall's local frame, with
    snapping and a live readout (e.g. `42" from wall`). Never silently
    breaks the anchor — breaking it is an explicit "Unanchor" action in the
    inspector. Rotation is disabled while anchored (it's derived).
  - *Free*: drag/rotate freely; the inspector shows a computed, unstored
    "distance to nearest wall" readout for reference.
- **Anchoring flow**: an inspector "Measure from wall…" action enters a
  pick-wall interaction mode (one more entry in `tools.js`) — pick the
  object edge, then the wall, then type the gap. Optionally, dropping a
  free object within snap tolerance of a wall inside its room auto-anchors
  it.
- **Reparenting:** on drop, a point-in-polygon test against all rooms
  reassigns `roomId` (for both free and anchored objects — an anchored
  object's wall must belong to its new `roomId`'s loop, or it unanchors).
  Deleting a room deletes its objects (with confirmation) or sets
  `roomId = null` (orphaned) — decide which when implementing.
- **Out of scope**: object-to-object anchors, more than one constraint per
  object, a general constraint solver.
- **If item 5 ships before item 3** for some reason: ship free placement
  only (`anchor` always `null`, field reserved in the schema), add
  anchoring once item 3/4 land. Never ship anchors measured from the wall
  centerline and redefine their meaning later — that silently breaks saved
  data.
