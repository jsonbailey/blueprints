"use strict";

/* =========================================================================
   Interactive plan editor
   Model: the plan is an ordered array of LEVELS (data.levels), one of which
   is active (data.activeLevelId). Each level is a graph of corner POINTS
   joined by WALLS. Rooms reference an ordered loop of point ids. Adjacent
   rooms that share a corner share the same point id, so dragging that corner
   moves every wall meeting there ("anchoring"). All levels live in one
   coordinate frame (feet), so inactive levels marked visible can be drawn
   beneath the active one as a shadow.
   ========================================================================= */

/* ---- Starting layout, in feet, for the single level a fresh project starts
   with ("Level 1"). Empty by default — use "+ New room" to add rooms, or Open
   a saved .json plan. Each entry, if you want to seed that level
   programmatically, is a rectangle [name, x, y, w, h, kind]. ---- */
const SEED_RECTS = [];

/* ---------- geometry helpers ---------- */
function snapInch(v){ return Math.round(v*12)/12; }      // author coords to nearest inch
const MERGE_TOL = 0.06;                                  // ft — only near-identical corners merge

let _pid = 0;                                            // global unique point/room-id counter
let _lid = 0;                                            // global unique level-id counter

/* Build a level's geometry ({points, walls, rooms}) from seed rectangles. */
function buildLevel(rects){
  const points = [];
  function getPoint(x,y){
    x = snapInch(x); y = snapInch(y);
    for(const p of points){ if(Math.hypot(p.x-x,p.y-y) <= MERGE_TOL) return p.id; }
    const id = "p"+(_pid++); points.push({id,x,y}); return id;
  }
  const rooms = [];
  rects.forEach((r,i)=>{
    const [name,x,y,w,h,kind] = r;
    const x2=x+w, y2=y+h;
    const a=getPoint(x,y), b=getPoint(x2,y), c=getPoint(x2,y2), d=getPoint(x,y2);
    rooms.push({id:"r"+i, name, kind:kind||"room", loop:[a,b,c,d]});
  });
  const f = {points, walls:[], rooms};
  return indexLevel(f);
}

/* Canonical wall identity: the two endpoint point ids, sorted, joined by "|".
   Independent of which room's loop (or which direction) produced the edge.
   This is the key of `level.wallProps` (item 3), and a wall's `id` is always
   "w_" + wallKey(a,b) — use wallKey()/wallKeyOf() rather than re-deriving
   the format anywhere else, so the two can never drift apart. */
function wallKey(a,b){ return [a,b].slice().sort().join("|"); }
function wallKeyOf(w){ return wallKey(w.a, w.b); }
function wallIdForKey(key){ return "w_"+key; }
function wallKeyFromId(id){ return String(id).slice(2); }

/* Walls are DERIVED from room loops: every edge of every room is a wall, and an
   edge shared by two rooms is one wall. Stable id keyed on the endpoint pair, so
   selection survives moves; topology edits just rebuild this.

   Also the single chokepoint that keeps `f.wallProps` free of orphans: every
   topology change ends in deriveWalls(), so any wallProps entry whose key is
   no longer a real wall is pruned here. Topology ops that want props to
   SURVIVE a re-key must call remapWallRefs() BEFORE this (while the old keys
   are still present), so the props are already on the new keys by the time
   the prune runs. */
function deriveWalls(f){
  const seen=new Map(); const walls=[];
  f.rooms.forEach(r=>{
    const L=r.loop;
    for(let i=0;i<L.length;i++){
      const a=L[i], b=L[(i+1)%L.length];
      if(a===b) continue;
      const key=wallKey(a,b);
      if(seen.has(key)) continue;
      const w={id:wallIdForKey(key), a, b, room:r.id}; seen.set(key,w); walls.push(w);
    }
  });
  f.walls=walls;
  pruneWallProps(f, seen);
  return f;
}

/* ---------- wall thickness / wallProps (ARCHITECTURE.md item 3) ----------
   level.wallProps = { [wallKey]: {thickness?, open?, ...} }. Sparse: a wall
   with no entry (or no `thickness`) uses level.defaultThickness, so changing
   the level default propagates to every wall without an explicit override.
   Invariant: an `open` wall never also stores a `thickness` (setWallOpen
   drops it), so the data is never ambiguous. Entries may carry more fields
   later (item 4 adds `openings:[...]`) — code here copies unknown fields
   through rather than assuming the shape is exactly {thickness, open}. */

/* Standard presets, in FEET (like every other length in the model). Nominal
   2x4 = 1.5"x3.5" actual, 2x6 = 1.5"x5.5"; plus 1/2" drywall on both faces. */
const WALL_PRESETS = [
  {id:"2x4", label:"2x4 + drywall", thickness:(3.5+2*0.5)/12},   // 4.5"  = 0.375 ft
  {id:"2x6", label:"2x6 + drywall", thickness:(5.5+2*0.5)/12},   // 6.5"  ≈ 0.5417 ft
];
/* Baseline level default (fresh levels, and levels loaded without one). */
const DEFAULT_WALL_THICKNESS = WALL_PRESETS[0].thickness;
const MAX_WALL_THICKNESS = 4;                            // ft — sanity bound for typed values

function isValidThickness(t){ return typeof t==="number" && isFinite(t) && t>0 && t<=MAX_WALL_THICKNESS; }

/* Parse a typed wall thickness. Unlike parseLen (where a bare number means
   feet), a bare number here means INCHES — nobody means a 5-foot wall when
   they type "5". Explicit units (5", 0' 5", 0.5') go through parseLen.
   Returns feet, or NaN if invalid/out of range. */
function parseThickness(str){
  if(str==null) return NaN;
  const s=String(str).trim();
  const t = /^\d+(?:\.\d+)?$/.test(s) ? parseFloat(s)/12 : parseLen(s);
  return isValidThickness(t) ? t : NaN;
}
/* Thickness for display, in inches (fmtFt rounds to whole inches, which
   would show 4.5" as 5"). */
function fmtThickness(ft){ return (+(ft*12).toFixed(2))+'"'; }

function wallPropsOf(f, w){ return f.wallProps ? f.wallProps[wallKeyOf(w)] : undefined; }
function isOpenWall(f, w){ const p=wallPropsOf(f,w); return !!(p && p.open===true); }
/* The explicit per-wall override, or null if the wall inherits the default. */
function wallThicknessOverride(f, w){ const p=wallPropsOf(f,w); return p && isValidThickness(p.thickness) ? p.thickness : null; }
/* THE effective thickness of a wall — the one function everything that
   cares about thickness (rendering, inspector, and item 3's later interior-
   offset geometry) must consult. Open → 0 (offset is to the centerline). */
function effThickness(f, w){
  if(isOpenWall(f,w)) return 0;
  const t=wallThicknessOverride(f,w);
  return t!=null ? t : f.defaultThickness;
}

/* Mutators — pure model edits; UI callers wrap them in commit(). */
function _tidyWallProps(f, key){
  const p=f.wallProps[key];
  if(p && !Object.keys(p).length) delete f.wallProps[key];
}
/* Set (t in feet) or clear (t==null) a wall's explicit thickness override.
   Refused (returns false) on an open wall — un-flag it first. */
function setWallThickness(f, w, t){
  if(isOpenWall(f,w)) return false;
  if(t!=null && !isValidThickness(t)) return false;
  if(!f.wallProps) f.wallProps={};
  const key=wallKeyOf(w);
  if(t==null){ if(f.wallProps[key]){ delete f.wallProps[key].thickness; _tidyWallProps(f,key); } }
  else { f.wallProps[key] = {...(f.wallProps[key]||{}), thickness:t}; }
  return true;
}
/* Flag/unflag a wall as open (no wall). Flagging drops any explicit
   thickness so an open wall never carries a stale, ambiguous value;
   un-flagging therefore returns the wall to the level default. */
function setWallOpen(f, w, open){
  if(!f.wallProps) f.wallProps={};
  const key=wallKeyOf(w);
  if(open){ const p={...(f.wallProps[key]||{}), open:true}; delete p.thickness; f.wallProps[key]=p; }
  else if(f.wallProps[key]){ delete f.wallProps[key].open; _tidyWallProps(f,key); }
}
function setDefaultThickness(f, t){
  if(!isValidThickness(t)) return false;
  f.defaultThickness=t; return true;
}

/* Drop every wallProps entry whose key isn't a wall in `liveKeys` (a Set or
   Map of wall keys — deriveWalls passes the one it just built). */
function pruneWallProps(f, liveKeys){
  if(!f.wallProps) return;
  for(const k of Object.keys(f.wallProps)) if(!liveKeys.has(k)) delete f.wallProps[k];
}

/* Wall key of every edge of a loop, by edge index (edge i = loop[i] →
   loop[i+1]); null for a zero-length edge (repeated id). Two loops that map
   elementwise (same length, point ids substituted) therefore pair up edge
   by edge — the basis of the "rekey" ops below. */
function loopWallKeys(loop){
  const out=[];
  for(let i=0;i<loop.length;i++){ const a=loop[i], b=loop[(i+1)%loop.length]; out.push(a===b?null:wallKey(a,b)); }
  return out;
}
function liveWallKeys(f){
  const s=new Set(); f.rooms.forEach(r=>loopWallKeys(r.loop).forEach(k=>{ if(k) s.add(k); })); return s;
}
/* Copy of a props entry without `openings` (JSON-safe deep copy). */
function _propsSansOpenings(p){ const c=JSON.parse(JSON.stringify(p)); delete c.openings; return c; }
function _cloneOpenings(p){ return p && Array.isArray(p.openings) ? JSON.parse(JSON.stringify(p.openings)) : []; }
/* Write a wall's openings list (sorted by position), or remove the field
   (and an entry left empty) when the list is empty. */
function _setOpenings(wp, key, list){
  if(!list.length){
    if(wp[key]){ delete wp[key].openings; if(!Object.keys(wp[key]).length) delete wp[key]; }
    return;
  }
  list.sort((a,b)=>a.along-b.along);
  wp[key]={...(wp[key]||{}), openings:list};
}
function _r6(v){ return Math.round(v*1e6)/1e6; }   // trim float noise from re-based offsets

