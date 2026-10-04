"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./harness");

/* Room-relative object placement (ARCHITECTURE.md item 5) — FREE-PLACEMENT
   HALF ONLY: wall-anchored placement, resolveObjects() and "Unanchor" are a
   separate, later task, so every object here has anchor:null throughout.

   Two levels of room setup are used below:
   - a single square room, for plain placement/reparenting/drag/resize tests;
   - two rooms WELDED on a shared edge (same point-id-sharing pattern as
     tools.test.js's whole-room-drag test), for the carry-along tests, which
     need an actual connectedRoomPoints() cluster of more than one room. */

const SETUP = `
  function install(f){ indexLevel(f); data.levels=[f]; data.activeLevelId=f.id; history.length=0; sel={type:null,id:null}; return f; }
  // One 10x10 room, corners at (0,0)-(10,10).
  function setupOneRoom(){
    const f=makeLevel("T", []);
    const mk=(x,y)=>{ const id="p"+(_pid++); f.points.push({id,x,y}); return id; };
    const a=mk(0,0), b=mk(10,0), c=mk(10,10), d=mk(0,10);
    f.rooms=[{id:"roomA",name:"A",kind:"room",loop:[a,b,c,d]}];
    f._pt=new Map(f.points.map(p=>[p.id,p]));
    deriveWalls(f);
    return install(f);
  }
  // roomA (0,0)-(10,10) and roomB (0,10)-(10,20), sharing corners c,d — a
  // whole-room drag of roomA also carries roomB (connectedRoomPoints).
  function setupWeldedRooms(){
    const f=makeLevel("T", []);
    const mk=(x,y)=>{ const id="p"+(_pid++); f.points.push({id,x,y}); return id; };
    const a=mk(0,0), b=mk(10,0), c=mk(10,10), d=mk(0,10);
    const e=mk(10,20), g=mk(0,20);
    f.rooms=[{id:"roomA",name:"A",kind:"room",loop:[a,b,c,d]},
             {id:"roomB",name:"B",kind:"room",loop:[d,c,e,g]}];
    f._pt=new Map(f.points.map(p=>[p.id,p]));
    deriveWalls(f);
    return install(f);
  }
`;
function vmRun(run, body, args) {
  const fn = `(args)=>{ ${SETUP} ${body} }`;
  return run({ toString: () => fn }, args === undefined ? null : args);
}

/* ---------------- catalog + creation ---------------- */

test("addObject: every FIXTURE_TYPES entry produces a correctly-shaped object with anchor:null", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupOneRoom();
    return FIXTURE_TYPES.map(t => {
      const o = addObject(f, t.type, 5, 5);
      return { type: t.type, catW: t.w, catD: t.d, o };
    });
  `);
  assert.ok(r.length >= 10, "expected at least the 10 catalog types from ARCHITECTURE.md");
  r.forEach(({ type, catW, catD, o }) => {
    assert.ok(o, `addObject should succeed for catalog type "${type}"`);
    assert.equal(o.type, type);
    assert.equal(o.w, catW, "new instance starts at the catalog's starting width");
    assert.equal(o.d, catD, "new instance starts at the catalog's starting depth");
    assert.equal(o.mirror, false);
    assert.equal(o.rot, 0);
    assert.equal(o.anchor, null, "anchor must always be null — free placement only");
    assert.equal(o.roomId, "roomA", "(5,5) is inside the 10x10 room");
    assert.match(o.id, /^obj\d+$/);
  });
  // ARCHITECTURE.md's two load-bearing exact dimensions.
  const car = r.find(x => x.type === "car"), truck = r.find(x => x.type === "truck");
  assert.deepEqual([car.catW, car.catD], [6, 15]);
  assert.deepEqual([truck.catW, truck.catD], [6.5, 20]);
});

test("addObject: unknown type is refused (null), not a half-built object", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupOneRoom();
    return { bad: addObject(f, "not-a-fixture", 5, 5), count: f.objects.length };
  `);
  assert.equal(r.bad, null);
  assert.equal(r.count, 0);
});

/* ---------------- point-in-polygon reparenting ---------------- */

