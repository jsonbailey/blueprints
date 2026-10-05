"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./harness");

/* Wall-anchored objects (ARCHITECTURE.md item 5, anchored half):
   anchor = {wall, edge, along, gap}; resolveObjects() caches x/y/rot.

   EDGE NAMES (js/model.js): in the object's local, pre-mirror frame — the
   one objectLocalToScreen draws through, where at rot=0 local lx (width,
   [-w/2,w/2]) → world +x and ld (depth, [-d/2,d/2]) → world +y:
     back = ld=-d/2, front = ld=+d/2, left = lx=-w/2, right = lx=+w/2.

   Geometry is checked two ways: against hand-worked numbers, and against
   the RENDER transform itself — objectLocalToScreen with view scale 1 and
   origin 0 turns local box corners into world points, so the tests assert
   where the drawn box actually lands rather than re-deriving the pose with
   the same math the implementation uses. */

const SETUP = `
  const P = (id,x,y)=>({id,x,y});
  function install(f){ indexLevel(f); data.levels=[f]; data.activeLevelId=f.id; history.length=0; sel={type:null,id:null}; return f; }
  /* 10x10 room A: a1(0,0) a2(10,0) a3(10,10) a4(0,10). Positive signed
     area, so a1→a2 (dir +x) has inward normal (0,1): the room is BELOW it
     on screen (+y). */
  function setupRoom(){
    const f = makeLevel("T", []);
    f.points = [P("a1",0,0),P("a2",10,0),P("a3",10,10),P("a4",0,10)];
    f.rooms = [{id:"rA",name:"A",kind:"room",loop:["a1","a2","a3","a4"]}];
    return install(f);
  }
  /* A plus room B to its right (b1..b4 at x 10..20), NOT welded. */
  function setupTwoRooms(){
    const f = makeLevel("T", []);
    f.points = [P("a1",0,0),P("a2",10,0),P("a3",10,10),P("a4",0,10),
                P("b1",10,0),P("b2",20,0),P("b3",20,10),P("b4",10,10)];
    f.rooms = [{id:"rA",name:"A",kind:"room",loop:["a1","a2","a3","a4"]},
               {id:"rB",name:"B",kind:"room",loop:["b1","b2","b3","b4"]}];
    return install(f);
  }
  /* A 10x10 square rotated so its first wall a→b runs from (0,0) to (8,6)
     (dir (0.8,0.6), length 10); inward normal of a→b is (-0.6,0.8). */
  function setupDiagonal(){
    const f = makeLevel("D", []);
    f.points = [P("a",0,0),P("b",8,6),P("c",2,14),P("d",-6,8)];
    f.rooms = [{id:"rD",name:"D",kind:"room",loop:["a","b","c","d"]}];
    return install(f);
  }
  const W = (f,a,b) => wallById(f, wallIdForKey(wallKey(a,b)));
  function obj(f, x, y, w, d){ const o=addObject(f, "table", x, y); o.w=w; o.d=d; return o; }
  /* world corners of the box via the RENDER transform (scale 1, origin 0) */
  function worldOf(o, lx, ld){ view.scale=1; view.ox=0; view.oy=0; const [x,y]=objectLocalToScreen(o)(lx,ld); return {x,y}; }
  /* the two corners of a named edge, in local pre-mirror coords */
  function edgeCorners(o, e){ const w=o.w/2, d=o.d/2;
    return {back:[[-w,-d],[w,-d]], front:[[-w,d],[w,d]], left:[[-w,-d],[-w,d]], right:[[w,-d],[w,d]]}[e]; }
  /* signed distance of world point Q from wall key's centerline, measured
     along roomId's inward normal (positive = into the room) */
  function distIn(f, key, roomId, Q){
    const fr=wallFrame(f,key), s=wallSides(f,{a:fr.lo,b:fr.hi}).find(s=>s.room.id===roomId);
    return (Q.x-fr.A.x)*s.side.n.x + (Q.y-fr.A.y)*s.side.n.y;
  }
  const r6 = v => Math.round(v*1e6)/1e6;
  const pos = o => ({x:r6(o.x), y:r6(o.y), rot:r6(o.rot)});
`;
function vmRun(run, body, args) {
  const fn = `(args)=>{ ${SETUP} ${body} }`;
  return run({ toString: () => fn }, args === undefined ? null : args);
}
const near = (a, b, msg, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${msg}: expected ${b}, got ${a}`);
const sameAngle = (a, b, msg) => near(((a - b) % 360 + 540) % 360 - 180, 0, msg);

/* ---------------- the hand-worked case first ---------------- */

/* Horizontal wall a1(0,0) → a2(10,0), room below it (n = (0,1)), wall
   thickness 0.5 ft → interior face at y = 0.25. Object w=2, d=4, edge
   "back", gap 0, along 5:
     wall centerline point at along 5 = (5, 0);
     interior face point            = (5, 0.25);
     back edge is ld = -d/2 = -2; at rot 0 that's world y = o.y - 2, and it
     must sit on the face → o.y = 0.25 + 0 + 2 = 2.25;
     o.x = 5 (center along the wall), rot = 0 (back's outward normal (0,-1)
     already points at the wall, i.e. along -n).
   With gap 1.5 the whole thing shifts by 1.5: o.y = 3.75. */
test("hand-worked: back edge flush on a horizontal wall → x=5, y=0.25+gap+d/2, rot=0", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupRoom();
    setWallThickness(f, W(f,"a1","a2"), 0.5);
    const o = obj(f, 5, 5, 2, 4);
    o.anchor = {wall:"a1|a2", edge:"back", along:5, gap:0};
    resolveObjects(f);
    const g0 = {...pos(o), back:edgeCorners(o,"back").map(([lx,ld])=>worldOf(o,lx,ld)),
                front:edgeCorners(o,"front").map(([lx,ld])=>worldOf(o,lx,ld))};
    o.anchor.gap = 1.5; resolveObjects(f);
    return { g0, g15: pos(o), anchor: o.anchor };
  `);
  near(r.g0.x, 5, "x"); near(r.g0.y, 2.25, "y"); near(r.g0.rot, 0, "rot");
  // via the actual render transform: the back edge lies ON the face, the
  // front edge d=4 further into the room
  r.g0.back.forEach(p => near(p.y, 0.25, "back corner on the interior face"));
  assert.deepEqual(r.g0.back.map(p => +p.x.toFixed(6)).sort((a, b) => a - b), [4, 6], "back edge spans x 4..6");
  r.g0.front.forEach(p => near(p.y, 4.25, "front corner 4 ft into the room"));
  near(r.g15.x, 5, "x (gap 1.5)"); near(r.g15.y, 3.75, "y (gap 1.5)"); near(r.g15.rot, 0, "rot (gap 1.5)");
  assert.ok(r.anchor, "still anchored");
});