/* ---------- wall openings (ARCHITECTURE.md item 4) ----------
   wallProps[key].openings = [{id, type, along, width, swing?, hand?, room?}]
   (sparse: a wall with none has no `openings` field).

   COORDINATE FRAME — the one thing every function below must agree on:
   a wall key "lo|hi" is the two endpoint ids sorted as STRINGS (wallKey), and
   `along` is the distance in feet from point `lo` toward point `hi` to the
   opening's CENTER (not its leading edge). Centered offsets make clamping
   and dragging symmetric: the span is [along - width/2, along + width/2].
   Note `lo` is NOT w.a (deriveWalls' w.a/w.b come from whichever loop met
   the edge first) — always go through wallFrame(f, key).

   - type:  a catalog type id (js/catalog.js OPENING_TYPES: door, window,
            sliding, garage).
   - width: feet.
   - swing: "in" | "out" (doors). "in" = toward the interior of `room`
            (a room id); "out" = the opposite side. `room` disambiguates a
            shared wall (both sides are a room interior) and survives every
            re-key (room ids never change). See openingSwingNormal().
   - hand:  "left" | "right" (doors; sliding doors reuse it cosmetically for
            which panel is in front). Hinge side as seen by someone standing
            on the side the door swings toward, facing the wall — so it is
            independent of the lo/hi orientation and never needs flipping
            when a re-key reverses a wall's canonical direction.

   Placement rules (addOpening/updateOpening, and the drag in js/tools.js):
   the whole span must lie within [0, wallLength], and two openings on one
   wall must be at least OPENING_MIN_GAP apart. A request that doesn't fit is
   moved to the NEAREST position that does (nearestOpeningSlot); if no
   position fits at all (wall too short, or full), it is REFUSED — creation
   never silently shrinks an opening's width. Openings can't be placed on an
   open wall; flagging a wall open later only hides its openings.

   Length edits never touch stored offsets: rendering clamps the DISPLAYED
   span to the current wall length (displayedOpening), so lengthening the
   wall again restores the stored position exactly. */
const OPENING_MIN_GAP = 2/12;      // ft — 2" minimum between openings on one wall
const OPENING_MIN_WIDTH = 0.5;     // ft
const OPENING_MAX_WIDTH = 40;      // ft — sanity bound for typed values

function isValidOpeningWidth(w){ return typeof w==="number" && isFinite(w) && w>=OPENING_MIN_WIDTH-1e-9 && w<=OPENING_MAX_WIDTH; }
function _ptAny(f, id){ return (f._pt && f._pt.get(id)) || (f.points||[]).find(p=>p.id===id) || null; }
/* A wall key's geometric frame: lo/hi ids and points, length, unit direction
   lo → hi. Points are looked up in f._pt, falling back to f.points, because
   topology ops call remapWallRefs before rebuilding the _pt index. */
function wallFrame(f, key){
  const [lo,hi]=String(key).split("|");
  const A=_ptAny(f,lo), B=_ptAny(f,hi); if(!A || !B) return null;
  const len=Math.hypot(B.x-A.x, B.y-A.y);
  const dir = len>1e-12 ? {x:(B.x-A.x)/len, y:(B.y-A.y)/len} : {x:1, y:0};
  return {key, lo, hi, A, B, len, dir};
}
function alongToWorld(fr, along){ return {x:fr.A.x+fr.dir.x*along, y:fr.A.y+fr.dir.y*along}; }
function worldToAlong(fr, P){ return (P.x-fr.A.x)*fr.dir.x + (P.y-fr.A.y)*fr.dir.y; }
/* Re-base an offset from one wall key's frame into another's by mapping it
   to the world point it denotes and projecting that onto the target wall.
   For a target collinear with the source this is exactly
     same direction:  along' = shift + along
     reversed:        along' = shift - along   (= shift' + (oldLen - along))
   where `shift` = the target-frame position of the source's `lo` point — the
   orientation flip and the positional shift both fall out of the projection
   (dir·dir' = ±1), so there is no separate "is it reversed?" branch to get
   backwards. For a non-collinear target (deletePoint on a real corner) it is
   the perpendicular projection of the opening's center. */
function rebaseAlong(f, fromKey, along, toKey){
  if(fromKey===toKey) return along;
  const a=wallFrame(f,fromKey), b=wallFrame(f,toKey);
  if(!a || !b) return along;
  return worldToAlong(b, alongToWorld(a, along));
}

function openingsAt(f, key){ const p=f.wallProps && f.wallProps[key]; return p && Array.isArray(p.openings) ? p.openings : []; }
function findOpening(f, key, id){ return openingsAt(f,key).find(o=>o.id===id) || null; }

/* Nearest center position to `desired` at which an opening of `width` fits
   on a wall of length `len` without overlapping (or coming within
   OPENING_MIN_GAP of) any opening in `list` other than `ignoreId`. null if
   no position fits. The feasible set is [width/2, len - width/2] minus one
   open "blocked" interval per other opening, so the answer is either the
   clamped desired point or an endpoint of one of those intervals. */
function nearestOpeningSlot(list, desired, width, len, ignoreId){
  const eps=1e-9, lo=width/2, hi=len-width/2;
  if(!(hi>=lo-eps)) return null;
  const blocks=(list||[]).filter(o=>o.id!==ignoreId)
    .map(o=>[o.along-o.width/2-OPENING_MIN_GAP-width/2, o.along+o.width/2+OPENING_MIN_GAP+width/2]);
  const ok=c=>c>=lo-eps && c<=hi+eps && blocks.every(([a,b])=>c<=a+eps || c>=b-eps);
  const cands=[Math.min(hi,Math.max(lo,desired)), lo, hi];
  blocks.forEach(([a,b])=>cands.push(a,b));
  let best=null;
  for(const c of cands) if(ok(c) && (best==null || Math.abs(c-desired)<Math.abs(best-desired)-eps)) best=c;
  return best==null ? null : Math.min(hi, Math.max(lo, best));
}

/* What to DRAW for an opening on a wall that is currently `len` long: the
   stored span clamped into [0, len] (width first, then center). Never writes
   back — see "Length edits" above. */
function displayedOpening(o, len){
  const width=Math.max(0, Math.min(o.width, len));
  const along=Math.min(len-width/2, Math.max(width/2, o.along));
  return {along, width, clamped: Math.abs(width-o.width)>1e-9 || Math.abs(along-o.along)>1e-9};
}

/* Create an opening on wall w. spec = {type, width?, along?, swing?, hand?,
   room?}; width defaults to the catalog's defaultWidth, along to the wall's
   midpoint. Returns the new opening, or null if refused (open wall, unknown
   type, bad width, or no position on the wall fits — see placement rules). */
function addOpening(f, w, spec){
  if(!w || isOpenWall(f,w)) return null;
  const def=openingTypeDef(spec && spec.type); if(!def) return null;
  const key=wallKeyOf(w), fr=wallFrame(f,key); if(!fr) return null;
  const width = spec.width!=null ? spec.width : def.defaultWidth;
  if(!isValidOpeningWidth(width)) return null;
  const along=nearestOpeningSlot(openingsAt(f,key), spec.along!=null ? spec.along : fr.len/2, width, fr.len);
  if(along==null) return null;
  const o={id:"op"+(_pid++), type:def.type, along:_r6(along), width};
  if(def.fields.includes("swing")){
    o.swing = spec.swing==="out" ? "out" : "in";
    const sides=wallSides(f, {a:fr.lo, b:fr.hi});
    const room = spec.room && sides.some(s=>s.room.id===spec.room) ? spec.room : (sides.length ? sides[0].room.id : null);
    if(room) o.room=room;
  }
  if(def.fields.includes("hand")) o.hand = spec.hand==="right" ? "right" : "left";
  if(!f.wallProps) f.wallProps={};
  _setOpenings(f.wallProps, key, [...openingsAt(f,key), o]);
  return o;
}

/* Edit an opening in place. patch may set along, width, swing, hand, room.
   along/width go through the same placement rules as creation (moved to the
   nearest fitting position; refused if nothing fits). Returns true if the
   edit was applied (possibly adjusted), false if refused. Refused on an
   open wall (its openings are hidden). */
function updateOpening(f, key, id, patch){
  const o=findOpening(f,key,id); if(!o) return false;
  const fr=wallFrame(f,key); if(!fr) return false;
  if(isOpenWall(f,{a:fr.lo,b:fr.hi})) return false;
  if(patch.along!=null || patch.width!=null){
    const width = patch.width!=null ? patch.width : o.width;
    if(!isValidOpeningWidth(width)) return false;
    const want = patch.along!=null ? patch.along : o.along;
    if(typeof want!=="number" || !isFinite(want)) return false;
    const slot=nearestOpeningSlot(openingsAt(f,key), want, width, fr.len, id);
    if(slot==null) return false;
    o.width=width; o.along=_r6(slot);
  }
  if(patch.swing==="in" || patch.swing==="out") o.swing=patch.swing;
  if(patch.hand==="left" || patch.hand==="right") o.hand=patch.hand;
  if(typeof patch.room==="string") o.room=patch.room;
  f.wallProps[key].openings.sort((a,b)=>a.along-b.along);
  return true;
}
function removeOpening(f, key, id){
  const list=openingsAt(f,key); if(!list.some(o=>o.id===id)) return false;
  _setOpenings(f.wallProps, key, list.filter(o=>o.id!==id));
  return true;
}

/* Unit normal (world) pointing to the side a door swings toward. The
   reference side is `room`'s interior: its interior-face inward normal if it
   runs along the wall (the robust case — roomInterior decides inward by the
   room's own winding); else, if that room still exists but no longer touches
   this wall (e.g. after a detach moved the door to the neighbour's copy of
   the wall), whichever side of the wall its centroid lies on, so the door
   keeps swinging the same way physically; else the first adjacent room;
   else the wall's left-hand normal. "out" negates it. */
function openingSwingNormal(f, key, o, interiors){
  const fr=wallFrame(f,key); if(!fr) return {x:0,y:1};
  const left={x:fr.dir.y, y:-fr.dir.x};
  const sides=wallSides(f, {a:fr.lo, b:fr.hi}, interiors).filter(s=>s.side);
  let n=null;
  const own=o.room && sides.find(s=>s.room.id===o.room);
  if(own) n=own.side.n;
  else {
    const r=o.room && f.rooms.find(r=>r.id===o.room);
    if(r){ const c=centroid(f,r.loop); const d=(c.x-fr.A.x)*left.x+(c.y-fr.A.y)*left.y;
      if(Math.abs(d)>1e-9) n = d>0 ? left : {x:-left.x, y:-left.y}; }
    if(!n && sides.length) n=sides[0].side.n;
    if(!n) n=left;
  }
  return o.swing==="out" ? {x:-n.x, y:-n.y} : {x:n.x, y:n.y};
}

