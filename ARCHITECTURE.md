# Architecture & roadmap

Design doc for planned work on the plan editor. SPEC.md describes what's
shipped; this describes what's next and the reasoning behind it, so every
implementation step builds on the same assumptions instead of each subagent
re-deriving them. Describes the target design, not how it was decided —
keep entries prescriptive, and delete a roadmap item once it ships (shipped
behavior belongs in SPEC.md).

## Roadmap

3. **Wall thickness** — per-level default + per-wall override, standard
   presets (2x4+drywall, 2x6+drywall), interior-offset dimensions/area, plus
   an `open` flag for open-concept (no-wall) edges and the generalized
   `remapWallRefs` re-keying infrastructure that items 4 and 5 both need.
   *Shipped* — its section below stays as the reference items 4-5 build on.
4. **Wall openings** — doors/windows/sliding doors/garage doors, built on
   item 3's `wallProps`/`remapWallRefs` infrastructure. *Shipped* — see
   SPEC.md; "Item 4" below keeps only what item 5 reuses.
5. **Room-relative object placement** — furniture/fixture catalog, with
   optional wall-anchored placement (distance + position derived from a
   host wall's interior face). Depends on items 3-4 — see "Item 5" below.
   *Shipped* (free placement, then anchors) — see SPEC.md; the section
   below stays until it's trimmed to whatever later items still reuse.
6. **Local storage autosave** — debounced, reuses `schemaVersion`/`migrateData`.
7. **Hamburger menu + multi-project switcher** — backed by item 6.

(Numbering starts at 2.5 because earlier items have shipped and moved to
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
| `js/tools.js` | Interaction state machine: one `interaction = {kind, ...}` object + a handler table keyed by `kind`, covering corner/wall/room drags, pan, and the `N`/`Shift+N` room-drawing tools. Items 3 and 5 add more `kind`s here (a pick-wall mode, etc.) rather than growing `js/app.js`'s dispatch. |
| `js/catalog.js` | Extensible array of placeable types. Today `OPENING_TYPES` (`{type, label, defaultWidth, fields, draw(g,k)}`, item 4); item 5 adds room fixtures (`{type, label, w, d, draw}`). Loaded after `state.js`, before `render.js`/`inspector.js`. |
| `js/geometry.js` *(optional, item 3)* | Pure math apart from topology: signed area, offset-line intersection, point-in-polygon, self-intersection checks. Needed by thickness, drawing-tool validation, and object room-reparenting. |
| `js/storage.js` *(item 6)* | Or fold into `persist.js` — local-storage autosave, reusing `migrateData`. |
| `js/nav.js` *(item 7)* | Hamburger menu / project switcher. |
| `test/` | Committed test suite (`npm test`, zero dependencies). Add tests here alongside any change to testable logic (model, geometry, persistence, interaction handlers) — see CONTRIBUTING.md. |

## Item 3 — wall thickness + `wallProps` + `remapWallRefs`

**Status:** shipped (see SPEC.md): `wallKey`, `wallProps`, `effThickness`,
the `open` flag, `remapWallRefs` threaded through divideWall /
insertPointOnWall / weldPoints / deletePoint / detachRoom / detachCorner,
orphan pruning in `deriveWalls`, schema v2, the inspector and level-default
UI, band rendering at real thickness, and the interior geometry
(`offsetPolygon` / `roomInterior` / `interiorArea` / `wallSides` in
`js/model.js`: interior-offset polygons, per-side dimension labels,
interior area, miter-clipped bands). What remains here is reference for
item 5 (item 4 filled in the `openings` handling in `remapWallRefs`), and
item 5's anchors measure from the interior face that
`roomInterior(f, room).edges[i]` already exposes (`a`, `b`, inward `n`,
`half`).

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
- **Selection model:** an opening is `sel = {type:"opening", id, wallKey}`
  (shipped); item 5 adds an `object` entry to `renderInspector`'s table.

## Item 4 — wall openings

**Status:** shipped (see SPEC.md). What item 5 should reuse rather than
rebuild, all in `js/model.js`:

- `wallFrame(f, key)` / `alongToWorld` / `worldToAlong` — the lo→hi frame an
  `along` offset is measured in (lo = the lower id of the SORTED key, not
  `w.a`).
- `rebaseAlong(f, fromKey, along, toKey)` — maps an offset through a re-key
  geometrically (world point → projection), which is how `remapWallRefs`
  handles orientation flips and positional shifts for split, merge and
  detach. Anchors should go through the same function in the same branches.
- Split assigns by CENTER (anchors: the object's center), matching what
  item 5 specifies.

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
  - *Free* (unanchored) objects move only on a whole-room translate (the
    `room`-kind interaction in `js/tools.js`, or `nudgeRoom`) — both already
    compute a `connectedRoomPoints()` cluster and a `{dx,dy}` delta; carry a
    free object along whenever its `roomId` is in that cluster's `roomIds`,
    not just when its own room is the one directly dragged. Reshaping a room
    (corner/wall drag, divide, cut, length/angle edit) leaves a free object
    in place.
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