/* Diagonal wall a(0,0) → b(8,6): dir (0.8,0.6), inward n = (-0.6,0.8),
   thickness 0.5 (half 0.25). w=2 d=4, back, gap 1, along 5:
     centerline point (4,3); center = (4,3) + n*(0.25 + 1 + 2)
                                    = (4 - 1.95, 3 + 2.6) = (2.05, 5.6);
     rot: back's normal (0,-1) rotated by θ is (sinθ, -cosθ) and must equal
     -n = (0.6,-0.8) → sinθ = 0.6, cosθ = 0.8 → θ = atan2(0.6,0.8) ≈ 36.8699°
     (the wall's own angle — the object sits square to the wall). */
test("hand-worked: non-axis-aligned wall gives a non-zero rot and squares the edge to the wall", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupDiagonal();
    setWallThickness(f, W(f,"a","b"), 0.5);
    const o = obj(f, 2, 6, 2, 4);
    o.anchor = {wall:"a|b", edge:"back", along:5, gap:1};
    resolveObjects(f);
    const back = edgeCorners(o,"back").map(([lx,ld])=>distIn(f,"a|b","rD",worldOf(o,lx,ld)));
    const front = edgeCorners(o,"front").map(([lx,ld])=>distIn(f,"a|b","rD",worldOf(o,lx,ld)));
    const fr = wallFrame(f,"a|b");
    return { p: pos(o), back, front, centerAlong: worldToAlong(fr, o) };
  `);
  near(r.p.x, 2.05, "x"); near(r.p.y, 5.6, "y");
  near(r.p.rot, Math.atan2(0.6, 0.8) * 180 / Math.PI, "rot = wall angle");
  r.back.forEach(d => near(d, 1.25, "back corners at half + gap from the centerline"));
  r.front.forEach(d => near(d, 5.25, "front corners a further d into the room"));
  near(r.centerAlong, 5, "center projects to `along`");
});

test("left/right edges and mirror: the NAMED edge faces the wall (mirror flips rot by 180°)", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupRoom();                     // default thickness 4.5" → half 0.1875
    const o = obj(f, 5, 5, 2, 4);
    const out = {};
    for (const mirror of [false, true]) {
      o.mirror = mirror;
      o.anchor = {wall:"a1|a2", edge:"left", along:5, gap:0};
      resolveObjects(f);
      out[mirror] = { p: pos(o), left: edgeCorners(o,"left").map(([lx,ld])=>worldOf(o,lx,ld).y),
                      right: edgeCorners(o,"right").map(([lx,ld])=>worldOf(o,lx,ld).y) };
    }
    return out;
  `);
  // left edge (lx = -w/2) on the face y = 0.1875; the box extends w = 2 into the room
  near(r.false.p.rot, 90, "unmirrored left → rot 90");
  near(r.false.p.y, 0.1875 + 1, "center w/2 past the face");
  r.false.left.forEach(y => near(y, 0.1875, "left edge on the face"));
  r.false.right.forEach(y => near(y, 2.1875, "right edge w into the room"));
  near(r.true.p.rot, 270, "mirrored left → rot 270");
  r.true.left.forEach(y => near(y, 0.1875, "mirrored: the named left edge is still the one on the face"));
});

