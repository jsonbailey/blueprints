"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./harness");

/* joinRooms (ARCHITECTURE.md "Item: join rooms") — the geometric inverse of
   cutRoom: unions two adjacent rooms into one via the vendored
   polygon-clipping library's `union`, refusing outright (no "largest piece"
   fallback) unless the result is exactly one polygon with no holes. */

const T1 = 0.3, T2 = 0.4;   // arbitrary distinct thickness overrides, ft

/* Inside the vm:
   - setupTwoRects(): rA = (0,0)-(10,0)-(10,10)-(0,10) [p1,p2,p3,p4], rB =
     (10,0)-(20,0)-(20,10)-(10,10) sharing points p2,p3 (the vertical edge at
     x=10) directly with rA — same point ids, so deriveWalls sees ONE shared
     wall "p2|p3", not two coincident ones. rA's left edge p4-p1 (wallKey
     "p1|p4") is a genuine, non-collinear corner of the union rectangle
     (0,0)-(20,10)'s outer boundary, so it's the edge used to check that an
     outer-boundary wall's props survive (a top/bottom edge wouldn't: PC.union
     drops now-collinear midpoints like p2/p3 from a straight edge, so this
     left edge — perpendicular to the dissolved wall — is the one guaranteed
     to come back with its original endpoint ids).
   - setupFarRooms(): two rooms nowhere near each other.
   - setupHoleRooms(): two C-shaped rooms (ARCHITECTURE.md comment above
     joinRooms) whose union traps a hole — a pathological case a join must
     refuse, not silently "succeed" into a corrupted multi-ring loop. */
const SETUP = `
  // the vendored UMD bundle attaches itself to globalThis; in a browser that
  // IS window, but the harness's stub window is a separate object (see
  // test/wallprops.test.js's cutRoom test for the same shim).
  window.polygonClipping = window.polygonClipping || globalThis.polygonClipping;
  function install(f){ indexLevel(f); data.levels=[f]; data.activeLevelId=f.id; history.length=0; sel={type:null,id:null}; return f; }
  function setupTwoRects(){
    const f = makeLevel("T", []);
    const P=(id,x,y)=>({id,x,y});
    f.points = [P("p1",0,0),P("p2",10,0),P("p3",10,10),P("p4",0,10),
                P("q1",20,0),P("q2",20,10)];
    f.rooms = [{id:"rA",name:"A",kind:"room",loop:["p1","p2","p3","p4"]},
               {id:"rB",name:"B",kind:"room",loop:["p2","q1","q2","p3"]}];
    return install(f);
  }
  function setupFarRooms(){
    const f = makeLevel("T", []);
    const P=(id,x,y)=>({id,x,y});
    f.points = [P("p1",0,0),P("p2",10,0),P("p3",10,10),P("p4",0,10),
                P("q1",100,100),P("q2",110,100),P("q3",110,110),P("q4",100,110)];
    f.rooms = [{id:"rA",name:"A",kind:"room",loop:["p1","p2","p3","p4"]},
               {id:"rB",name:"B",kind:"room",loop:["q1","q2","q3","q4"]}];
    return install(f);
  }
  function setupHoleRooms(){
    const f = makeLevel("T", []);
    const P=(id,x,y)=>({id,x,y});
    // A: bottom C-shaped half of a 30x30 frame around a 10x10x10x10 hole at
    // (10,10)-(20,20), notched out at y 10..15; B: the matching top half.
    f.points = [
      P("a1",0,0), P("a2",30,0), P("a3",30,15), P("a4",20,15), P("a5",20,10),
      P("a6",10,10), P("a7",10,15), P("a8",0,15),
      P("b1",0,30), P("b2",30,30), P("b4",20,20), P("b5",10,20),
    ];
    f.rooms = [
      {id:"rA",name:"A",kind:"room",loop:["a1","a2","a3","a4","a5","a6","a7","a8"]},
      {id:"rB",name:"B",kind:"room",loop:["a8","b1","b2","a3","a4","b4","b5","a7"]},
    ];
    return install(f);
  }
`;
function vmRun(run, body, args) {
  const fn = `(args)=>{ ${SETUP} ${body} }`;
  return run({ toString: () => fn }, args === undefined ? null : args);
}

test("joinRooms: two rectangles sharing a full edge merge into one room with the summed area", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRects();
    const rA = f.rooms.find(x=>x.id==="rA"), rB = f.rooms.find(x=>x.id==="rB");
    const areaA = polyArea(f, rA.loop), areaB = polyArea(f, rB.loop);
    const res = joinRooms(f, rA, rB);
    return { ok: res.ok, roomCount: f.rooms.length, survivorId: res.ok ? res.room.id : null,
      mergedArea: res.ok ? polyArea(f, res.room.loop) : null, areaA, areaB,
      rBGone: !f.rooms.some(x=>x.id==="rB") };
  `);
  assert.equal(r.ok, true);
  assert.equal(r.roomCount, 1);
  assert.equal(r.survivorId, "rA");
  assert.ok(r.rBGone);
  assert.ok(Math.abs(r.mergedArea - (r.areaA + r.areaB)) < 1e-6,
    `merged area ${r.mergedArea} should equal areaA+areaB ${r.areaA + r.areaB}`);
});

test("joinRooms: rooms that don't touch at all are refused, with a reason", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupFarRooms();
    const rA = f.rooms.find(x=>x.id==="rA"), rB = f.rooms.find(x=>x.id==="rB");
    const res = joinRooms(f, rA, rB);
    return { ok: res.ok, reason: res.reason, roomCount: f.rooms.length };
  `);
  assert.equal(r.ok, false);
  assert.ok(r.reason && r.reason.length > 0);
  assert.equal(r.roomCount, 2, "a refused join must not mutate the rooms");
});

