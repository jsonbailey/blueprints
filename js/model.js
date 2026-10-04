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

/* Merge the props of several walls collapsing into one key. `list` is in
   priority order (the first is "the first wall"); undefined = a wall with no
   entry (defaults: inherits thickness, not open). Rules (ARCHITECTURE.md):
   - thickness: the first contributor that has an explicit override wins;
   - open: only if EVERY contributor was open (then no thickness kept);
   - any other field: first contributor that has it wins.
   TODO(item 4): openings should be concatenated with the later walls'
   offsets shifted by the earlier walls' lengths; for now the winning
   contributor's `openings` (if any) are kept as-is. */
function mergeWallProps(list){
  const out={};
  for(let i=list.length-1;i>=0;i--) if(list[i]) Object.assign(out, JSON.parse(JSON.stringify(list[i])));
  const tSrc=list.find(p=>p && isValidThickness(p.thickness));
  if(tSrc) out.thickness=tSrc.thickness; else delete out.thickness;
  if(list.length && list.every(p=>p && p.open===true)){ out.open=true; delete out.thickness; }
  else delete out.open;
  return out;
}

/* Re-key wall references (today: wallProps; item 5 adds object anchors) across
   a topology change. Must run AFTER room loops are rewritten but BEFORE the
   deriveWalls() that ends the op (whose prune removes the now-dead old keys).
   This function only ever WRITES new keys; deleting dead ones is left to the
   prune, so a key that is still a live wall (e.g. the neighbour's side of a
   detached shared wall) keeps its props automatically.

   op shapes:
   - {kind:"split", a, b, mid}: wall a|b gained point `mid` (divideWall,
     insertPointOnWall). Both halves get a copy of thickness/open.
     TODO(item 4): assign each opening to the half containing it, shifting
     the second half's offsets by the split position, and pick a policy for
     an opening straddling the split. Until then openings are not carried
     (none exist yet).
   - {kind:"detach", pairs:[[oldKey,newKey],...]}: a wall was duplicated
     onto fresh point ids (detachRoom, detachCorner). The new key gets a
     copy of thickness/open; openings move to the new key only if the old
     key is no longer a live wall (so they never appear on both sides).
   - {kind:"merge", pairs:[[oldKey,newKey|null],...]}: point ids were
     substituted/removed so several old keys may land on one new key
     (weldPoints, deletePoint). Include an identity pair [k,k] for any wall
     already at a target key, so it counts as a contributor (and as "the
     first wall"). newKey null = collapsed to zero length → props dropped. */
function remapWallRefs(f, op){
  if(!f.wallProps) f.wallProps={};
  const wp=f.wallProps;
  if(op.kind==="split"){
    const p=wp[wallKey(op.a,op.b)]; if(!p) return;
    [wallKey(op.a,op.mid), wallKey(op.mid,op.b)].forEach(k=>{ wp[k]=_propsSansOpenings(p); });
  } else if(op.kind==="detach"){
    const live=liveWallKeys(f), movedOpenings=new Set();
    op.pairs.forEach(([o,n])=>{
      if(!o || !n || o===n || !wp[o]) return;
      const c=_propsSansOpenings(wp[o]);
      if(wp[o].openings && !live.has(o) && !movedOpenings.has(o)){ c.openings=JSON.parse(JSON.stringify(wp[o].openings)); movedOpenings.add(o); }
      wp[n]=c;
    });
  } else if(op.kind==="merge"){
    const groups=new Map();
    op.pairs.forEach(([o,n])=>{
      if(!o || !n) return;
      if(!groups.has(n)) groups.set(n,[]);
      const g=groups.get(n); if(!g.includes(o)) g.push(o);
    });
    groups.forEach((olds,n)=>{
      if(olds.every(o=>o===n)) return;                        // untouched wall
      const order=olds.includes(n) ? [n, ...olds.filter(o=>o!==n)] : olds;
      if(!order.some(k=>wp[k])) return;                      // nothing to carry
      const m=mergeWallProps(order.map(k=>wp[k]));
      if(Object.keys(m).length) wp[n]=m; else delete wp[n];
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
  f.points.push(mid);
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
  f.points.push(mid);
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
    wallProps:{}, defaultThickness:DEFAULT_WALL_THICKNESS});
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