test("property: every wall × edge × mirror of a rotated room puts the named edge at half+gap, square to the wall", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupDiagonal();
    setWallThickness(f, W(f,"b","c"), 0.5);
    const o = obj(f, 1, 7, 1.5, 3);
    const out = [];
    loopWallKeys(f.rooms[0].loop).forEach(key => {
      const half = effThickness(f, {a:key.split("|")[0], b:key.split("|")[1]})/2;
      ["back","front","left","right"].forEach(edge => [false,true].forEach(mirror => {
        o.mirror = mirror; o.anchor = {wall:key, edge, along:3, gap:0.75};
        resolveObjects(f);
        const all = [[-0.75,-1.5],[0.75,-1.5],[0.75,1.5],[-0.75,1.5]].map(([lx,ld])=>distIn(f,key,"rD",worldOf(o,lx,ld)));
        const named = edgeCorners(o,edge).map(([lx,ld])=>distIn(f,key,"rD",worldOf(o,lx,ld)));
        out.push({key, edge, mirror, half, named, min: Math.min(...all), along: worldToAlong(wallFrame(f,key), o)});
      }));
    });
    return out;
  `);
  assert.equal(r.length, 4 * 4 * 2);
  r.forEach(c => {
    const tag = `${c.key} ${c.edge} mirror=${c.mirror}`;
    c.named.forEach(d => near(d, c.half + 0.75, `${tag}: named edge at half+gap (and parallel: both corners equal)`));
    near(c.min, c.half + 0.75, `${tag}: no part of the box is closer to the wall than the named edge`);
    near(c.along, 3, `${tag}: center along`);
  });
});

/* ---------------- resolveObjects follows the wall ---------------- */

test("resolveObjects: follows a wall drag LIVE, a thickness change, and a corner drag that tilts the wall", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupRoom();
    let o; commit(()=>{ o = obj(f, 5, 5, 2, 4); o.anchor = {wall:"a2|a3", edge:"back", along:5, gap:0.5}; });
    const start = pos(o);                         // right wall x=10, n=(-1,0): x = 10 - 0.1875 - 0.5 - 2
    // slide the wall a2|a3 2 ft right; check mid-drag (before end) too
    startDragWall({ clientX: 0, clientY: 0, stopPropagation(){}, pointerId: 1 }, W(f,"a2","a3").id);
    interactionHandlers.wall.move(interaction, { clientX: 2*view.scale, clientY: 0 });
    const live = pos(o);
    interactionHandlers.wall.end(interaction);
    commit(()=>{ setWallThickness(f, W(f,"a2","a3"), 1.0); });
    const thick = pos(o);
    // tilt: drag corner a3 from (12,10) to (14,10) — a2 stays at (12,0)
    commit(()=>{ ptOf(f,"a3").x = 14; });
    const tilted = { p: pos(o), back: edgeCorners(o,"back").map(([lx,ld])=>distIn(f,"a2|a3","rA",worldOf(o,lx,ld))),
                     along: worldToAlong(wallFrame(f,"a2|a3"), o) };
    return { start, live, thick, tilted, anchor: o.anchor };
  `);
  near(r.start.x, 10 - 0.1875 - 0.5 - 2, "start x"); near(r.start.y, 5, "start y"); near(r.start.rot, 90, "start rot");
  near(r.live.x, 12 - 0.1875 - 0.5 - 2, "followed the wall during the drag");
  near(r.thick.x, 12 - 0.5 - 0.5 - 2, "gap measured from the NEW interior face (half 0.5)");
  r.tilted.back.forEach(d => near(d, 0.5 + 0.5, "tilted wall: back edge still flush at half+gap, square to it"));
  near(r.tilted.along, 5, "tilted wall: center still at along 5");
  assert.ok(Math.abs(r.tilted.p.rot - 90) > 1, "rot follows the wall's new angle");
  assert.ok(r.anchor);
});

/* ---------------- invalid anchors ---------------- */