/* Normalize a persisted openings array (loadWallProps): entries need a
   string id, a string type, finite along and a positive finite width;
   optional swing/hand/room are kept only when well-formed. */
function sanitizeOpenings(v){
  if(!Array.isArray(v)) return [];
  const out=[];
  v.forEach(o=>{
    if(!o || typeof o!=="object" || typeof o.id!=="string" || !o.id || typeof o.type!=="string") return;
    if(typeof o.along!=="number" || !isFinite(o.along) || typeof o.width!=="number" || !isFinite(o.width) || o.width<=0) return;
    const c={id:o.id, type:o.type, along:o.along, width:o.width};
    if(o.swing==="in" || o.swing==="out") c.swing=o.swing;
    if(o.hand==="left" || o.hand==="right") c.hand=o.hand;
    if(typeof o.room==="string") c.room=o.room;
    out.push(c);
  });
  return out;
}

/* Merge the NON-opening props of several walls collapsing into one key.
   `list` is in priority order (the first is "the first wall"); undefined = a
   wall with no entry (defaults: inherits thickness, not open). Rules
   (ARCHITECTURE.md):
   - thickness: the first contributor that has an explicit override wins;
   - open: only if EVERY contributor was open (then no thickness kept);
   - any other field: first contributor that has it wins.
   `openings` are deliberately NOT handled here: concatenating them needs
   each contributor's geometry to re-base offsets into the merged wall's
   frame, which remapWallRefs's merge branch does. */
function mergeWallProps(list){
  const out={};
  for(let i=list.length-1;i>=0;i--) if(list[i]) Object.assign(out, _propsSansOpenings(list[i]));
  const tSrc=list.find(p=>p && isValidThickness(p.thickness));
  if(tSrc) out.thickness=tSrc.thickness; else delete out.thickness;
  if(list.length && list.every(p=>p && p.open===true)){ out.open=true; delete out.thickness; }
  else delete out.open;
  return out;
}

/* Re-key wall references (wallProps + its openings, and item 5's object
   anchors via _remapAnchors — see there for the per-op anchor rules) across
   a topology change. Must run AFTER room loops are rewritten but BEFORE the
   deriveWalls() that ends the op (whose prune removes the now-dead old keys),
   and while every old endpoint point still exists in f.points (callers gc
   points afterwards) — openings are re-based geometrically (rebaseAlong), so
   both the old and the new endpoints' coordinates are needed.
   This function only ever WRITES new keys; deleting dead ones is left to the
   prune, so a key that is still a live wall (e.g. the neighbour's side of a
   detached shared wall) keeps its props automatically.

   op shapes:
   - {kind:"split", a, b, mid}: wall a|b gained point `mid` (divideWall,
     insertPointOnWall). Both halves get a copy of thickness/open. Each
     opening goes to the half containing its CENTER (s = mid's position in
     the old wall's frame; center < s → the half touching `lo`, else the
     other — a center exactly on the split goes to the `hi` half), re-based
     into that half's own lo/hi frame.
     STRADDLING POLICY (deliberate): an opening whose span crosses the split
     point is kept on its center's half and TRIMMED at the split point — the
     part inside the half stays exactly where it was in world space, the part
     past the new corner is cut off. Since the center is inside the half, at
     least half the width always survives. Chosen over shifting it whole into
     the half (which would silently move a door) and over rejecting the split
     (dividing a wall must never be blocked by a door). Only the split side
     is trimmed: an end already overhanging from an earlier length edit is
     left as stored (display-clamped), per the length-edit rule.
   - {kind:"detach", pairs:[[oldKey,newKey],...]}: a wall was duplicated
     onto fresh point ids (detachRoom, detachCorner). The new key gets a
     copy of thickness/open; openings move to the new key only if the old
     key is no longer a live wall (so they never appear on both sides) —
     i.e. on a still-shared wall the opening stays with the room that kept
     the original point ids. Moved openings are re-based: fresh ids can sort
     the other way round ("p10" < "p9"), reversing the frame.
   - {kind:"merge", pairs:[[oldKey,newKey|null],...]}: point ids were
     substituted/removed so several old keys may land on one new key
     (weldPoints, deletePoint). Include an identity pair [k,k] for any wall
     already at a target key, so it counts as a contributor (and as "the
     first wall"). newKey null = collapsed to zero length → props (and its
     openings) dropped. Every contributor's openings are concatenated onto
     the merged wall, each re-based from its own wall's frame (see
     rebaseAlong for the direction/shift math). If one old key lands on
     SEVERAL new keys (deleting a corner on a wall shared by two rooms),
     each opening goes to the target wall nearest its center, never both. */
function remapWallRefs(f, op){
  // object anchors (item 5) first: same op, same rebaseAlong math, and it
  // must not be skipped by the early returns below (a wall with no
  // wallProps entry can still host anchored objects)
  _remapAnchors(f, op);
  if(!f.wallProps) f.wallProps={};
  const wp=f.wallProps;
  if(op.kind==="split"){
    const K=wallKey(op.a,op.b), p=wp[K]; if(!p) return;
    const fr=wallFrame(f,K), M=_ptAny(f,op.mid);
    const kLo=wallKey(fr ? fr.lo : op.a, op.mid), kHi=wallKey(op.mid, fr ? fr.hi : op.b);
    const base=_propsSansOpenings(p), lists={[kLo]:[], [kHi]:[]};
    const ops=_cloneOpenings(p);
    if(ops.length && fr && M){
      const s=Math.max(0, Math.min(fr.len, worldToAlong(fr, M)));   // split position, old frame
      ops.forEach(o=>{
        const first = o.along < s;
        let s0=o.along-o.width/2, s1=o.along+o.width/2;
        if(first) s1=Math.min(s1,s); else s0=Math.max(s0,s);         // trim at the split only
        const trimmed = s1-s0 < o.width-1e-9;
        const k = first ? kLo : kHi;
        lists[k].push({...o, along:_r6(rebaseAlong(f, K, trimmed ? (s0+s1)/2 : o.along, k)),
          width: trimmed ? _r6(s1-s0) : o.width});
      });
    }
    [kLo,kHi].forEach(k=>{
      if(Object.keys(base).length) wp[k]=JSON.parse(JSON.stringify(base));
      _setOpenings(wp, k, lists[k]);
    });
  } else if(op.kind==="detach"){
    const live=liveWallKeys(f), movedOpenings=new Set();
    op.pairs.forEach(([o,n])=>{
      if(!o || !n || o===n || !wp[o]) return;
      const c=_propsSansOpenings(wp[o]);
      if(Object.keys(c).length) wp[n]=c;
      if(wp[o].openings && !live.has(o) && !movedOpenings.has(o)){
        movedOpenings.add(o);
        _setOpenings(wp, n, _cloneOpenings(wp[o]).map(x=>({...x, along:_r6(rebaseAlong(f, o, x.along, n))})));
      }
    });
  } else if(op.kind==="merge"){
    const groups=new Map(), targets=new Map();   // newKey → [oldKey], oldKey → Set(newKey)
    op.pairs.forEach(([o,n])=>{
      if(!o || !n) return;
      if(!groups.has(n)) groups.set(n,[]);
      const g=groups.get(n); if(!g.includes(o)) g.push(o);
      if(!targets.has(o)) targets.set(o,new Set());
      targets.get(o).add(n);
    });
    // snapshot every contributor before any write (a new key may also be an
    // old key of the same op)
    const snap={};
    groups.forEach(olds=>olds.forEach(k=>{ if(!(k in snap)) snap[k]=wp[k] ? JSON.parse(JSON.stringify(wp[k])) : undefined; }));
    // distribute openings of re-keyed walls onto their target walls
    const incoming=new Map();
    targets.forEach((ns,o)=>{
      // (an identity contributor [n,n] goes through here too, re-basing onto
      // itself as a no-op, so a merged wall keeps its OWN openings as well;
      // for an untouched group the result is simply never written below)
      const list=_cloneOpenings(snap[o]); if(!list.length) return;
      const cand=[...ns].map(n=>wallFrame(f,n)).filter(Boolean);
      const src=wallFrame(f,o); if(!src || !cand.length) return;
      list.forEach(x=>{
        const C=alongToWorld(src, x.along);
        let best=cand[0], bd=Infinity;
        cand.forEach(fr=>{ const t=Math.max(0,Math.min(fr.len,worldToAlong(fr,C))), P=alongToWorld(fr,t);
          const d=Math.hypot(P.x-C.x,P.y-C.y); if(d<bd-1e-9){ bd=d; best=fr; } });
        if(!incoming.has(best.key)) incoming.set(best.key,[]);
        incoming.get(best.key).push({...x, along:_r6(rebaseAlong(f, o, x.along, best.key))});
      });
    });
    groups.forEach((olds,n)=>{
      if(olds.every(o=>o===n)) return;                        // untouched wall
      const order=olds.includes(n) ? [n, ...olds.filter(o=>o!==n)] : olds;
      const ins=incoming.get(n)||[];
      if(!order.some(k=>snap[k]) && !ins.length) return;      // nothing to carry
      const m=mergeWallProps(order.map(k=>snap[k]));
      if(Object.keys(m).length) wp[n]=m; else delete wp[n];
      _setOpenings(wp, n, ins);
    });
  } else {
    throw new Error("remapWallRefs: unknown op "+op.kind);
  }
}
function indexLevel(f){
  f._pt = new Map(f.points.map(p=>[p.id,p]));
  deriveWalls(f);
  return f;
}
function ptOf(f,id){ return f._pt.get(id); }
function usedPointIds(f){ const s=new Set(); f.rooms.forEach(r=>r.loop.forEach(id=>s.add(id))); return s; }
function gcPoints(f){ const used=usedPointIds(f); f.points=f.points.filter(p=>used.has(p.id)); f._pt=new Map(f.points.map(p=>[p.id,p])); }
function pointDegree(f,id){ return f.walls.filter(w=>w.a===id||w.b===id).length; }
function roomsAt(f,id){ return f.rooms.filter(r=>r.loop.includes(id)); }
function neighborsOf(f,id){ const s=new Set(); f.walls.forEach(w=>{ if(w.a===id)s.add(w.b); if(w.b===id)s.add(w.a); }); return s; }
function wallById(f,id){ return f.walls.find(w=>w.id===id); }