test("point-in-polygon reparenting: inside a room gets its roomId; outside any room is null", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupOneRoom();
    const inside = addObject(f, "table", 5, 5);
    const outside = addObject(f, "table", 50, 50);
    return { insideRoom: inside.roomId, outsideRoom: outside.roomId };
  `);
  assert.equal(r.insideRoom, "roomA");
  assert.equal(r.outsideRoom, null, "an object placed outside every room gets roomId:null");
});

test("dragging an object to a different room reassigns roomId on release (point-in-polygon on drop)", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupWeldedRooms();
    let o; commit(()=>{ o = addObject(f, "table", 5, 5); }); // inside roomA
    const historyBefore = history.length;
    startDragObject({ clientX: 0, clientY: 0, stopPropagation(){}, pointerId: 1 }, o.id);
    // roomA center (5,5) -> roomB center (5,15): world delta (0,10) == screen delta (0, 10*view.scale)
    interactionHandlers.object.move(interaction, { clientX: 0, clientY: 10*view.scale });
    interactionHandlers.object.end(interaction);
    return { roomId: o.roomId, historyAfter: history.length, before: historyBefore };
  `);
  assert.equal(r.roomId, "roomB", "dropping the object inside roomB reassigns it there");
  assert.equal(r.historyAfter, r.before + 1, "a real drag pushes exactly one undo entry");
});

/* ---------------- mutations go through commit() (undoable) ---------------- */

test("drag, resize, rotate and mirror all commit through commit() / commitCaptured() and undo() reverts them", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupOneRoom();
    let o; commit(()=>{ o = addObject(f, "sink", 5, 5); });
    const afterCreate = history.length;

    // --- drag ---
    startDragObject({ clientX: 0, clientY: 0, stopPropagation(){}, pointerId: 1 }, o.id);
    interactionHandlers.object.move(interaction, { clientX: 20, clientY: 0 });
    interactionHandlers.object.end(interaction);
    const afterDrag = history.length;
    const xAfterDrag = o.x;

    // --- resize via the inspector's wired "Apply size" button ---
    sel = { type:"object", id:o.id };
    renderInspector();
    document.getElementById("objW").value = "3";
    document.getElementById("objD").value = "3";
    document.getElementById("objApplySize").onclick();
    const afterResize = history.length;
    const wAfterResize = o.w;

    // --- rotate via "Rotate 90°" ---
    renderInspector();
    document.getElementById("objRot90").onclick();
    const afterRotate = history.length;
    const rotAfterRotate = o.rot;

    // --- mirror checkbox ---
    renderInspector();
    document.getElementById("objMirror").onchange({ target: { checked: true } });
    const afterMirror = history.length;

    return { afterCreate, afterDrag, xAfterDrag, afterResize, wAfterResize, afterRotate, rotAfterRotate, afterMirror,
      mirrorAfter: o.mirror };
  `);
  assert.equal(r.afterDrag, r.afterCreate + 1, "drag should push one undo entry");
  assert.notEqual(r.xAfterDrag, 5, "the object should actually have moved");
  assert.equal(r.afterResize, r.afterDrag + 1, "resize should push one undo entry");
  assert.equal(r.wAfterResize, 3);
  assert.equal(r.afterRotate, r.afterResize + 1, "rotate should push one undo entry");
  assert.equal(r.rotAfterRotate, 90);
  assert.equal(r.afterMirror, r.afterRotate + 1, "mirror toggle should push one undo entry");
  assert.equal(r.mirrorAfter, true);

  // undo() four times should unwind every step, back to the freshly-created
  // object. undo() rebuilds \`data\` from scratch (loadData), so a stale
  // reference to the pre-undo object would still read the pre-undo values —
  // re-look it up by id afterward, the same way the app's own code always
  // does after an undo.
  const r2 = vmRun(run, `
    const f = setupOneRoom();
    let o; commit(()=>{ o = addObject(f, "sink", 5, 5); });
    const id = o.id;
    commit(()=>{ o.x = 999; });
    commit(()=>{ o.w = 3; });
    commit(()=>{ o.rot = 90; });
    commit(()=>{ o.mirror = true; });
    undo(); undo(); undo(); undo();
    const o2 = activeLevel().objects.find(x=>x.id===id);
    return { x:o2.x, w:o2.w, rot:o2.rot, mirror:o2.mirror };
  `);
  assert.equal(r2.x, 5); assert.equal(r2.w, 2); assert.equal(r2.rot, 0); assert.equal(r2.mirror, false);
});

test("deleting an object goes through commit() (undoable) and clears the selection", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupOneRoom();
    let o; commit(()=>{ o = addObject(f, "toilet", 5, 5); });
    sel = { type:"object", id:o.id };
    renderInspector();
    const before = history.length;
    document.getElementById("objDel").onclick();
    return { before, after: history.length, count: f.objects.length, selType: sel.type };
  `);
  assert.equal(r.after, r.before + 1);
  assert.equal(r.count, 0);
  assert.equal(r.selType, null);
});