test("invalid anchor → null, object left exactly at its last resolved pose (room deleted / reparented / wall gone)", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const out = {};
    // (1) room deleted through the inspector
    { const f = setupRoom();
      let o; commit(()=>{ o = obj(f, 5, 5, 2, 4); anchorObject(f, o, "a1|a2", {edge:"back", along:3, gap:1}); });
      const before = pos(o);
      sel = {type:"room", id:"rA"}; renderInspector(); document.getElementById("delRoom").onclick();
      out.deleted = { before, after: pos(o), anchor: o.anchor, roomId: o.roomId }; }
    // (2) reparented to a room whose loop doesn't have that wall
    { const f = setupTwoRooms();
      let o; commit(()=>{ o = obj(f, 5, 5, 2, 4); anchorObject(f, o, "a1|a2", {edge:"back", along:3, gap:1}); });
      const before = pos(o);
      commit(()=>{ o.roomId = "rB"; });
      out.reparented = { before, after: pos(o), anchor: o.anchor }; }
    // (3) the wall key disappears from the room's loop entirely
    { const f = setupRoom();
      let o; commit(()=>{ o = obj(f, 5, 5, 2, 4); anchorObject(f, o, "a1|a2", {edge:"back", along:3, gap:1}); });
      const before = pos(o);
      commit(()=>{ f.points.push(P("q",5,-2)); f._pt.set("q", f.points[f.points.length-1]);
                   f.rooms[0].loop = ["a1","q","a2","a3","a4"]; deriveWalls(f); });
      out.gone = { before, after: pos(o), anchor: o.anchor }; }
    return out;
  `);
  for (const k of ["deleted", "reparented", "gone"]) {
    assert.equal(r[k].anchor, null, `${k}: unanchored`);
    assert.deepEqual(r[k].after, r[k].before, `${k}: stays at its last resolved position`);
  }
  assert.equal(r.deleted.roomId, null);
});

test("an unanchored object is free from then on: a later wall move doesn't touch it", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    let o; commit(()=>{ o = obj(f, 5, 5, 2, 4); anchorObject(f, o, "a1|a2"); });
    commit(()=>{ o.roomId = "rB"; });            // invalid → free
    const before = pos(o);
    commit(()=>{ ptOf(f,"a1").y = -3; ptOf(f,"a2").y = -3; });
    return { before, after: pos(o), anchor: o.anchor };
  `);
  assert.equal(r.anchor, null);
  assert.deepEqual(r.after, r.before);
});

/* ---------------- re-keying (mirrors test/openings.test.js) ----------------
   Each case checks the expected `along` AND that the resolved world pose is
   unchanged across the op (the frame-independent ground truth). */

test("split (divideWall, 'z' ids): both halves have lo = mid; the FIRST half is reversed", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = makeLevel("Z", []);
    f.points = [P("z1",0,0),P("z2",10,0),P("z3",10,10),P("z4",0,10)];
    f.rooms = [{id:"rZ",name:"Z",kind:"room",loop:["z1","z2","z3","z4"]}];
    install(f);
    let o1, o2;
    commit(()=>{ o1 = obj(f, 3, 5, 1, 1); o2 = obj(f, 7, 5, 1, 1);
      anchorObject(f, o1, "z1|z2", {edge:"back", along:3, gap:1});
      anchorObject(f, o2, "z1|z2", {edge:"back", along:7, gap:1}); });
    const before = [pos(o1), pos(o2)];
    let mid; commit(()=>{ mid = divideWall(f, W(f,"z1","z2")); });   // mid (5,0), "pt…" < "z…"
    return { mid, before, after: [pos(o1), pos(o2)], a1: o1.anchor, a2: o2.anchor };
  `);
  assert.equal(r.a1.wall, `${r.mid}|z1`); near(r.a1.along, 2, "reversed half mid(5)→z1(0): 5 - 3");
  assert.equal(r.a2.wall, `${r.mid}|z2`); near(r.a2.along, 2, "same-direction half: 7 - 5");
  assert.deepEqual(r.after, r.before, "neither object moved");
});

test("split (insertPointOnWall, 'a' ids): the SECOND half is reversed", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupRoom();
    let o1, o2;
    commit(()=>{ o1 = obj(f, 5, 2, 1, 1); o2 = obj(f, 5, 7, 1, 1);
      anchorObject(f, o1, "a2|a3", {edge:"back", along:2, gap:0.5});
      anchorObject(f, o2, "a2|a3", {edge:"back", along:7, gap:0.5}); });
    const before = [pos(o1), pos(o2)];
    let mid; commit(()=>{ mid = insertPointOnWall(f, "a2", "a3", 10, 4); });
    return { mid, before, after: [pos(o1), pos(o2)], a1: o1.anchor, a2: o2.anchor };
  `);
  assert.equal(r.a1.wall, `a2|${r.mid}`); near(r.a1.along, 2, "a2(10,0)→mid(10,4): unchanged");
  assert.equal(r.a2.wall, `a3|${r.mid}`); near(r.a2.along, 3, "reversed: a3(10,10)→mid: 10 - 7");
  assert.deepEqual(r.after, r.before);
});

/* Same hand-worked numbers as openings' deletePoint test: "a2|m" has lo a2
   at x=10 and runs −x (REVERSED vs the merged a1|a2); along 2 there is
   x = 8 → merged along (6 − 2) + 4 = 8. A naive "+ first wall's length"
   gives 6. */