/* Weld: fuse point `fromId` into `toId` (they become one anchored corner). */
function weldPoints(f, fromId, toId){
  if(fromId===toId) return;
  const pairs=[];
  f.rooms.forEach(r=>{
    const oldKeys=loopWallKeys(r.loop);
    r.loop = r.loop.map(id=>id===fromId?toId:id);
    // elementwise substitution, so edge i still corresponds edge-for-edge
    // (collapsing duplicates below only drops the zero-length edges)
    const newKeys=loopWallKeys(r.loop);
    oldKeys.forEach((k,i)=>{ if(k) pairs.push([k,newKeys[i]]); });
    // collapse any consecutive duplicates created by the weld
    const out=[]; for(let i=0;i<r.loop.length;i++){ if(r.loop[i]!==r.loop[(i+1)%r.loop.length]) out.push(r.loop[i]); }
    r.loop = out.length>=3 ? out : r.loop;
  });
  remapWallRefs(f, {kind:"merge", pairs});
  gcPoints(f); deriveWalls(f);
}

/* Detach a whole room: give it private copies of its corners so it can move
   independently of its former neighbours. */
function detachRoom(f, room){
  const map=new Map();
  [...new Set(room.loop)].forEach(id=>{
    const p=ptOf(f,id); const nid="p"+(_pid++);
    f.points.push({x:p.x,y:p.y,id:nid}); map.set(id,nid);
  });
  const oldKeys=loopWallKeys(room.loop);
  room.loop = room.loop.map(id=>map.get(id)||id);
  const newKeys=loopWallKeys(room.loop);
  remapWallRefs(f, {kind:"detach", pairs:oldKeys.map((k,i)=>[k,newKeys[i]])});
  f._pt=new Map(f.points.map(p=>[p.id,p]));
  gcPoints(f); deriveWalls(f);
}

/* Detach a corner: give every room meeting there its own copy, fully separating
   the junction. Re-snap by dragging the pieces back together. */
function detachCorner(f, id){
  const rs=roomsAt(f,id);
  const pairs=[];
  rs.forEach((room,idx)=>{
    if(idx===0) return;                 // first room keeps the original id
    const p=ptOf(f,id); const nid="p"+(_pid++);
    f.points.push({x:p.x,y:p.y,id:nid});
    const oldKeys=loopWallKeys(room.loop);
    room.loop = room.loop.map(x=>x===id?nid:x);
    const newKeys=loopWallKeys(room.loop);
    oldKeys.forEach((k,i)=>pairs.push([k,newKeys[i]]));
  });
  remapWallRefs(f, {kind:"detach", pairs});
  f._pt=new Map(f.points.map(p=>[p.id,p]));
  gcPoints(f); deriveWalls(f);
}

/* Divide a wall: insert a midpoint, updating every room loop that uses the
   edge (in either direction) so shared walls stay consistent. Returns new id. */
function divideWall(f, w){
  const a=w.a, b=w.b; const pa=ptOf(f,a), pb=ptOf(f,b);
  const mid={id:"pt"+(_pid++), x:snapInch((pa.x+pb.x)/2), y:snapInch((pa.y+pb.y)/2)};
  f.points.push(mid); f._pt.set(mid.id, mid);   // remapWallRefs needs mid's coords
  f.rooms.forEach(r=>{
    const L=r.loop, out=[];
    for(let i=0;i<L.length;i++){
      out.push(L[i]);
      const cur=L[i], nxt=L[(i+1)%L.length];
      if((cur===a&&nxt===b)||(cur===b&&nxt===a)) out.push(mid.id);
    }
    r.loop=out;
  });
  remapWallRefs(f, {kind:"split", a, b, mid:mid.id});
  f._pt=new Map(f.points.map(p=>[p.id,p]));
  deriveWalls(f);
  return mid.id;
}

/* ---- locking ---- */
function lockedPointIds(f){ const s=new Set(); f.rooms.forEach(r=>{ if(r.locked) r.loop.forEach(id=>s.add(id)); }); return s; }

/* The set of points a whole-room translate (room drag / nudge) must move so
   no welded neighbour gets distorted: flood-fill across every room in the
   level that transitively shares a point id with `startRoomId` (a chain
   A-B-C moves together even though A never touches C), and return the union
   of their points.

   Locked rooms are a hard boundary. A point belonging to any locked room is
   never moved and never propagated through — so a locked room is neither
   dragged along nor distorted, and rooms that touch the cluster only via a
   locked room's corner stay put. Such points are reported in `pinnedIds`:
   they stay fixed while the rest of the cluster moves, so an unlocked room
   welded to a locked one stretches at that shared corner (the locked room's
   geometry wins). In practice this is rare — locking a room detaches it
   first — but loaded files or welds made before locking can still produce it.

   A locked start room yields an empty result (callers already refuse to move
   it). Returns {ids, roomIds, pinnedIds} — `roomIds` is every room in the
   moved cluster (item 5's free-object carry-along needs it per room). */
function connectedRoomPoints(f, startRoomId){
  const start=f.rooms.find(r=>r.id===startRoomId);
  const out={ids:[], roomIds:[], pinnedIds:[]};
  if(!start || start.locked) return out;
  const locked=lockedPointIds(f);
  const roomsByPt=new Map();
  f.rooms.forEach(r=>{ if(r.locked) return; new Set(r.loop).forEach(id=>{
    if(!roomsByPt.has(id)) roomsByPt.set(id,[]); roomsByPt.get(id).push(r); }); });
  const seenRooms=new Set([start.id]), ids=new Set(), pinned=new Set();
  const queue=[start];
  while(queue.length){
    const r=queue.shift(); out.roomIds.push(r.id);
    for(const id of r.loop){
      if(locked.has(id)){ pinned.add(id); continue; }   // boundary: don't move, don't cross
      if(ids.has(id)) continue;
      ids.add(id);
      for(const n of roomsByPt.get(id)||[]){
        if(!seenRooms.has(n.id)){ seenRooms.add(n.id); queue.push(n); }
      }
    }
  }
  out.ids=[...ids]; out.pinnedIds=[...pinned];
  return out;
}

/* Insert a point at (x,y) on the edge (a,b) for every room using that edge. */
function insertPointOnWall(f,a,b,x,y){
  const mid={id:"pt"+(_pid++), x:snapInch(x), y:snapInch(y)}; let inserted=false;
  f.points.push(mid);   // (remapWallRefs finds it via f.points; _pt is rebuilt below)
  f.rooms.forEach(r=>{
    const L=r.loop, out=[];
    for(let i=0;i<L.length;i++){
      out.push(L[i]);
      const cur=L[i], nxt=L[(i+1)%L.length];
      if((cur===a&&nxt===b)||(cur===b&&nxt===a)){ out.push(mid.id); inserted=true; }
    }
    r.loop=out;
  });
  if(!inserted){ f.points.pop(); return null; }
  remapWallRefs(f, {kind:"split", a, b, mid:mid.id});
  f._pt=new Map(f.points.map(p=>[p.id,p])); deriveWalls(f); return mid.id;
}

/* Interior angle (degrees) at vertex V within a given room. */
function cornerNeighbors(f, room, V){
  const L=room.loop; const i=L.indexOf(V); if(i<0) return null;
  return { P:L[(i-1+L.length)%L.length], N:L[(i+1)%L.length] };
}
function cornerAngle(f, room, V){
  const nb=cornerNeighbors(f,room,V); if(!nb) return null;
  const v=ptOf(f,V), p=ptOf(f,nb.P), n=ptOf(f,nb.N);
  const ax=p.x-v.x, ay=p.y-v.y, bx=n.x-v.x, by=n.y-v.y;
  const la=Math.hypot(ax,ay), lb=Math.hypot(bx,by); if(la<1e-6||lb<1e-6) return null;
  let c=(ax*bx+ay*by)/(la*lb); c=Math.max(-1,Math.min(1,c));
  return Math.acos(c)*180/Math.PI;
}

/* ---- cut tool: subtract the cutter room's area from every overlapping room,
   adding the boundary points needed so the others conform to the cut. Uses the
   vendored polygon-clipping difference. Locked rooms are left untouched. ---- */
function loopRing(f,loop){ const r=loop.map(id=>{const p=ptOf(f,id);return [p.x,p.y];}); r.push(r[0].slice()); return r; }
function ringAreaC(ring){ let s=0; for(let i=0;i<ring.length-1;i++){ s+=ring[i][0]*ring[i+1][1]-ring[i+1][0]*ring[i][1]; } return Math.abs(s)/2; }
function getOrMakePoint(f,x,y){ x=snapInch(x); y=snapInch(y); for(const p of f.points){ if(Math.hypot(p.x-x,p.y-y)<=MERGE_TOL) return p.id; } const id="pt"+(_pid++); f.points.push({id,x,y}); return id; }
function ringToLoop(f,ring){
  const ids=[];
  for(let i=0;i<ring.length-1;i++){ const id=getOrMakePoint(f,ring[i][0],ring[i][1]); if(ids[ids.length-1]!==id) ids.push(id); }
  if(ids.length>1 && ids[0]===ids[ids.length-1]) ids.pop();
  return ids;
}
function cutRoom(f, cutter){
  const PC=window.polygonClipping; if(!PC) return {changed:false, dropped:false, err:true};
  const cutGeom=[ loopRing(f,cutter.loop) ];
  let changed=false, dropped=false; const removeIds=new Set();
  for(const r of f.rooms){
    if(r.id===cutter.id || r.locked) continue;
    const subj=[ loopRing(f,r.loop) ];
    let inter, diff;
    try{ inter=PC.intersection(subj, cutGeom); }catch(e){ continue; }
    let ia=0; inter.forEach(poly=>{ ia+=ringAreaC(poly[0]); poly.slice(1).forEach(h=>ia-=ringAreaC(h)); });
    if(ia < 0.02) continue;                       // no real overlap → leave it
    try{ diff=PC.difference(subj, cutGeom); }catch(e){ continue; }
    if(diff.length===0){ removeIds.add(r.id); changed=true; continue; }   // fully consumed
    let best=null, ba=-1;
    diff.forEach(poly=>{ if(poly.length>1) dropped=true; const a=ringAreaC(poly[0]); if(a>ba){ ba=a; best=poly[0]; } });
    if(diff.length>1) dropped=true;               // kept only the largest piece
    r.loop = ringToLoop(f, best);
    changed=true;
  }
  f.rooms = f.rooms.filter(r=>!removeIds.has(r.id));
  // A room fully consumed by the cut no longer exists — orphan (not delete)
  // any free object that belonged to it, same policy as room deletion below.
  if(removeIds.size && f.objects) f.objects.forEach(o=>{ if(removeIds.has(o.roomId)) o.roomId=null; });
  f._pt=new Map(f.points.map(p=>[p.id,p]));
  // No remapWallRefs here, deliberately (ARCHITECTURE.md accepted gap): the
  // cut rebuilds loops from scratch. Edges that come out with the same two
  // point ids (ringToLoop reuses existing corners) keep their key and so
  // keep their wallProps; edges the cut recreates/splits start fresh at the
  // level default, and deriveWalls() prunes the props of consumed edges.
  gcPoints(f); deriveWalls(f);
  return {changed, dropped, err:false};
}