test("joinRooms: rooms touching at a single corner only are refused, with a reason", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = makeLevel("T", []);
    const P=(id,x,y)=>({id,x,y});
    f.points = [P("p1",0,0),P("p2",10,0),P("p3",10,10),P("p4",0,10),
                P("q1",10,10),P("q2",20,10),P("q3",20,20),P("q4",10,20)];
    f.rooms = [{id:"rA",name:"A",kind:"room",loop:["p1","p2","p3","p4"]},
               {id:"rB",name:"B",kind:"room",loop:["q1","q2","q3","q4"]}];
    install(f);
    const rA = f.rooms.find(x=>x.id==="rA"), rB = f.rooms.find(x=>x.id==="rB");
    const res = joinRooms(f, rA, rB);
    return { ok: res.ok, reason: res.reason, roomCount: f.rooms.length };
  `);
  assert.equal(r.ok, false);
  assert.ok(r.reason && r.reason.length > 0);
  assert.equal(r.roomCount, 2);
});

test("joinRooms: a union that would trap a hole is refused, with a reason, not silently accepted", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupHoleRooms();
    const rA = f.rooms.find(x=>x.id==="rA"), rB = f.rooms.find(x=>x.id==="rB");
    const res = joinRooms(f, rA, rB);
    return { ok: res.ok, reason: res.reason, roomCount: f.rooms.length };
  `);
  assert.equal(r.ok, false);
  assert.ok(r.reason && r.reason.length > 0);
  assert.equal(r.roomCount, 2, "a refused join must not mutate the rooms");
});

test("joinRooms: either room locked is refused", () => {
  const { run } = loadApp();
  const rLockA = vmRun(run, `
    const f = setupTwoRects();
    const rA = f.rooms.find(x=>x.id==="rA"), rB = f.rooms.find(x=>x.id==="rB");
    rA.locked = true;
    const res = joinRooms(f, rA, rB);
    return { ok: res.ok, reason: res.reason };
  `);
  assert.equal(rLockA.ok, false);
  assert.ok(rLockA.reason);

  const rLockB = vmRun(run, `
    const f = setupTwoRects();
    const rA = f.rooms.find(x=>x.id==="rA"), rB = f.rooms.find(x=>x.id==="rB");
    rB.locked = true;
    const res = joinRooms(f, rA, rB);
    return { ok: res.ok, reason: res.reason };
  `);
  assert.equal(rLockB.ok, false);
  assert.ok(rLockB.reason);
});

test("joinRooms: an object in the removed room is reparented to the surviving room, not orphaned", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRects();
    const rA = f.rooms.find(x=>x.id==="rA"), rB = f.rooms.find(x=>x.id==="rB");
    f.objects = [];
    const o = addObject(f, "table", 15, 5);   // inside rB (x in 10..20)
    const beforeRoomId = o.roomId;
    const res = joinRooms(f, rA, rB);
    return { ok: res.ok, beforeRoomId, afterRoomId: o.roomId, survivorId: res.room.id };
  `);
  assert.equal(r.ok, true);
  assert.equal(r.beforeRoomId, "rB");
  assert.equal(r.afterRoomId, "rA");
  assert.equal(r.afterRoomId, r.survivorId);
});

test("joinRooms: a wall property on the outer, surviving boundary is preserved", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRects();
    const rA = f.rooms.find(x=>x.id==="rA"), rB = f.rooms.find(x=>x.id==="rB");
    const outerKey = wallKey("p1","p4");   // rA's left edge — not collinear with the shared wall
    f.wallProps = { [outerKey]: { thickness: ${T1} } };
    const res = joinRooms(f, rA, rB);
    return { ok: res.ok, outerKey, outerStillLive: f.walls.some(w=>wallKeyOf(w)===outerKey),
      outerThickness: f.wallProps[outerKey] && f.wallProps[outerKey].thickness };
  `);
  assert.equal(r.ok, true);
  assert.ok(r.outerStillLive, "the outer wall p1|p4 should still be a live wall after the join");
  assert.equal(r.outerThickness, T1);
});

test("joinRooms: a wall property on the dissolved shared wall is gone afterward", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRects();
    const rA = f.rooms.find(x=>x.id==="rA"), rB = f.rooms.find(x=>x.id==="rB");
    const sharedKey = wallKey("p2","p3");
    f.wallProps = { [sharedKey]: { thickness: ${T2} } };
    const res = joinRooms(f, rA, rB);
    return { ok: res.ok, sharedKey, sharedStillLive: f.walls.some(w=>wallKeyOf(w)===sharedKey),
      sharedPropsGone: !f.wallProps[sharedKey] };
  `);
  assert.equal(r.ok, true);
  assert.ok(!r.sharedStillLive, "the dissolved wall p2|p3 must not still be a live wall");
  assert.ok(r.sharedPropsGone, "its wallProps entry (including the thickness override) must be pruned, not duplicated or left dangling");
});

test("joinRooms goes through commit() (undoable) — undo() restores both original rooms", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRects();
    const rA = f.rooms.find(x=>x.id==="rA"), rB = f.rooms.find(x=>x.id==="rB");
    let res;
    commit(()=>{ res = joinRooms(f, rA, rB); });
    const afterJoin = { roomCount: activeLevel().rooms.length, ok: res.ok };
    undo();
    const g = activeLevel();
    return { afterJoin, afterUndoRoomCount: g.rooms.length,
      afterUndoIds: g.rooms.map(x=>x.id).sort() };
  `);
  assert.equal(r.afterJoin.ok, true);
  assert.equal(r.afterJoin.roomCount, 1);
  assert.equal(r.afterUndoRoomCount, 2);
  assert.deepEqual(r.afterUndoIds, ["rA", "rB"]);
});