test("merge (deletePoint): the reversed contributor is flipped then shifted", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupRoom();
    f.points.push(P("m",4,0)); f._pt.set("m", f.points[f.points.length-1]);
    f.rooms[0].loop = ["a1","m","a2","a3","a4"]; deriveWalls(f);
    let o1, o2;
    commit(()=>{ o1 = obj(f, 1, 3, 1, 1); o2 = obj(f, 8, 3, 1, 1);
      anchorObject(f, o1, "a1|m", {edge:"back", along:1, gap:0.5});
      anchorObject(f, o2, "a2|m", {edge:"back", along:2, gap:0.5}); });
    const before = [pos(o1), pos(o2)];
    deletePoint(f, "m");
    return { before, after: [pos(o1), pos(o2)], a1: o1.anchor, a2: o2.anchor };
  `);
  assert.equal(r.a1.wall, "a1|a2"); near(r.a1.along, 1, "same-direction contributor");
  assert.equal(r.a2.wall, "a1|a2"); near(r.a2.along, 8, "reversed contributor: (6 - 2) + 4");
  assert.deepEqual(r.after, r.before, "neither moved");
});

/* Openings' weld case: B's left wall "b1|b9" has lo b1 at (10,10) and runs
   UP; an object in B at along 2 (world y = 8). Welding b9→a2, b1→a3 makes
   it "a2|a3" (runs DOWN) → along 8, and the face is still B's (n = +x). */
test("merge (weldPoints): reversed wall re-based; each object keeps its own room's face", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = makeLevel("T", []);
    f.points = [P("a1",0,0),P("a2",10,0),P("a3",10,10),P("a4",0,10),
                P("b9",10,0),P("b2",20,0),P("b3",20,10),P("b1",10,10)];
    f.rooms = [{id:"rA",name:"A",kind:"room",loop:["a1","a2","a3","a4"]},
               {id:"rB",name:"B",kind:"room",loop:["b9","b2","b3","b1"]}];
    install(f);
    let oa, ob;
    commit(()=>{ oa = obj(f, 8, 3, 1, 2); ob = obj(f, 12, 8, 1, 2);
      anchorObject(f, oa, "a2|a3", {edge:"back", along:3, gap:0.25});
      anchorObject(f, ob, "b1|b9", {edge:"back", along:2, gap:0.25}); });
    const before = [pos(oa), pos(ob)];
    commit(()=>{ weldPoints(f, "b9", "a2"); });
    commit(()=>{ weldPoints(f, "b1", "a3"); });
    return { before, after: [pos(oa), pos(ob)], aa: oa.anchor, ab: ob.anchor };
  `);
  assert.equal(r.aa.wall, "a2|a3"); near(r.aa.along, 3, "A's own anchor untouched");
  assert.equal(r.ab.wall, "a2|a3"); near(r.ab.along, 8, "B's anchor flipped into the merged frame");
  assert.deepEqual(r.after, r.before, "both stay on their own side of the now-shared wall");
  assert.ok(r.after[1].x > 10, "B's object is still on B's side (x > 10)");
});

/* Adversarial: the object is in room A, anchored to the shared wall m|p at
   along 7 (x = 3). Deleting m sends that key to p|q in A and p|u in B; the
   point (3,0) is NEARER to B's p|u (which is what openings, being
   room-agnostic, pick) — but an anchor must follow its own room's wall. */
test("merge (deletePoint) on a corner shared by two rooms: the anchor follows ITS room's wall, not the nearest", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = makeLevel("T", []);
    f.points = [P("p",0,0),P("m",10,0),P("q",10,10),P("s",0,10),P("t",0,-4),P("u",10,-4)];
    f.rooms = [{id:"rA",name:"A",kind:"room",loop:["p","m","q","s"]},
               {id:"rB",name:"B",kind:"room",loop:["m","p","t","u"]}];
    install(f);
    let oa, ob;
    commit(()=>{ oa = obj(f, 3, 2, 1, 1); ob = obj(f, 3, -2, 1, 1);
      anchorObject(f, oa, "m|p", {edge:"back", along:7, gap:0.5});
      anchorObject(f, ob, "m|p", {edge:"back", along:7, gap:0.5}); });
    deletePoint(f, "m");
    return { aa: oa.anchor, ab: ob.anchor };
  `);
  assert.ok(r.aa, "A's object still anchored");
  assert.equal(r.aa.wall, "p|q", "A's object follows A's new wall p|q");
  assert.ok(r.ab);
  assert.equal(r.ab.wall, "p|u", "B's object follows B's new wall p|u");
});

test("merge: a weld that collapses the anchor's wall to zero length unanchors it (via resolveObjects)", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupRoom();
    f.points.push(P("a5",5,0)); f._pt.set("a5", f.points[f.points.length-1]);
    f.rooms[0].loop = ["a1","a5","a2","a3","a4"]; deriveWalls(f);
    let o; commit(()=>{ o = obj(f, 7, 3, 1, 1); anchorObject(f, o, "a2|a5", {edge:"back", along:2, gap:0.5}); });
    const before = pos(o);
    commit(()=>{ weldPoints(f, "a5", "a2"); });
    return { before, after: pos(o), anchor: o.anchor };
  `);
  assert.equal(r.anchor, null);
  assert.deepEqual(r.after, r.before);
});