/* ---------------- carry-along (ARCHITECTURE.md item 5: free objects move
   only on a whole-room translate; never on a reshape) ---------------- */

test("carry-along: dragging the room a free object belongs to moves it by the same delta", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupWeldedRooms();
    let o; commit(()=>{ o = addObject(f, "table", 5, 5); }); // inside roomA, the room being dragged
    const before = { x:o.x, y:o.y };
    startDragRoom({ clientX: 0, clientY: 0, stopPropagation(){}, pointerId: 1 }, "roomA");
    interactionHandlers.room.move(interaction, { clientX: 50, clientY: 50, altKey: true }); // Alt bypasses snap
    interactionHandlers.room.end(interaction);
    return { before, after: { x:o.x, y:o.y } };
  `);
  const dx = r.after.x - r.before.x, dy = r.after.y - r.before.y;
  assert.ok(Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6, "the object should have moved with its own room");
});

test("carry-along: dragging a CONNECTED room also carries a free object belonging to the OTHER room in the cluster", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupWeldedRooms();
    let o; commit(()=>{ o = addObject(f, "table", 5, 15); }); // inside roomB, NOT the room being dragged
    const before = { x:o.x, y:o.y };
    startDragRoom({ clientX: 0, clientY: 0, stopPropagation(){}, pointerId: 1 }, "roomA");
    const clusterSize = interaction.roomIds.length;
    interactionHandlers.room.move(interaction, { clientX: 50, clientY: 50, altKey: true });
    interactionHandlers.room.end(interaction);
    return { before, after: { x:o.x, y:o.y }, roomId: o.roomId, clusterSize };
  `);
  assert.equal(r.roomId, "roomB", "the object's own room didn't change");
  assert.equal(r.clusterSize, 2, "dragging roomA should pick up roomB too (shared corners)");
  const dx = r.after.x - r.before.x, dy = r.after.y - r.before.y;
  assert.ok(Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6,
    "an object in roomB must move too when roomA (connected to it) is dragged, not just when its own room is dragged directly");
});

test("carry-along: nudgeRoom moves a free object in the SAME room, and in a connected room", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupWeldedRooms();
    let oA, oB;
    commit(()=>{ oA = addObject(f, "table", 5, 5); oB = addObject(f, "table", 5, 15); });
    const beforeA = { x:oA.x, y:oA.y }, beforeB = { x:oB.x, y:oB.y };
    const roomA = f.rooms.find(r=>r.id==="roomA");
    nudgeRoom(roomA, "right");
    return { beforeA, afterA: { x:oA.x, y:oA.y }, beforeB, afterB: { x:oB.x, y:oB.y } };
  `);
  assert.ok(r.afterA.x > r.beforeA.x, "the object in the nudged room should move");
  assert.ok(r.afterB.x > r.beforeB.x, "the object in the connected room should also move");
  assert.equal(r.afterA.x - r.beforeA.x, r.afterB.x - r.beforeB.x, "both move by the identical nudge delta");
});

test("negative: reshaping a room (dragging one corner) does NOT move a free object in it", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupOneRoom();
    let o; commit(()=>{ o = addObject(f, "table", 5, 5); });
    const before = { x:o.x, y:o.y };
    const cornerId = f.rooms[0].loop[2]; // the (10,10) corner
    startDragPoint({ clientX: 0, clientY: 0, stopPropagation(){}, pointerId: 1 }, cornerId);
    interactionHandlers.point.move(interaction, { clientX: 100, clientY: 100, altKey: true });
    interactionHandlers.point.end(interaction);
    return { before, after: { x:o.x, y:o.y }, cornerMoved: ptOf(f, cornerId).x !== 10 };
  `);
  assert.ok(r.cornerMoved, "sanity: the corner actually moved (the room was reshaped)");
  assert.equal(r.after.x, r.before.x, "a corner-drag reshape must leave a free object's x in place");
  assert.equal(r.after.y, r.before.y, "a corner-drag reshape must leave a free object's y in place");
});