/* Mint a new level (fresh unique id, visible) whose geometry is built from
   seed rectangles — [] for a blank level. */
function makeLevel(name, rects){
  const g = buildLevel(rects||[]);
  return indexLevel({id:"lvl"+(_lid++), name, visible:true, points:g.points, walls:g.walls, rooms:g.rooms,
    wallProps:{}, defaultThickness:DEFAULT_WALL_THICKNESS, objects:[]});
}

/* ---------- room-relative object placement (ARCHITECTURE.md item 5) ----------
   level.objects = [{id, type, roomId, w, d, mirror, x, y, rot, anchor}].
   x/y/rot are world coordinates/degrees. For a FREE object (anchor null)
   they are authoritative; for an ANCHORED object they are a cache rewritten
   by resolveObjects() (see "wall anchors" below) and never edited directly.
   w/d are feet, PER-INSTANCE (the catalog's w/d are only a starting box —
   addObject below copies them in, but the user can resize afterward).
   mirror is a plain boolean flip. roomId is which room's reparenting
   currently has it (null = not inside any room). */

/* Even-odd point-in-polygon test. `pts` = [{x,y}, ...] (a closed loop, first
   point not repeated at the end). Standard ray-casting; boundary behavior is
   the usual ray-casting ambiguity, which is fine here — reparenting only
   cares about a point meaningfully inside one room. */