test("detachRoom on a shared wall: each anchor follows its OWN room's key; B's is re-based through a reversed frame", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    weldPoints(f, "b1", "a2"); weldPoints(f, "b4", "a3");   // A and B share a2|a3; B = [a2,b2,b3,a3]
    let oa, ob;
    commit(()=>{ oa = obj(f, 8, 3, 1, 1); ob = obj(f, 12, 3, 1, 1);
      anchorObject(f, oa, "a2|a3", {edge:"back", along:3, gap:0.5});
      anchorObject(f, ob, "a2|a3", {edge:"back", along:3, gap:0.5}); });
    const before = [pos(oa), pos(ob)];
    _pid = 9;                                                // a2→p9, b2→p10, b3→p11, a3→p12
    commit(()=>{ detachRoom(f, f.rooms[1]); });
    return { before, after: [pos(oa), pos(ob)], aa: oa.anchor, ab: ob.anchor,
      bKeys: loopWallKeys(f.rooms[1].loop) };
  `);
  assert.equal(r.aa.wall, "a2|a3", "A kept the original ids, so its anchor stays");
  near(r.aa.along, 3, "A unchanged");
  assert.equal(r.ab.wall, "p12|p9", "B's anchor moved to B's new copy of the wall");
  assert.ok(r.bKeys.includes(r.ab.wall));
  near(r.ab.along, 7, "\"p12\" < \"p9\": frame reversed, 10 - 3 (a copy-as-is would leave 3)");
  assert.deepEqual(r.after, r.before, "neither object moved");
});

test("detachCorner on a shared wall: the non-first room's anchor follows its new key", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    weldPoints(f, "b1", "a2"); weldPoints(f, "b4", "a3");
    let oa, ob;
    commit(()=>{ oa = obj(f, 8, 6, 1, 1); ob = obj(f, 12, 6, 1, 1);
      anchorObject(f, oa, "a2|a3", {edge:"back", along:6, gap:0.5});
      anchorObject(f, ob, "a2|a3", {edge:"back", along:6, gap:0.5}); });
    const before = [pos(oa), pos(ob)];
    commit(()=>{ detachCorner(f, "a2"); });
    return { before, after: [pos(oa), pos(ob)], aa: oa.anchor, ab: ob.anchor, bKeys: loopWallKeys(f.rooms[1].loop) };
  `);
  assert.equal(r.aa.wall, "a2|a3");
  assert.notEqual(r.ab.wall, "a2|a3");
  assert.ok(r.bKeys.includes(r.ab.wall), "B's anchor is on a wall of B's loop");
  assert.deepEqual(r.after, r.before);
});

test("detach of an unshared wall: anchor follows to the new key, re-based when fresh ids sort the other way", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupRoom();
    let o; commit(()=>{ o = obj(f, 2, 3, 1, 1); anchorObject(f, o, "a1|a2", {edge:"back", along:2, gap:0.5}); });
    const before = pos(o);
    _pid = 9;                                                // a1→p9, a2→p10
    commit(()=>{ detachRoom(f, f.rooms[0]); });
    return { before, after: pos(o), a: o.anchor };
  `);
  assert.equal(r.a.wall, "p10|p9");
  near(r.a.along, 8, "10 - 2");
  assert.deepEqual(r.after, r.before);
});

/* ---------------- movement rules ---------------- */

test("carry-along: an anchored object is not carried by nudgeRoom — it moves once, via its wall", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupRoom();
    let o; commit(()=>{ o = obj(f, 5, 5, 2, 4); anchorObject(f, o, "a1|a2", {edge:"back", along:5, gap:1}); });
    const before = pos(o);
    nudgeRoom(f.rooms[0], "right");
    return { before, after: pos(o), step: opts.snap };
  `);
  near(r.after.x - r.before.x, r.step, "moved by exactly one nudge step (not two)");
  near(r.after.y, r.before.y, "y unchanged");
});

/* ---------------- dragging + unanchor ---------------- */

