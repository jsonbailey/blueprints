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

/* Walls are DERIVED from room loops: every edge of every room is a wall, and an
   edge shared by two rooms is one wall. Stable id keyed on the endpoint pair, so
   selection survives moves; topology edits just rebuild this. */
function deriveWalls(f){
  const seen=new Map(); const walls=[];
  f.rooms.forEach(r=>{
    const L=r.loop;
    for(let i=0;i<L.length;i++){
      const a=L[i], b=L[(i+1)%L.length];
      if(a===b) continue;
      const key=[a,b].slice().sort().join("|");
      if(seen.has(key)) continue;
      const w={id:"w_"+key, a, b, room:r.id}; seen.set(key,w); walls.push(w);
    }
  });
  f.walls=walls;
  return f;
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
  f.rooms.forEach(r=>{
    r.loop = r.loop.map(id=>id===fromId?toId:id);
    // collapse any consecutive duplicates created by the weld
    const out=[]; for(let i=0;i<r.loop.length;i++){ if(r.loop[i]!==r.loop[(i+1)%r.loop.length]) out.push(r.loop[i]); }
    r.loop = out.length>=3 ? out : r.loop;
  });
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
  room.loop = room.loop.map(id=>map.get(id)||id);
  f._pt=new Map(f.points.map(p=>[p.id,p]));
  gcPoints(f); deriveWalls(f);
}

/* Detach a corner: give every room meeting there its own copy, fully separating
   the junction. Re-snap by dragging the pieces back together. */
function detachCorner(f, id){
  const rs=roomsAt(f,id);
  rs.forEach((room,idx)=>{
    if(idx===0) return;                 // first room keeps the original id
    const p=ptOf(f,id); const nid="p"+(_pid++);
    f.points.push({x:p.x,y:p.y,id:nid});
    room.loop = room.loop.map(x=>x===id?nid:x);
  });
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
  gcPoints(f); deriveWalls(f);
  return {changed, dropped, err:false};
}

/* Mint a new level (fresh unique id, visible) whose geometry is built from
   seed rectangles — [] for a blank level. */
function makeLevel(name, rects){
  const g = buildLevel(rects||[]);
  return indexLevel({id:"lvl"+(_lid++), name, visible:true, points:g.points, walls:g.walls, rooms:g.rooms});
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