function pointInPolygon(pts, x, y){
  let inside=false;
  for(let i=0, j=pts.length-1; i<pts.length; j=i++){
    const xi=pts[i].x, yi=pts[i].y, xj=pts[j].x, yj=pts[j].y;
    const hit = ((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/(yj-yi)+xi);
    if(hit) inside=!inside;
  }
  return inside;
}
/* Which room (if any) of the level contains world point (x,y) — tested
   against each room's plain centerline loop, not its interior-offset
   polygon (a purely topological question: "which room's outline is this
   point inside", not "is it past the wall face"). First match wins if rooms
   overlap (pre-cut geometry, or loaded data) — rare, and not worth resolving
   more cleverly here. Returns null if no room contains the point. */
function roomContainingPoint(f, x, y){
  for(const r of f.rooms){
    const pts = r.loop.map(id=>ptOf(f,id));
    if(pts.some(p=>!p) || pts.length<3) continue;
    if(pointInPolygon(pts, x, y)) return r;
  }
  return null;
}

/* Create a free (unanchored) object of catalog `type` centered at world
   point (x,y). Sizes it from the catalog's starting w/d (per-instance,
   resizable afterward) and resolves roomId immediately via
   roomContainingPoint, so a fixture dropped in a room is parented to it from
   the moment it's placed. Returns the new object, or null if `type` isn't a
   known fixture type (js/catalog.js FIXTURE_TYPES). Pure mutator — callers
   wrap this in commit(). */
function addObject(f, type, x, y){
  const def = fixtureTypeDef(type); if(!def) return null;
  if(!f.objects) f.objects=[];
  const room = roomContainingPoint(f, x, y);
  const o = {id:"obj"+(_pid++), type, roomId: room?room.id:null,
    w:def.w, d:def.d, mirror:false, x, y, rot:0, anchor:null};
  f.objects.push(o);
  return o;
}
/* Remove an object by id. Returns true if it existed. */
function removeObject(f, id){
  if(!f.objects) return false;
  const n=f.objects.length;
  f.objects = f.objects.filter(o=>o.id!==id);
  return f.objects.length!==n;
}

/* ---------- wall anchors (ARCHITECTURE.md item 5, anchored half) ----------
   anchor = {wall, edge, along, gap}:
   - wall:  canonical wallKey "lo|hi" (same identity as wallProps/openings).
   - edge:  which LOCAL edge of the object's box faces the wall.
   - along: the object's CENTER along the wall, in feet from `lo` — exactly
            the opening convention (wallFrame / alongToWorld), so anchors
            re-key through remapWallRefs with the same rebaseAlong math.
   - gap:   feet, >= 0, from the wall's INTERIOR face on roomId's side
            (roomInterior(...).edges[i]: centerline + n*half) to `edge`.

   EDGE NAMES, in the object's own local frame — the one objectLocalToScreen
   (js/render.js) draws through: local lx ∈ [-w/2, w/2] is the width axis,
   ld ∈ [-d/2, d/2] the depth axis, and at rot=0 (no mirror) lx → world +x,
   ld → world +y. Then
       back  = the ld = -d/2 edge   (outward local normal (0,-1))
       front = the ld = +d/2 edge   (outward local normal (0,+1))
       left  = the lx = -w/2 edge   (outward local normal (-1,0))
       right = the lx = +w/2 edge   (outward local normal (+1,0))
   measured BEFORE mirroring (mirror flips lx before rotating, so a mirrored
   object's "left" edge is drawn where an unmirrored one's "right" is;
   resolve accounts for that, so the named edge always faces the wall).

   RESOLVE: with P = the wall centerline point at `along`, n = roomId's
   inward unit normal of that wall and half = effThickness/2,
       center = P + n * (half + gap + h)      h = d/2 (back/front), w/2 (left/right)
       rot    = the angle that turns the edge's (mirrored) outward local
                normal onto -n, i.e. the edge faces the wall squarely and the
                box extends from it INTO the room.
   Hand-worked check (test/anchors.test.js's first test): horizontal wall
   along +x at y = 0, room below it (n = (0,1)), thickness 0.5 (half 0.25),
   object w=2 d=4, edge "back", gap 0, along 5:
       interior face at y = 0.25; back edge (ld = -2 at rot 0 → world y - 2)
       must sit on it → o.y = 0.25 + 0 + 2 = 2.25, o.x = 5, rot = 0.
   (atan2(-n) - atan2(v) = atan2(-1,0) - atan2(-1,0) = 0 for v = (0,-1).)

   The `along` used for the pose is clamped to [0, wallLength] — a DISPLAY
   clamp like displayedOpening's: the stored value is never rewritten by a
   length edit, so lengthening the wall again restores the position. */
const ANCHOR_EDGES = {back:{x:0,y:-1}, front:{x:0,y:1}, left:{x:-1,y:0}, right:{x:1,y:0}};
function isAnchorEdge(e){ return typeof e==="string" && Object.prototype.hasOwnProperty.call(ANCHOR_EDGES, e); }
function anchorEdgeHalf(o, edge){ return (edge==="left" || edge==="right") ? o.w/2 : o.d/2; }

/* Normalize a persisted anchor: a well-formed {wall, edge, along, gap} (a
   copy — never aliases the input), else null (the object loads free). */
function sanitizeAnchor(a){
  if(!a || typeof a!=="object" || Array.isArray(a)) return null;
  if(typeof a.wall!=="string" || a.wall.split("|").length!==2 || !isAnchorEdge(a.edge)) return null;
  if(typeof a.along!=="number" || !isFinite(a.along) || typeof a.gap!=="number" || !isFinite(a.gap)) return null;
  return {wall:a.wall, edge:a.edge, along:a.along, gap:Math.max(0, a.gap)};
}

/* The interior face an anchor on wall `key` measures from, for room
   `roomId`: {fr (wallFrame), side ({a,b,len,n,half} from roomInterior, or
   null when that room's edge is currently degenerate)}. null when the anchor
   is INVALID: no room, the wall's endpoints are gone, or the wall is not an
   edge of roomId's loop. Requires an indexed level (f._pt). */
function anchorFace(f, roomId, key, interiors){
  if(!roomId) return null;
  const fr=wallFrame(f,key); if(!fr) return null;
  const s=wallSides(f, {a:fr.lo, b:fr.hi}, interiors).find(x=>x.room.id===roomId);
  return s ? {fr, side:s.side} : null;
}

/* Pure: the {x, y, rot} an object of size o.w×o.d (and o.mirror) takes for
   `anchor` against `face` — see RESOLVE above. */
function anchorPose(o, anchor, face){
  const {fr, side}=face, n=side.n;
  const along=Math.max(0, Math.min(fr.len, anchor.along));
  const P=alongToWorld(fr, along);
  const off=side.half + anchor.gap + anchorEdgeHalf(o, anchor.edge);
  const u=ANCHOR_EDGES[anchor.edge], mir=o.mirror?-1:1;
  let rot=(Math.atan2(-n.y,-n.x) - Math.atan2(u.y, u.x*mir))*180/Math.PI;
  rot=_r6(((rot%360)+360)%360); if(rot>=360) rot=0;
  return {x:P.x+n.x*off, y:P.y+n.y*off, rot};
}

/* THE post-mutation pass for anchored objects. For every object with an
   anchor, recompute its cached x/y/rot from the wall's CURRENT geometry,
   roomId's interior face (effThickness, so a thickness change moves it) and
   the edge. An anchor that is no longer valid — wall gone, or no longer an
   edge of roomId's loop (including roomId null / room deleted) — is set to
   null: the object becomes free at its last resolved position. A merely
   degenerate face (zero-length wall, collapsed room — e.g. mid-drag) keeps
   the anchor and the last cached pose instead of unanchoring.
   Hooked into markDirty() (js/state.js), so it runs after every commit(),
   undo, load and drag end, and is called directly by the drag handlers that
   move geometry live (js/tools.js) — never from inside render(). */
function resolveObjects(f){
  if(!f || !Array.isArray(f.objects) || !f.objects.length || !f._pt) return;
  const interiors=new Map();
  f.objects.forEach(o=>{
    if(o.anchor==null) return;
    const a=sanitizeAnchor(o.anchor);
    const face=a && anchorFace(f, o.roomId, a.wall, interiors);
    if(!face){ o.anchor=null; return; }
    if(!face.side || face.fr.len<1e-9) return;
    Object.assign(o, anchorPose(o, a, face));
  });
}

/* Default anchor for putting object `o` against wall `key` (the "Measure
   from wall…" pick and the auto-anchor on drop):
   - edge: the one whose outward normal (at the object's current rot/mirror)
     points most directly at the wall (most anti-parallel to n) — i.e. the
     side of the box already facing that wall;
   - along: the object's current center projected onto the wall, clamped to
     the wall's length;
   - gap: the current perpendicular distance from the interior face to that
     edge once it is squared up (center distance minus the edge's
     half-extent), clamped to >= 0 — so anchoring keeps the center where it
     is (apart from squaring the rotation) unless the box was poking into
     the wall.
   Also returns `rawGap` (unclamped) and `skew` (degrees the object would
   rotate to square up). null if the anchor wouldn't be valid (see
   anchorFace), the face is degenerate, or the wall is open. */
function defaultAnchorFor(f, o, key, interiors){
  const face=anchorFace(f, o.roomId, key, interiors);
  if(!face || !face.side || face.fr.len<1e-9) return null;
  if(isOpenWall(f, {a:face.fr.lo, b:face.fr.hi})) return null;
  const n=face.side.n, rad=(o.rot||0)*Math.PI/180, cos=Math.cos(rad), sin=Math.sin(rad), mir=o.mirror?-1:1;
  let edge=null, best=-Infinity;
  for(const e of ["back","front","left","right"]){
    const u=ANCHOR_EDGES[e], mx=u.x*mir;
    const m={x:mx*cos-u.y*sin, y:mx*sin+u.y*cos};          // same transform as objectLocalToScreen
    const facing=-(m.x*n.x+m.y*n.y);
    if(facing>best+1e-9){ best=facing; edge=e; }
  }
  const fr=face.fr;
  const along=_r6(Math.max(0, Math.min(fr.len, worldToAlong(fr, o))));
  const dist=(o.x-fr.A.x)*n.x + (o.y-fr.A.y)*n.y;          // center → centerline, toward the room
  const rawGap=dist - face.side.half - anchorEdgeHalf(o, edge);
  const anchor={wall:key, edge, along, gap:_r6(Math.max(0, rawGap))};
  const pose=anchorPose(o, anchor, face);
  let skew=Math.abs((((pose.rot-(o.rot||0))%360)+540)%360-180);
  return {anchor, rawGap, skew};
}

/* Anchor `o` to wall `key` (spec fields override the defaults above) and
   resolve it immediately. Refused (false, nothing changed) if the wall is
   open, isn't an edge of o's room, or is degenerate. Pure mutator — callers
   wrap it in commit(). */
function anchorObject(f, o, key, spec){
  const def=defaultAnchorFor(f, o, key); if(!def) return false;
  const a={...def.anchor};
  if(spec){
    if(isAnchorEdge(spec.edge)) a.edge=spec.edge;
    if(typeof spec.along==="number" && isFinite(spec.along)) a.along=spec.along;
    if(typeof spec.gap==="number" && isFinite(spec.gap)) a.gap=Math.max(0, spec.gap);
  }
  o.anchor=a;
  resolveObjects(f);
  return o.anchor!=null;
}
/* Edit an anchored object's edge/along/gap with the same clamping the drag
   uses: along into [0, wallLength], gap >= 0. Returns false if `o` isn't
   anchored (or its anchor is no longer valid). */
function updateAnchor(f, o, patch){
  if(!o || !o.anchor) return false;
  const face=anchorFace(f, o.roomId, o.anchor.wall); if(!face){ o.anchor=null; return false; }
  if(patch.edge!=null){ if(!isAnchorEdge(patch.edge)) return false; o.anchor.edge=patch.edge; }
  if(patch.along!=null){ if(!isFinite(patch.along)) return false; o.anchor.along=_r6(Math.max(0, Math.min(face.fr.len, patch.along))); }
  if(patch.gap!=null){ if(!isFinite(patch.gap)) return false; o.anchor.gap=_r6(Math.max(0, patch.gap)); }
  resolveObjects(f);
  return true;
}
/* Explicit "Unanchor": drop the anchor, leaving x/y/rot at their last
   resolved values (the object is free from then on). */
function unanchorObject(o){ if(!o || !o.anchor) return false; o.anchor=null; return true; }

/* remapWallRefs' half for object anchors (called from its top, for every
   op kind, with the same op shapes — see that function's comment). Rules,
   mirroring the openings handling:
   - split:  the half containing the object's CENTER (`along` < split
             position → the half touching lo, else the hi half), re-based
             into that half's frame.
   - merge:  an anchor whose wall is a contributor follows it to its new key;
             if that old key lands on several new keys (corner delete on a
             shared wall), the candidate must be an edge of the object's own
             room loop (nearest to the center if still ambiguous).
   - detach: the anchor follows the new wall key belonging to its OWN
             roomId: if that room's loop still has the old key it stays,
             else it moves to the paired new key that IS in its loop.
   Always re-based with rebaseAlong (world point → projection), so reversed
   frames and positional shifts need no special-casing. A wall that vanishes
   (merge to null, no candidate in the room's loop) is left alone here —
   resolveObjects then unanchors it. Runs after loops are rewritten, before
   points are gc'd, like the rest of remapWallRefs. */
function _remapAnchors(f, op){
  const objs=(f.objects||[]).filter(o=>o.anchor && typeof o.anchor.wall==="string" && isFinite(o.anchor.along));
  if(!objs.length) return;
  const roomKeys=o=>{ const r=f.rooms.find(r=>r.id===o.roomId); return new Set(r ? loopWallKeys(r.loop).filter(Boolean) : []); };
  const move=(a, to)=>{ a.along=_r6(rebaseAlong(f, a.wall, a.along, to)); a.wall=to; };
  if(op.kind==="split"){
    const K=wallKey(op.a,op.b), fr=wallFrame(f,K), M=_ptAny(f,op.mid);
    if(!fr || !M) return;
    const kLo=wallKey(fr.lo, op.mid), kHi=wallKey(op.mid, fr.hi);
    const s=Math.max(0, Math.min(fr.len, worldToAlong(fr, M)));
    objs.forEach(o=>{ if(o.anchor.wall===K) move(o.anchor, o.anchor.along < s ? kLo : kHi); });
  } else if(op.kind==="detach"){
    const byOld=new Map();
    op.pairs.forEach(([o,n])=>{ if(!o || !n || o===n) return; if(!byOld.has(o)) byOld.set(o,[]); byOld.get(o).push(n); });
    objs.forEach(o=>{
      const a=o.anchor, ns=byOld.get(a.wall); if(!ns) return;
      const keys=roomKeys(o); if(keys.has(a.wall)) return;     // its room still owns the original
      const to=ns.find(n=>keys.has(n)); if(to) move(a, to);
    });
  } else if(op.kind==="merge"){
    const targets=new Map();
    op.pairs.forEach(([o,n])=>{ if(!o || !n) return; if(!targets.has(o)) targets.set(o,new Set()); targets.get(o).add(n); });
    objs.forEach(o=>{
      const a=o.anchor, ns=targets.get(a.wall); if(!ns) return;
      const keys=roomKeys(o);
      const cand=[...ns].filter(n=>keys.has(n)).map(n=>wallFrame(f,n)).filter(Boolean);
      const src=wallFrame(f,a.wall); if(!cand.length || !src) return;
      const C=alongToWorld(src, a.along);
      let best=cand[0], bd=Infinity;
      cand.forEach(fr=>{ const t=Math.max(0,Math.min(fr.len,worldToAlong(fr,C))), P=alongToWorld(fr,t);
        const d=Math.hypot(P.x-C.x,P.y-C.y); if(d<bd-1e-9){ bd=d; best=fr; } });
      move(a, best.key);
    });
  }
}

/* Ensure the global id counters are above every numeric id already present,
   so newly minted point/room ids (_pid) and level ids (_lid) can never collide
   with loaded data.

   Scans generically: any object anywhere under a level (at any nesting
   depth, in arrays or plain objects) that has an `id` field contributes to
   the point/room counter (_pid). This is deliberately not a hardcoded list
   of `points`/`rooms` — future per-level collections (e.g. `objects`, or
   openings nested inside a `wallProps` map) are picked up automatically
   without this function needing a new line per collection type, which is
   the exact bug class that previously caused id collisions with loaded
   files. Keys starting with `_` (private caches like `_pt`) are skipped. */
function syncIds(d){
  let mx=0, lmx=-1;
  const num=id=>{ const m=/(\d+)$/.exec(String(id)); return m ? +m[1] : null; };
  function scan(node){
    if(!node || typeof node!=="object") return;
    if(Array.isArray(node)){ node.forEach(scan); return; }
    if(typeof node.id==="string" || typeof node.id==="number"){
      const n=num(node.id); if(n!=null) mx=Math.max(mx,n);
    }
    for(const k of Object.keys(node)){
      if(k==="id" || k.charAt(0)==="_") continue;
      scan(node[k]);
    }
  }
  for(const l of (d.levels||[])){
    if(!l) continue;
    const ln=num(l.id); if(ln!=null) lmx=Math.max(lmx,ln);
    for(const k of Object.keys(l)){
      if(k==="id" || k.charAt(0)==="_") continue;
      scan(l[k]);
    }
  }
  _pid = Math.max(_pid, mx+1);
  _lid = Math.max(_lid, lmx+1);
}

/* Escape a string for safe insertion into innerHTML (as text content or
   inside a quoted attribute value). Every call site that builds HTML out of
   user-editable data (room/level names, etc.) must run the value through
   this before interpolating it. */
function esc(s){
  return String(s)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#39;");
}

/* ---------- formatting ---------- */
function fmtFt(v){
  const sign = v<0 ? "-" : "";
  const ti = Math.round(Math.abs(v)*12);
  const ft = Math.floor(ti/12), inch = ti%12;
  return `${sign}${ft}'${inch}"`;
}
function parseLen(str){
  if(str==null) return NaN;
  str = String(str).trim().replace(/[“”]/g,'"').replace(/[‘’]/g,"'");
  let m;
  if((m = str.match(/^(-?\d+(?:\.\d+)?)\s*'\s*(\d+(?:\.\d+)?)?\s*"?$/)))  // 13' 7"
    { const ft=parseFloat(m[1]); const inch=m[2]?parseFloat(m[2]):0; return ft<0? ft-inch/12 : ft+inch/12; }
  if((m = str.match(/^(-?\d+(?:\.\d+)?)\s*"$/))) return parseFloat(m[1])/12;       // 7"
  if((m = str.match(/^(-?\d+)\s+(\d+(?:\.\d+)?)$/)))                               // 13 7
    { const ft=parseFloat(m[1]); const inch=parseFloat(m[2]); return ft<0? ft-inch/12 : ft+inch/12; }
  if((m = str.match(/^-?\d+(?:\.\d+)?$/))) return parseFloat(str);                 // 13.58
  return NaN;
}
function polyArea(f, loop){
  let s=0; for(let i=0;i<loop.length;i++){ const a=ptOf(f,loop[i]), b=ptOf(f,loop[(i+1)%loop.length]); s += a.x*b.y - b.x*a.y; }
  return Math.abs(s)/2;
}
/* ---- raw-vertex loop geometry ({x,y} lists, not yet point ids) — used to
   validate shapes from the room-drawing tools before they touch the model.
   (ARCHITECTURE.md suggests an optional js/geometry.js for this kind of
   helper once item 3 needs more of it.) ---- */

/* Signed shoelace area. World coords are y-down, so a POSITIVE value is a
   loop that runs clockwise as seen on screen — the order addRoom() and
   buildLevel() have always produced (top-left → top-right → bottom-right →
   bottom-left), and the order the drawing tools normalize new rooms to. */
function signedAreaXY(vs){
  let s=0; for(let i=0;i<vs.length;i++){ const a=vs[i], b=vs[(i+1)%vs.length]; s += a.x*b.y - b.x*a.y; }
  return s/2;
}
function orient2(a,b,c){ return (b.x-a.x)*(c.y-a.y) - (b.y-a.y)*(c.x-a.x); }
function onSegXY(p,q,r,eps){   // r collinear with p-q: is it within the segment's box?
  return r.x>=Math.min(p.x,q.x)-eps && r.x<=Math.max(p.x,q.x)+eps && r.y>=Math.min(p.y,q.y)-eps && r.y<=Math.max(p.y,q.y)+eps;
}
/* Do segments a-b and c-d intersect (crossing, touching, or collinear
   overlap)? */
function segmentsIntersect(a,b,c,d){
  const eps=1e-9;
  const d1=orient2(c,d,a), d2=orient2(c,d,b), d3=orient2(a,b,c), d4=orient2(a,b,d);
  if(((d1>eps&&d2<-eps)||(d1<-eps&&d2>eps)) && ((d3>eps&&d4<-eps)||(d3<-eps&&d4>eps))) return true;
  if(Math.abs(d1)<=eps && onSegXY(c,d,a,eps)) return true;
  if(Math.abs(d2)<=eps && onSegXY(c,d,b,eps)) return true;
  if(Math.abs(d3)<=eps && onSegXY(a,b,c,eps)) return true;
  if(Math.abs(d4)<=eps && onSegXY(a,b,d,eps)) return true;
  return false;
}
/* True if the closed loop crosses or touches itself. O(n²) over edge pairs:
   non-adjacent edges must not meet at all; adjacent edges (which share a
   vertex) must not fold back over each other (a zero-width spike). */
function loopSelfIntersects(vs){
  const n=vs.length; if(n<3) return false;
  for(let i=0;i<n;i++){
    const a=vs[i], b=vs[(i+1)%n];
    for(let j=i+1;j<n;j++){
      const c=vs[j], d=vs[(j+1)%n];
      const adjNext = j===i+1, adjWrap = i===0 && j===n-1;
      if(adjNext || adjWrap){
        // shared vertex v; u and w are the far ends of the two edges
        const v = adjNext ? b : a, u = adjNext ? a : b, w = adjNext ? d : c;
        if(Math.abs(orient2(u,v,w))<=1e-9 && ((u.x-v.x)*(w.x-v.x)+(u.y-v.y)*(w.y-v.y))>0) return true;
        continue;
      }
      if(segmentsIntersect(a,b,c,d)) return true;
    }
  }
  return false;
}

/* ---------- interior-offset geometry (ARCHITECTURE.md item 3) ----------
   A room's walls are centerlines; its usable interior is the loop with every
   edge pushed INWARD by half that edge's effThickness, and each corner moved
   to where the two adjacent offset lines meet (a mitered interior corner).

   Sign convention (the part that is easy to get silently wrong): for an edge
   with direction d=(dx,dy), the perpendicular (-dy, dx) points to the
   interior when the loop's shoelace sum (signedAreaXY) is POSITIVE, and
   (dy, -dx) when it is negative. This is pure algebra — it holds whichever
   way the y axis points — and it is decided PER ROOM from that room's own
   signed area, because not every loop follows the drawing tools' winding
   (cutRoom output and older/loaded files can run either way).
   Check: addRoom()'s (0,0),(w,0),(w,h),(0,h) has positive area; its first
   edge has d=(1,0) → inward (0,1), i.e. toward y=h. Correct.

   Vertex cases (each reported in `kinds[i]`):
   - "miter":     the two offset lines intersect at a sane point (convex or
                  reflex vertex alike — plain line-line intersection, no
                  convexity assumption; unequal thicknesses just mean the
                  two lines are offset by different amounts).
   - "collinear": |sin(turn)| < OFFSET_PARALLEL_SIN — the lines are (nearly)
                  parallel (a pass-through vertex from divideWall / a
                  T-junction, or a 180° fold-back spike). No unique
                  intersection, so the vertex is projected perpendicularly
                  onto EACH offset line. With equal thickness both
                  projections coincide (one corner); with unequal thickness
                  they form a small step, which is the true interior outline.
   - "bevel":     the lines do intersect, but farther than
                  OFFSET_MITER_LIMIT × (the larger half-thickness) from the
                  vertex — e.g. a ~0.5° kink between walls of different
                  thickness, where the exact intersection lands feet away.
                  Falls back to the same two projections as "collinear".
                  (A very sharp convex corner, below ~11° for equal walls,
                  also lands here; its two projections then cross slightly.
                  Accepted: such corners are not realistic rooms.) */
const OFFSET_PARALLEL_SIN = 1e-3;     // ≈ 0.057°
const OFFSET_MITER_LIMIT = 10;        // × max half-thickness at that vertex
const OFFSET_DEDUPE = 1e-7;           // ft — merge coincident projections

/* Pure: offset a closed polygon. `vs` = [{x,y}] (no zero-length edges — the
   caller filters those), `halfs[i]` = inward offset (ft) of edge i (vs[i] →
   vs[i+1]). Returns:
     sign     +1 / -1 (the loop's own winding), 0 if degenerate
     normals  inward unit normal per edge
     corners  per vertex: [pt] (miter) or [onPrevLine, onNextLine]
     kinds    per vertex: "miter" | "collinear" | "bevel"
     edges    per edge: {a, b, len}: the interior face's endpoints ON THAT
              EDGE'S OWN offset line, and its signed length along the edge
              direction (≤ 0 means the interior face has vanished/inverted)
     poly     flattened corners, consecutive duplicates removed */
function offsetPolygon(vs, halfs){
  const n=vs.length;
  const out={sign:0, normals:[], corners:[], kinds:[], edges:[], poly:[]};
  if(n<3) return out;
  const A=signedAreaXY(vs);
  if(!(Math.abs(A)>1e-12)) return out;
  const sign=A>0?1:-1; out.sign=sign;
  const dirs=[];
  for(let i=0;i<n;i++){
    const p=vs[i], q=vs[(i+1)%n];
    const L=Math.hypot(q.x-p.x,q.y-p.y);
    const d={x:(q.x-p.x)/L, y:(q.y-p.y)/L};
    dirs.push(d);
    out.normals.push(sign>0 ? {x:-d.y, y:d.x} : {x:d.y, y:-d.x});
  }
  // a point on edge i's offset line, and the projection of P onto that line
  const linePt=(i,P)=>({x:P.x+out.normals[i].x*halfs[i], y:P.y+out.normals[i].y*halfs[i]});
  const startOn=new Array(n), endOn=new Array(n);   // edge i's face endpoints
  for(let i=0;i<n;i++){
    const ip=(i-1+n)%n, P=vs[i];
    const d0=dirs[ip], d1=dirs[i];
    const Q0=linePt(ip,P), Q1=linePt(i,P);   // = P projected onto each offset line
    const cr=d0.x*d1.y - d0.y*d1.x;          // sin of the turn angle
    let kind="collinear", X=null;
    if(Math.abs(cr)>=OFFSET_PARALLEL_SIN){
      const s=((Q1.x-Q0.x)*d1.y - (Q1.y-Q0.y)*d1.x)/cr;
      X={x:Q0.x+s*d0.x, y:Q0.y+s*d0.y};
      const lim=OFFSET_MITER_LIMIT*Math.max(halfs[ip],halfs[i]);
      kind = Math.hypot(X.x-P.x,X.y-P.y) <= lim+1e-12 ? "miter" : "bevel";
    }
    if(kind==="miter"){
      out.corners.push([X]); endOn[ip]=X; startOn[i]=X;
    } else {
      const same=Math.hypot(Q1.x-Q0.x,Q1.y-Q0.y)<=OFFSET_DEDUPE;
      out.corners.push(same?[Q0]:[Q0,Q1]); endOn[ip]=Q0; startOn[i]=same?Q0:Q1;
    }
    out.kinds.push(kind);
  }
  for(let i=0;i<n;i++){
    const a=startOn[i], b=endOn[i], d=dirs[i];
    out.edges.push({a, b, len:(b.x-a.x)*d.x+(b.y-a.y)*d.y});
  }
  out.corners.forEach(c=>c.forEach(p=>{
    const last=out.poly[out.poly.length-1];
    if(!last || Math.hypot(p.x-last.x,p.y-last.y)>OFFSET_DEDUPE) out.poly.push(p);
  }));
  if(out.poly.length>1){ const a=out.poly[0], z=out.poly[out.poly.length-1];
    if(Math.hypot(a.x-z.x,a.y-z.y)<=OFFSET_DEDUPE) out.poly.pop(); }
  return out;
}

/* A room's interior-offset geometry, in model terms. Each edge's offset is
   effThickness/2 of the wall on that edge (effThickness only reads the
   wall's key, so the {a,b} pair stands in for the wall object). Zero-length
   edges (two loop points at identical coords, e.g. right after a detach)
   are dropped before offsetting.
   Returns {poly, area, sign, kinds, edges} where `edges[i]` corresponds to
   LOOP edge i (room.loop[i] → room.loop[i+1]) and is null for a dropped
   zero-length edge; otherwise {a, b, len, n (inward normal), half}. */
function roomInterior(f, room){
  const L=room.loop, n=L.length;
  const res={poly:[], area:0, sign:0, kinds:[], edges:new Array(n).fill(null)};
  const vs=[], halfs=[], edgeIdx=[];
  for(let i=0;i<n;i++){
    const a=ptOf(f,L[i]), b=ptOf(f,L[(i+1)%n]);
    if(!a || !b || Math.hypot(b.x-a.x,b.y-a.y)<1e-9) continue;
    vs.push({x:a.x,y:a.y}); halfs.push(effThickness(f,{a:L[i],b:L[(i+1)%n]})/2); edgeIdx.push(i);
  }
  const g=offsetPolygon(vs, halfs);
  if(!g.sign) return res;
  res.sign=g.sign; res.kinds=g.kinds; res.poly=g.poly;
  g.edges.forEach((e,k)=>{ res.edges[edgeIdx[k]]={...e, n:g.normals[k], half:halfs[k]}; });
  // Same-winding offset area. If the walls are thicker than the room is
  // wide the offset turns inside out: usually the winding flips (clamped to
  // 0 here), but a symmetric shape (a square) inverts in BOTH directions,
  // which is a 180° rotation and keeps the winding — so also treat "every
  // interior edge reversed" as no usable area. A PARTIAL collapse (one short
  // edge squeezed out between two sharp corners) yields a small bow-tie
  // whose inverted lobe the shoelace subtracts; that slight under-count is
  // accepted rather than computing a straight skeleton.
  const allReversed=g.edges.every(e=>e.len<=0);
  res.area=allReversed ? 0 : Math.max(0, g.sign*signedAreaXY(g.poly));
  return res;
}
/* Usable floor area (sq ft) inside the walls' interior faces. Centerline
   area is polyArea(); this is what the UI shows as a room's area. */
function interiorArea(f, room){ return roomInterior(f, room).area; }

/* Every room whose loop runs along wall w (edge w.a→w.b consecutive, either
   direction) — not just w.room, which only names the first room deriveWalls
   met. One entry per such loop edge: {room, edge, side} where `side` is that
   room's interior face along the wall ({a,b,len,n,half}, or null if the
   edge was degenerate). `interiors` is an optional Map roomId → roomInterior
   cache so a render pass computes each room once. */
function wallSides(f, w, interiors){
  const out=[];
  f.rooms.forEach(r=>{
    const L=r.loop;
    for(let i=0;i<L.length;i++){
      const a=L[i], b=L[(i+1)%L.length];
      if(!((a===w.a&&b===w.b)||(a===w.b&&b===w.a))) continue;
      let g=interiors && interiors.get(r.id);
      if(!g){ g=roomInterior(f,r); if(interiors) interiors.set(r.id,g); }
      out.push({room:r, edge:i, side:g.edges[i]});
    }
  });
  return out;
}

function centroid(f, loop){
  let x=0,y=0; loop.forEach(id=>{const p=ptOf(f,id); x+=p.x; y+=p.y;}); return {x:x/loop.length, y:y/loop.length};
}

/* During a corner drag, decide where the point wants to land:
   1) if near another corner -> snap onto it exactly (will weld on release)
   2) else -> align to any corner sharing an x and/or y (guide lines, no weld) */
function computeSnap(f, draggedId, rawX, rawY){
  const tolW = SNAP_PX/view.scale;
  const adj = neighborsOf(f, draggedId);
  const locked = lockedPointIds(f);
  // 1) corner snap (most specific)
  let best=null, bestD=Infinity;
  for(const p of f.points){
    if(p.id===draggedId || adj.has(p.id) || locked.has(p.id)) continue;
    const d=Math.hypot(p.x-rawX, p.y-rawY);
    if(d<=tolW && d<bestD){ bestD=d; best=p; }
  }
  if(best) return {x:best.x, y:best.y, targetId:best.id, edge:null, gx:null, gy:null};
  // 2) edge snap (snap onto a wall line, away from its endpoints)
  let bE=null, bED=Infinity, bex=0, bey=0;
  for(const w of f.walls){
    if(w.a===draggedId || w.b===draggedId) continue;
    if(locked.has(w.a) && locked.has(w.b)) continue;
    const A=ptOf(f,w.a), B=ptOf(f,w.b);
    const pr=projectPointSeg(rawX,rawY,A.x,A.y,B.x,B.y);
    if(pr.t>0.04 && pr.t<0.96){
      const d=Math.hypot(pr.x-rawX, pr.y-rawY);
      if(d<=tolW && d<bED){ bED=d; bE=w; bex=pr.x; bey=pr.y; }
    }
  }
  if(bE) return {x:snapInch(bex), y:snapInch(bey), targetId:null, edge:{a:bE.a,b:bE.b}, gx:null, gy:null};
  // 3) alignment guides
  let gx=null, gy=null, x=rawX, y=rawY, dx=tolW, dy=tolW;
  for(const p of f.points){
    if(p.id===draggedId) continue;
    const ax=Math.abs(p.x-rawX), ay=Math.abs(p.y-rawY);
    if(ax<dx){ dx=ax; x=p.x; gx=p.x; }
    if(ay<dy){ dy=ay; y=p.y; gy=p.y; }
  }
  return {x,y,targetId:null,edge:null,gx,gy};
}

function projectPointSeg(px,py,ax,ay,bx,by){
  const dx=bx-ax, dy=by-ay; const L2=dx*dx+dy*dy;
  let t = L2>0 ? ((px-ax)*dx+(py-ay)*dy)/L2 : 0;
  t=Math.max(0,Math.min(1,t));
  return {x:ax+t*dx, y:ay+t*dy, t};
}

/* ---------- click hit-testing (click-to-cycle through overlapping geometry) ----------
   Two walls, or two corner points, can sit exactly on top of each other —
   e.g. right after detachRoom/detachCorner, which mint fresh point ids at
   the same coordinates. These return EVERY candidate near a world point so
   js/tools.js can cycle through them on repeated clicks (cycleTarget).

   Order is "top to bottom", i.e. TOPMOST FIRST: js/render.js appends wall
   bands (gWalls) and corner handles (gHandles) in f.walls / f.points array
   order, and the later-painted SVG element wins pointer hit-testing, so the
   LAST array entry is the one drawn on top. Both functions therefore walk
   the array back to front.

   Pure geometry: tolerances are in WORLD units (feet); converting a screen-
   pixel radius into feet (view.scale) is the caller's job. */

/* Walls whose centerline segment passes within `tol` of (x,y). `tol` is a
   number, or a function w → number for a per-wall radius (e.g. half the
   wall's drawn band). Returns wall objects, topmost first. */
function wallsNear(f, x, y, tol){
  const out=[];
  for(let i=f.walls.length-1;i>=0;i--){
    const w=f.walls[i]; const A=ptOf(f,w.a), B=ptOf(f,w.b); if(!A || !B) continue;
    const pr=projectPointSeg(x,y,A.x,A.y,B.x,B.y);
    const r = typeof tol==="function" ? tol(w) : tol;
    if(Math.hypot(pr.x-x, pr.y-y) <= r) out.push(w);
  }
  return out;
}

/* Distinct corner points within `tol` (default MERGE_TOL, the "same spot"
   radius welding uses) of (x,y). Point ids are the unit of identity: a
   corner WELDED across several rooms is a single f.points entry, so it
   yields exactly one candidate — only unwelded-but-coincident points (e.g.
   after "Detach junction") produce more than one. Topmost first. */
function pointsNear(f, x, y, tol=MERGE_TOL){
  const out=[];
  for(let i=f.points.length-1;i>=0;i--){
    const p=f.points[i];
    if(Math.hypot(p.x-x, p.y-y) <= tol) out.push(p);
  }
  return out;
}

/* Room-drag snapping: given the room's corners (at start positions) and the
   proposed delta, find the smallest correction that lands a corner on another
   corner, or aligns a corner to a shared x/y. Returns adjusted delta + viz. */
function computeRoomSnap(f, starts, dx, dy){
  const tolW = SNAP_PX/view.scale;
  const inRoom = new Set(starts.map(s=>s.id));
  const locked = lockedPointIds(f);
  let target=null, src=null, bestD=Infinity;
  for(const s of starts){
    const cx=s.x+dx, cy=s.y+dy;
    for(const p of f.points){
      if(inRoom.has(p.id) || locked.has(p.id)) continue;
      const d=Math.hypot(p.x-cx, p.y-cy);
      if(d<=tolW && d<bestD){ bestD=d; target=p; src=s; }
    }
  }
  if(target) return {dx:target.x-src.x, dy:target.y-src.y, targetId:target.id, gx:null, gy:null};
  let gx=null, gy=null, adjx=0, adjy=0, bx=tolW, by=tolW;
  for(const s of starts){
    const cx=s.x+dx, cy=s.y+dy;
    for(const p of f.points){
      if(inRoom.has(p.id)) continue;
      const ax=p.x-cx; if(Math.abs(ax)<bx){ bx=Math.abs(ax); adjx=ax; gx=p.x; }
      const ay=p.y-cy; if(Math.abs(ay)<by){ by=Math.abs(ay); adjy=ay; gy=p.y; }
    }
  }
  return {dx:dx+adjx, dy:dy+adjy, targetId:null, gx, gy};
}