test("drag: edits along/gap (not x/y directly), clamps gap >= 0 and along to the wall, lazy undo, never unanchors", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupRoom();
    let o; commit(()=>{ o = obj(f, 5, 5, 2, 4); anchorObject(f, o, "a1|a2", {edge:"back", along:5, gap:1}); });
    const h0 = history.length;
    const ev = (x,y,alt) => ({ clientX: x*view.scale, clientY: y*view.scale, altKey: !!alt, stopPropagation(){}, pointerId: 1 });
    // a click with no movement: no undo entry
    startDragObject(ev(5,5), o.id);
    const kind = interaction.kind;
    interactionHandlers[kind].end(interaction);
    const hClick = history.length;
    // drag +2 along (x) and +1.5 away (y)
    startDragObject(ev(5,5), o.id);
    interactionHandlers.anchoredObject.move(interaction, ev(7, 6.5));
    const mid = { ...o.anchor };
    // then push 10 ft INTO the wall and 50 ft past the wall end
    interactionHandlers.anchoredObject.move(interaction, ev(55, -5));
    interactionHandlers.anchoredObject.end(interaction);
    return { kind, h0, hClick, hDrag: history.length, mid, end: { ...o.anchor }, p: pos(o) };
  `);
  assert.equal(r.kind, "anchoredObject");
  assert.equal(r.hClick, r.h0, "a click alone is not a change");
  near(r.mid.along, 7, "along +2"); near(r.mid.gap, 2.5, "gap +1.5");
  near(r.end.gap, 0, "gap clamped at the face");
  near(r.end.along, 10, "along clamped to the wall length");
  assert.equal(r.hDrag, r.hClick + 1, "one undo entry for the drag");
  near(r.p.x, 10, "x derived from along"); near(r.p.y, 0.1875 + 0 + 2, "y derived from gap"); near(r.p.rot, 0, "rot untouched");
});

test("inspector: anchored → rotation disabled; edge/along/gap edits clamp and commit; Unanchor keeps the pose, undo restores", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupRoom();
    let o; commit(()=>{ o = obj(f, 5, 5, 2, 4); anchorObject(f, o, "a1|a2", {edge:"back", along:5, gap:1}); });
    sel = {type:"object", id:o.id}; renderInspector();
    const html = document.getElementById("inspectorBody").innerHTML;
    const h0 = history.length;
    document.getElementById("objRot90").onclick();            // ignored while anchored
    const rotAfter90 = o.rot, hRot = history.length;
    document.getElementById("objAnchorEdge").value = "left";
    document.getElementById("objAnchorEdge").onchange();
    const left = { ...o.anchor, p: pos(o) };
    renderInspector();
    document.getElementById("objAnchorAlong").value = "20";
    document.getElementById("objAnchorGap").value = "-3";
    document.getElementById("objAnchorApply").onclick();
    const clamped = { ...o.anchor };
    renderInspector();
    const beforeUn = pos(o), id = o.id;
    document.getElementById("objUnanchor").onclick();
    const un = { anchor: o.anchor, p: pos(o) };
    const hUn = history.length;
    undo();
    const o2 = activeLevel().objects.find(x=>x.id===id);
    return { html, h0, rotAfter90, hRot, left, clamped, beforeUn, un, hUn, undone: o2.anchor };
  `);
  assert.match(r.html, /id="objRot"[^>]*disabled/, "rotation input disabled");
  assert.match(r.html, /id="objRot90"[^>]*disabled/, "rotate button disabled");
  assert.match(r.html, /id="objUnanchor"/);
  assert.equal(r.hRot, r.h0, "Rotate 90° does nothing while anchored");
  assert.equal(r.rotAfter90, 0);
  assert.equal(r.left.edge, "left"); near(r.left.p.rot, 90, "edge change re-derives rot");
  near(r.left.p.y, 0.1875 + 1 + 1, "left edge: center w/2 past gap");
  near(r.clamped.along, 10, "along clamped to the wall"); near(r.clamped.gap, 0, "gap clamped to 0");
  assert.equal(r.un.anchor, null, "Unanchor clears the anchor");
  assert.deepEqual(r.un.p, r.beforeUn, "…leaving the object where it was");
  assert.equal(r.hUn, r.h0 + 3, "edge, along/gap and unanchor are three undo entries");
  assert.ok(r.undone && r.undone.wall === "a1|a2", "undo restores the anchor");
});

/* ---------------- anchoring flow ---------------- */