test("negative: dragging a whole-room translate never carries an ANCHORED object (reserved field check)", () => {
  // Free-placement half only — anchor is always null, so there's no real
  // anchored-object behavior to test yet. This just locks in that an object
  // with a non-null anchor (as the later task will produce) is excluded from
  // the carry-along set, so wiring that task in later doesn't silently double
  // -move an anchored object.
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupOneRoom();
    let o; commit(()=>{ o = addObject(f, "table", 5, 5); o.anchor = {wall:"x|y", edge:"back", along:1, gap:1}; });
    const before = { x:o.x, y:o.y };
    startDragRoom({ clientX: 0, clientY: 0, stopPropagation(){}, pointerId: 1 }, "roomA");
    interactionHandlers.room.move(interaction, { clientX: 50, clientY: 50, altKey: true });
    interactionHandlers.room.end(interaction);
    return { before, after: { x:o.x, y:o.y } };
  `);
  assert.equal(r.after.x, r.before.x);
  assert.equal(r.after.y, r.before.y);
});

/* ---------------- deleting a room orphans (doesn't delete) its objects ---------------- */

test("deleting a room orphans its free objects (roomId:null) rather than deleting them", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupOneRoom();
    let o; commit(()=>{ o = addObject(f, "table", 5, 5); });
    sel = { type:"room", id:"roomA" };
    renderInspector();
    document.getElementById("delRoom").onclick();
    return { count: f.objects.length, roomId: o.roomId };
  `);
  assert.equal(r.count, 1, "the object itself is not deleted");
  assert.equal(r.roomId, null, "its room no longer exists, so it's orphaned");
});

/* ---------------- syncIds ---------------- */

test("syncIds picks up an object's id and bumps the id counter past it", () => {
  const { run } = loadApp();
  const nextId = run(() => {
    const f = activeLevel();
    f.objects = [{ id: "obj500", type: "table", roomId: null, w: 3, d: 5, mirror: false, x: 0, y: 0, rot: 0, anchor: null }];
    syncIds({ levels: data.levels });
    const o = addObject(f, "table", 0, 0);
    return o.id;
  });
  const n = parseInt(nextId.replace("obj", ""), 10);
  assert.ok(n > 500, `expected a freshly-minted id above 500, got ${nextId}`);
});

/* ---------------- persistence ---------------- */

test("save/load round-trips objects correctly", () => {
  const { run } = loadApp();
  const r = run(() => {
    const f = activeLevel();
    let o;
    commit(() => { o = addObject(f, "stove", 3, 4); o.rot = 45; o.mirror = true; o.w = 2.75; });
    const saved = stripIdx(data);
    const reloaded = loadData(JSON.parse(JSON.stringify(saved)));
    const ro = reloaded.levels[0].objects[0];
    return { original: { ...o }, reloaded: ro, schemaVersion: saved.schemaVersion };
  });
  assert.deepEqual(r.reloaded, r.original, "an object round-trips through save/load unchanged");
});

test("schema: a v2-shaped file with no `objects` field at all loads with objects:[] — no migration/bump needed", () => {
  const { run } = loadApp();
  const r = run(() => {
    const v2 = {
      schemaVersion: 2,
      activeLevelId: "lvl0",
      levels: [{ id: "lvl0", name: "Level 1", visible: true, points: [], walls: [], rooms: [], wallProps: {}, defaultThickness: 4.5 / 12 }],
    };
    const d = loadData(v2);
    return { objects: d.levels[0].objects, currentSchema: CURRENT_SCHEMA_VERSION };
  });
  assert.deepEqual(r.objects, [], "a v2 file with no objects field gets objects:[] for free, same as openings did");
  assert.equal(r.currentSchema, 2, "no schema bump was needed for a plain additive array field");
});