test("Measure from wall…: pick mode anchors to the clicked wall with the facing edge, current along and gap", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    let o; commit(()=>{ o = obj(f, 4, 6, 2, 4); });          // free, rot 0, in A; front edge (y=8) faces a3|a4 (y=10)
    sel = {type:"object", id:o.id}; renderInspector();
    document.getElementById("objAnchor").onclick();
    const mode = interaction && interaction.kind;
    const h0 = history.length;
    const at = (x,y) => { const [sx,sy]=toScreen(x,y); return { clientX:sx, clientY:sy, button:0 }; };
    // a click on B's wall (not A's) is refused, mode stays on
    interactionHandlers.pickWall.down(interaction, at(15, 10));
    const stillPicking = interaction && interaction.kind, hRefused = history.length;
    // click A's bottom wall a3|a4 (y = 10)
    interactionHandlers.pickWall.down(interaction, at(3, 10));
    return { mode, stillPicking, h0, hRefused, h1: history.length, anchor: o.anchor, p: pos(o), interaction };
  `);
  assert.equal(r.mode, "pickWall");
  assert.equal(r.stillPicking, "pickWall", "another room's wall is not pickable");
  assert.equal(r.hRefused, r.h0);
  assert.equal(r.interaction, null, "mode exits after anchoring");
  assert.equal(r.h1, r.h0 + 1, "one undo entry");
  assert.equal(r.anchor.wall, "a3|a4");
  assert.equal(r.anchor.edge, "front", "the edge already facing that wall");
  // lo of "a3|a4" is a3 at x=10, running −x: center x=4 → along 6
  near(r.anchor.along, 6, "center projected onto the wall");
  near(r.anchor.gap, 10 - 0.1875 - 8, "current distance from face (9.8125) to front edge (y=8)");
  near(r.p.x, 4, "object didn't move"); near(r.p.y, 6, "object didn't move"); near(r.p.rot, 0, "already square: no rotation");
});

test("Measure from wall…: Esc cancels; an open wall can't be picked; an object outside every room can't start it", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupRoom();
    let o, out; commit(()=>{ o = obj(f, 4, 6, 2, 4); out = obj(f, 50, 50, 1, 1); });
    setWallOpen(f, W(f,"a3","a4"), true);
    startPickWall(o.id);
    const [sx,sy]=toScreen(3,10);
    interactionHandlers.pickWall.down(interaction, { clientX:sx, clientY:sy, button:0 });
    const afterOpen = { anchor: o.anchor, kind: interaction && interaction.kind };
    const cancelled = cancelPickWall();
    const startedOutside = startPickWall(out.id);
    return { afterOpen, cancelled, interaction, startedOutside, defOpen: defaultAnchorFor(f, o, "a3|a4") };
  `);
  assert.equal(r.afterOpen.anchor, null);
  assert.equal(r.afterOpen.kind, "pickWall");
  assert.equal(r.cancelled, true);
  assert.equal(r.interaction, null);
  assert.equal(r.startedOutside, false);
  assert.equal(r.defOpen, null);
});

test("auto-anchor on drop: flush against a wall of its room → anchored at gap 0; Alt, far away, or skewed → stays free", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupRoom();
    const ev = (x,y,alt) => ({ clientX: x*view.scale, clientY: y*view.scale, altKey: !!alt, stopPropagation(){}, pointerId: 1 });
    const drop = (o, from, to, alt) => {
      startDragObject(ev(...from), o.id);
      interactionHandlers.object.move(interaction, ev(...to, alt));
      interactionHandlers.object.end(interaction, { altKey: !!alt });
      return { anchor: o.anchor && { ...o.anchor }, p: pos(o) };
    };
    const out = {};
    // back edge ends at y = 2.25 - 2 = 0.25: 0.0625 ft past the face (0.1875) — within SNAP_PX/scale
    let a; commit(()=>{ a = obj(f, 5, 5, 2, 4); }); out.near = drop(a, [5,5], [5,2.25]);
    let b; commit(()=>{ b = obj(f, 5, 5, 2, 4); }); out.alt  = drop(b, [5,5], [5,2.25], true);
    let c; commit(()=>{ c = obj(f, 5, 5, 2, 4); }); out.far  = drop(c, [5,5], [5,4]);
    let d; commit(()=>{ d = obj(f, 5, 5, 2, 4); d.rot = 45; }); out.skew = drop(d, [5,5], [5,2.25]);
    out.tol = SNAP_PX/view.scale;
    return out;
  `);
  assert.ok(r.tol > 0.0625, "sanity: the test drop is within tolerance");
  assert.ok(r.near.anchor, "anchored");
  assert.equal(r.near.anchor.wall, "a1|a2"); assert.equal(r.near.anchor.edge, "back");
  near(r.near.anchor.gap, 0, "snapped flush"); near(r.near.anchor.along, 5, "along");
  near(r.near.p.y, 0.1875 + 2, "resolved flush against the face");
  assert.equal(r.alt.anchor, null, "Alt bypasses auto-anchor");
  assert.equal(r.far.anchor, null, "too far from any wall");
  assert.equal(r.skew.anchor, null, "a 45° object is never silently rotated by a drop");
});

/* ---------------- persistence ---------------- */

test("save/load round-trips an anchor; a malformed anchor loads as a free object", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupRoom();
    let o; commit(()=>{ o = obj(f, 5, 5, 2, 4); anchorObject(f, o, "a2|a3", {edge:"front", along:4, gap:1}); });
    const saved = JSON.parse(JSON.stringify(stripIdx(data)));
    const reloaded = loadData(saved).levels[0].objects[0];
    saved.levels[0].objects[0].anchor = {wall:"a2|a3", edge:"sideways", along:1, gap:1};
    const bad = loadData(saved).levels[0].objects[0];
    return { original: { ...o, anchor: { ...o.anchor } }, reloaded, bad: bad.anchor, aliased: reloaded.anchor === saved.levels[0].objects[0].anchor };
  `);
  assert.deepEqual(r.reloaded, r.original);
  assert.equal(r.bad, null);
  assert.equal(r.aliased, false);
});
