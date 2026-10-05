"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./harness");

/* Wall openings (ARCHITECTURE.md item 4): placement rules, re-keying through
   every topology op (split / merge / detach) — including the cases where a
   wall's canonical lo→hi direction REVERSES across the op, which is where a
   naive "copy the offset" or "add the first wall's length" gets it wrong —
   id syncing, persistence, display clamping, the inspector and the drag.

   Frame reminder: a wall key "lo|hi" sorts the two point ids as strings, and
   `along` is the distance from point lo to the opening's CENTER. */

const SETUP = `
  const P = (id,x,y)=>({id,x,y});
  function install(f){ indexLevel(f); data.levels=[f]; data.activeLevelId=f.id; history.length=0; return f; }
  /* Two UNCONNECTED 10x10 rooms: A = a1(0,0) a2(10,0) a3(10,10) a4(0,10),
     B = b1..b4 at x 10..20 (B's left edge coincides with A's right edge). */
  function setupTwoRooms(){
    const f = makeLevel("T", []);
    f.points = [P("a1",0,0),P("a2",10,0),P("a3",10,10),P("a4",0,10),
                P("b1",10,0),P("b2",20,0),P("b3",20,10),P("b4",10,10)];
    f.rooms = [{id:"rA",name:"A",kind:"room",loop:["a1","a2","a3","a4"]},
               {id:"rB",name:"B",kind:"room",loop:["b1","b2","b3","b4"]}];
    return install(f);
  }
  /* One 10x10 room whose ids sort AFTER the "pt<N>" ids divideWall /
     insertPointOnWall mint — so a split point becomes the LOWER id of both
     halves (the mirror image of setupTwoRooms' "a" ids). */
  function setupZRoom(){
    const f = makeLevel("Z", []);
    f.points = [P("z1",0,0),P("z2",10,0),P("z3",10,10),P("z4",0,10)];
    f.rooms = [{id:"rZ",name:"Z",kind:"room",loop:["z1","z2","z3","z4"]}];
    return install(f);
  }
  const W = (f,a,b) => wallById(f, wallIdForKey(wallKey(a,b)));
  /* world point of an opening's center — frame-independent ground truth */
  const at = (f,key,o) => { const p=alongToWorld(wallFrame(f,key), o.along); return {x:+p.x.toFixed(6), y:+p.y.toFixed(6)}; };
  const allOpenings = f => Object.entries(f.wallProps).flatMap(([k,p]) => (p.openings||[]).map(o => ({key:k, ...o})));
`;
function vmRun(run, body, args) {
  const fn = `(args)=>{ ${SETUP} ${body} }`;
  return run({ toString: () => fn }, args === undefined ? null : args);
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: expected ${b}, got ${a}`);

/* ---------------- placement ---------------- */

test("addOpening: refused on an open wall, for an unknown type, and when the wall is too short", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    setWallOpen(f, W(f,"a1","a2"), true);
    const onOpen = addOpening(f, W(f,"a1","a2"), {type:"door"});
    const unknown = addOpening(f, W(f,"a2","a3"), {type:"portal"});
    // shorten B's top wall to 6 ft: a 9 ft garage door can't fit at all
    ptOf(f,"b2").x = 16;
    const tooLong = addOpening(f, W(f,"b1","b2"), {type:"garage"});
    const ok = addOpening(f, W(f,"a2","a3"), {type:"door"});
    return { onOpen, unknown, tooLong, ok, props: f.wallProps };
  `);
  assert.equal(r.onOpen, null);
  assert.equal(r.unknown, null);
  assert.equal(r.tooLong, null, "creation refuses rather than shrinking the width");
  assert.equal(r.ok.type, "door");
  near(r.ok.along, 5, "defaults to the wall's center");
  assert.equal(r.ok.width, 3, "catalog default width");
  assert.equal(r.ok.swing, "in");
  assert.equal(r.ok.hand, "left");
  assert.equal(r.ok.room, "rA");
  assert.ok(!("openings" in (r.props["a1|a2"] || {})), "nothing stored on the open wall");
});

test("placement: overlapping requests are moved to the nearest free spot (2\" gap); a full wall refuses", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    const w = W(f,"a1","a2");                                 // 10 ft
    const door = addOpening(f, w, {type:"door"});           // center 5, span 3.5..6.5
    const win = addOpening(f, w, {type:"window"});          // wants 5 too
    const slider = addOpening(f, w, {type:"sliding"});      // 6 ft: no gap left anywhere
    // edit: pushing the window onto the door lands it against the door instead
    const moved = updateOpening(f, "a1|a2", win.id, {along: 5});
    const after = findOpening(f, "a1|a2", win.id).along;
    // a width that can't fit anywhere next to the door is refused, unchanged
    const refused = updateOpening(f, "a1|a2", win.id, {width: 7});
    return { door, win, slider, moved, after, refused, width: findOpening(f,"a1|a2",win.id).width,
      list: openingsAt(f,"a1|a2").map(o=>o.id) };
  `);
  const gap = 2 / 12;
  near(r.door.along, 5, "door");
  // blocked centers for a 3 ft window: (3.5 - gap - 1.5, 6.5 + gap + 1.5); both ends
  // are equally near 5, the lower one wins
  near(r.win.along, 2 - gap, "window placed against the door's lower side");
  assert.equal(r.slider, null);
  assert.equal(r.moved, true);
  near(r.after, 2 - gap, "edit adjusted to the nearest free spot, not overlapping");
  assert.equal(r.refused, false);
  assert.equal(r.width, 3);
  assert.deepEqual(r.list, [r.win.id, r.door.id], "kept sorted by position");
});

/* ---------------- split ---------------- */

test("split (divideWall): each opening lands on the half holding its center; the reversed half is re-based", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    const key = "a2|a3";                                   // a2 (10,0) → a3 (10,10)
    const door = addOpening(f, W(f,"a2","a3"), {type:"door", along:2});            // span 0.5..3.5
    const win = addOpening(f, W(f,"a2","a3"), {type:"window", width:2, along:7.5}); // span 6.5..8.5
    const before = {door: at(f,key,door), win: at(f,key,win)};
    const mid = divideWall(f, W(f,"a2","a3"));             // mid (10,5)
    return { mid, before, props: f.wallProps,
      worlds: allOpenings(f).map(o => ({id:o.id, key:o.key, p: at(f,o.key,o)})) };
  `);
  const k1 = `a2|${r.mid}`, k2 = `a3|${r.mid}`;            // "a3" < "pt…": k2's lo is a3 → REVERSED vs a2→a3
  assert.ok(!r.props["a2|a3"], "old key pruned");
  assert.equal(r.props[k1].openings.length, 1);
  assert.equal(r.props[k2].openings.length, 1);
  // first half a2→mid runs the same way as a2→a3: offset unchanged
  near(r.props[k1].openings[0].along, 2, "door, same-orientation half");
  // second half's frame is a3→mid (pointing back up): 10 - 7.5 = 2.5, NOT 7.5 - 5 = 2.5…
  // (coincidence-proof check below via world position)
  near(r.props[k2].openings[0].along, 2.5, "window, reversed half");
  assert.equal(r.props[k2].openings[0].width, 2);
  // the openings did not move in the world
  const w = Object.fromEntries(r.worlds.map(x => [x.id, x.p]));
  const ids = r.props[k1].openings[0].id, idw = r.props[k2].openings[0].id;
  assert.deepEqual(w[ids], r.before.door);
  assert.deepEqual(w[idw], r.before.win);
});

test("split (insertPointOnWall): mirror case — the FIRST half is reversed, the second keeps its direction", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupZRoom();
    const key = "z1|z2";                                   // z1 (0,0) → z2 (10,0)
    const d = addOpening(f, W(f,"z1","z2"), {type:"door", width:2, along:1.5});   // span 0.5..2.5
    const w = addOpening(f, W(f,"z1","z2"), {type:"window", width:2, along:7});   // span 6..8
    const before = {[d.id]: at(f,key,d), [w.id]: at(f,key,w)};
    const mid = insertPointOnWall(f, "z1", "z2", 4, 0);     // split at x = 4
    return { mid, before, ids:{d:d.id, w:w.id}, props: f.wallProps,
      worlds: Object.fromEntries(allOpenings(f).map(o => [o.id, at(f,o.key,o)])) };
  `);
  const k1 = `${r.mid}|z1`, k2 = `${r.mid}|z2`;             // both halves have lo = mid
  // k1 runs mid(4) → z1(0): reversed. center x=1.5 → 4 - 1.5 = 2.5 (naive copy would say 1.5)
  near(r.props[k1].openings[0].along, 2.5, "door on reversed first half");
  // k2 runs mid(4) → z2(10): same direction, shifted by the split position: 7 - 4 = 3
  near(r.props[k2].openings[0].along, 3, "window on same-direction second half");
  assert.deepEqual(r.worlds, r.before, "no opening moved in the world");
});

test("split: a straddling opening stays on its center's half and is trimmed at the split point", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const out = [];
    for (const along of [4.5, 3.5]) {                       // 3 ft wide, split at x = 4
      const f = setupZRoom();
      addOpening(f, W(f,"z1","z2"), {type:"door", along});
      const mid = insertPointOnWall(f, "z1", "z2", 4, 0);
      out.push({ mid, ops: allOpenings(f).map(o => ({key:o.key, along:o.along, width:o.width, p: at(f,o.key,o)})) });
    }
    return out;
  `);
  // center 4.5 (span 3..6) → second half mid→z2, kept part 4..6: width 2, center x=5 → along 1
  assert.equal(r[0].ops.length, 1, "never duplicated onto both halves");
  assert.equal(r[0].ops[0].key, `${r[0].mid}|z2`);
  near(r[0].ops[0].width, 2, "trimmed width");
  near(r[0].ops[0].along, 1, "trimmed center, re-based");
  assert.deepEqual(r[0].ops[0].p, { x: 5, y: 0 });
  // center 3.5 (span 2..5) → first half mid→z1 (reversed), kept part 2..4: width 2, center x=3 → along 1
  assert.equal(r[1].ops.length, 1);
  assert.equal(r[1].ops[0].key, `${r[1].mid}|z1`);
  near(r[1].ops[0].width, 2, "trimmed width");
  near(r[1].ops[0].along, 1, "trimmed center, re-based into the reversed half");
  assert.deepEqual(r[1].ops[0].p, { x: 3, y: 0 });
});

/* ---------------- merge ---------------- */

/* Hand-worked (deletePoint): room loop a1(0,0) → m(4,0) → a2(10,0) → …
   Walls: "a1|m" (lo a1, runs +x, length 4) and "a2|m" (lo a2 at x=10, runs
   −x, length 6 — REVERSED relative to the merged wall). Deleting m merges
   both into "a1|a2" (lo a1, runs +x, length 10).
   - door on a1|m at along 1: same direction, shift 0 → 1.
   - window on a2|m at along 2: its center is x = 10 − 2 = 8. Reversed, so
     along' = (oldLen − along) + shift = (6 − 2) + 4 = 8. ✔
     A naive "add the first wall's length" gives 2 + 4 = 6 — wrong by 2 ft,
     and just copying gives 2. */
test("merge (deletePoint): openings from both walls are concatenated; the reversed contributor is flipped then shifted", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    f.points.push(P("m",4,0)); f._pt.set("m", f.points[f.points.length-1]);
    f.rooms[0].loop = ["a1","m","a2","a3","a4"]; deriveWalls(f);
    const d = addOpening(f, W(f,"a1","m"), {type:"door", width:1.5, along:1});
    const w = addOpening(f, W(f,"a2","m"), {type:"window", width:2, along:2});
    setWallThickness(f, W(f,"a1","m"), 0.5);
    const before = {[d.id]: at(f,"a1|m",d), [w.id]: at(f,"a2|m",w)};
    deletePoint(f, "m");
    return { ids:{d:d.id, w:w.id}, before, props: f.wallProps,
      worlds: Object.fromEntries(allOpenings(f).map(o => [o.id, at(f,o.key,o)])) };
  `);
  const ops = r.props["a1|a2"].openings;
  assert.equal(r.props["a1|a2"].thickness, 0.5, "non-opening props still merge as before");
  assert.deepEqual(ops.map(o => o.id), [r.ids.d, r.ids.w], "both survive, sorted by position");
  near(ops[0].along, 1, "door (same-direction contributor)");
  near(ops[1].along, 8, "window (reversed contributor): (6 - 2) + 4");
  assert.deepEqual(r.worlds, r.before, "neither opening moved in the world");
});

/* Hand-worked (weldPoints): B's corners are named so its left wall's key is
   "b1|b9" with lo = b1 at (10,10) — it runs UP (−y), opposite to A's right
   wall "a2|a3" (lo a2 at (10,0), runs +y). Window on b1|b9 at along 2 →
   world (10, 8). After welding b9→a2 and b1→a3 it must sit at along 8 on
   a2|a3 (a copy-as-is merge would put it at 2, on top of A's door at 3). */
test("merge (weldPoints): two coincident walls each with an opening — both kept, reversed one re-based", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = makeLevel("T", []);
    f.points = [P("a1",0,0),P("a2",10,0),P("a3",10,10),P("a4",0,10),
                P("b9",10,0),P("b2",20,0),P("b3",20,10),P("b1",10,10)];
    f.rooms = [{id:"rA",name:"A",kind:"room",loop:["a1","a2","a3","a4"]},
               {id:"rB",name:"B",kind:"room",loop:["b9","b2","b3","b1"]}];
    install(f);
    const door = addOpening(f, W(f,"a2","a3"), {type:"door", along:3});          // span 1.5..4.5
    const win = addOpening(f, W(f,"b1","b9"), {type:"window", width:2, along:2}); // world y = 8
    const before = {[door.id]: at(f,"a2|a3",door), [win.id]: at(f,"b1|b9",win)};
    weldPoints(f, "b9", "a2");
    const mid = JSON.parse(JSON.stringify(f.wallProps));
    weldPoints(f, "b1", "a3");
    return { ids:{door:door.id, win:win.id}, before, mid, props: f.wallProps,
      worlds: Object.fromEntries(allOpenings(f).map(o => [o.id, at(f,o.key,o)])) };
  `);
  // intermediate: b1|b9 became a2|b1 (lo a2, now runs +y) → 8 already
  near(r.mid["a2|b1"].openings[0].along, 8, "after the first weld");
  const ops = r.props["a2|a3"].openings;
  assert.deepEqual(ops.map(o => o.id), [r.ids.door, r.ids.win]);
  near(ops[0].along, 3, "A's own door untouched");
  near(ops[1].along, 8, "B's window flipped into A's frame");
  assert.deepEqual(r.worlds, r.before);
  assert.equal(Object.values(r.props).flatMap(p => p.openings || []).length, 2, "no duplicates elsewhere");
});

test("merge (deletePoint) on a corner shared by two rooms: an opening on the shared wall goes to ONE resulting wall", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    // A below the shared wall p(0,0)–m(10,0), B above it; deleting m turns
    // m|p into p|q in A and into p|u in B — two different targets.
    const f = makeLevel("T", []);
    f.points = [P("p",0,0),P("m",10,0),P("q",10,10),P("s",0,10),P("t",0,-4),P("u",10,-4)];
    f.rooms = [{id:"rA",name:"A",kind:"room",loop:["p","m","q","s"]},
               {id:"rB",name:"B",kind:"room",loop:["m","p","t","u"]}];
    install(f);
    addOpening(f, W(f,"m","p"), {type:"window", width:2, along:7});   // lo = m: center x = 3
    deletePoint(f, "m");
    return allOpenings(f);
  `);
  assert.equal(r.length, 1, "never duplicated onto both rooms' new walls");
  // (3,0) is ~1.1 ft from B's new wall p–u and ~2.1 ft from A's p–q
  assert.equal(r[0].key, "p|u");
});

test("merge: a wall collapsed to zero length by a weld drops its openings", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    f.points.push(P("a5",5,0)); f._pt.set("a5", f.points[f.points.length-1]);
    f.rooms[0].loop = ["a1","a5","a2","a3","a4"]; deriveWalls(f);
    addOpening(f, W(f,"a5","a2"), {type:"window", width:1, along:2.5});
    weldPoints(f, "a5", "a2");
    return allOpenings(f);
  `);
  assert.deepEqual(r, []);
});

/* ---------------- detach ---------------- */

test("detachRoom on a shared wall: the opening stays on exactly one wall — the side that kept the original ids", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    weldPoints(f, "b1", "a2"); weldPoints(f, "b4", "a3");   // A and B share a2|a3
    setWallThickness(f, W(f,"a2","a3"), 0.5);
    const door = addOpening(f, W(f,"a2","a3"), {type:"door", along:4});
    detachRoom(f, f.rooms[1]);                               // B gets private corners
    return { door, ops: allOpenings(f), props: f.wallProps };
  `);
  assert.equal(r.ops.length, 1, "never on both resulting walls");
  assert.equal(r.ops[0].key, "a2|a3", "A (whose ids are unchanged) keeps the door");
  near(r.ops[0].along, 4, "unchanged");
  const bSide = Object.keys(r.props).filter(k => k !== "a2|a3");
  assert.equal(bSide.length, 1);
  assert.equal(r.props[bSide[0]].thickness, 0.5, "thickness still copied to B's side");
  assert.ok(!r.props[bSide[0]].openings, "…but not the door");
});

test("detachCorner on a shared wall: likewise exactly one copy, on the first room's wall", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    weldPoints(f, "b1", "a2"); weldPoints(f, "b4", "a3");
    addOpening(f, W(f,"a2","a3"), {type:"window", along:6});
    detachCorner(f, "a2");
    return allOpenings(f);
  `);
  assert.equal(r.length, 1);
  assert.equal(r[0].key, "a2|a3");
  near(r[0].along, 6, "unchanged");
});

test("detach of an unshared wall: the opening follows to the new key and is re-based when fresh ids sort the other way", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    const d = addOpening(f, W(f,"a1","a2"), {type:"door", along:2});   // a1 (0,0) → a2 (10,0)
    const before = at(f,"a1|a2",d);
    _pid = 9;                         // a1→p9, a2→p10: "p10" < "p9", so the new key runs a2-side → a1-side
    detachRoom(f, f.rooms[0]);
    return { before, ops: allOpenings(f).map(o => ({...o, p: at(f,o.key,o)})) };
  `);
  assert.equal(r.ops.length, 1);
  assert.equal(r.ops[0].key, "p10|p9");
  near(r.ops[0].along, 8, "10 - 2: the frame reversed (a copy-as-is would leave 2)");
  assert.deepEqual(r.ops[0].p, r.before, "same world position");
});

/* ---------------- ids / persistence ---------------- */

test("syncIds: an opening id nested in wallProps bumps _pid past it", () => {
  const { run } = loadApp();
  const r = run(() => {
    const saved = { schemaVersion: 2, activeLevelId: "lvl0", levels: [{
      id: "lvl0", name: "L", points: [{id:"p1",x:0,y:0},{id:"p2",x:10,y:0},{id:"p3",x:10,y:10}], walls: [],
      rooms: [{id:"r1", name:"R", kind:"room", loop:["p1","p2","p3"]}],
      wallProps: { "p1|p2": { openings: [{ id: "op57", type: "door", along: 5, width: 3, swing: "in", hand: "left", room: "r1" }] } },
      defaultThickness: 0.375 }] };
    _pid = 0;
    data = loadData(saved);
    const after = _pid;
    const o = addOpening(activeLevel(), wallById(activeLevel(), "w_p2|p3"), { type: "window" });
    return { after, newId: o.id };
  });
  assert.ok(r.after >= 58, "_pid was " + r.after);
  assert.notEqual(r.newId, "op57");
});

test("save/load round trip keeps openings exactly (no schema bump); malformed entries are dropped", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    addOpening(f, W(f,"a1","a2"), {type:"door", along:3, swing:"out", hand:"right"});
    addOpening(f, W(f,"a1","a2"), {type:"window", along:7.5, width:2});
    addOpening(f, W(f,"b2","b3"), {type:"garage", width:8});
    const before = JSON.parse(JSON.stringify(f.wallProps));
    const saved = JSON.parse(JSON.stringify(stripIdx(data)));
    const copy = JSON.parse(JSON.stringify(saved));
    copy.levels[0].wallProps["b1|b2"] = { openings: [{ id:"x", type:"door", along:"5", width:3 }, null] };
    copy.levels[0].wallProps["b3|b4"] = { thickness: 0.5, openings: "junk" };
    return { version: saved.schemaVersion, before, after: loadData(saved).levels[0].wallProps,
      sanitized: loadData(copy).levels[0].wallProps };
  `);
  assert.equal(r.version, 2);
  assert.deepEqual(r.after, r.before);
  assert.ok(!("b1|b2" in r.sanitized), "an entry left with no valid openings is dropped");
  assert.deepEqual(r.sanitized["b3|b4"], { thickness: 0.5 });
});

/* ---------------- length edits / open walls ---------------- */

test("length edit: a shortened wall clamps the DISPLAYED opening; stored data is untouched and comes back", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    const w = W(f,"a1","a2");
    const o = addOpening(f, w, {type:"door", along:8});     // span 6.5..9.5
    opts.lengthMode = "centerline";   // this test is about centerline length / opening clamping, not inside-length mode
    sel = {type:"wall", id:w.id}; renderInspector();
    movingEnd = "b";
    const setLen = v => { document.getElementById("lenInput").value = v; applyLength(w); };
    const which = w.b;                                       // the end that moves
    setLen("6");
    const short = { stored: {...findOpening(f,"a1|a2",o.id)}, disp: displayedOpening(findOpening(f,"a1|a2",o.id), wallFrame(f,"a1|a2").len) };
    setLen("10");
    const back = { stored: {...findOpening(f,"a1|a2",o.id)}, disp: displayedOpening(findOpening(f,"a1|a2",o.id), wallFrame(f,"a1|a2").len) };
    return { which, short, back };
  `);
  assert.equal(r.which, "a2", "a2 is both w.b and the wall's hi end, so `along` is measured from the fixed end");
  near(r.short.stored.along, 8, "stored offset not mutated");
  assert.equal(r.short.stored.width, 3);
  assert.equal(r.short.disp.clamped, true);
  near(r.short.disp.along, 4.5, "drawn flush with the shortened end");
  assert.equal(r.short.disp.width, 3);
  near(r.back.disp.along, 8, "lengthening restores it");
  assert.equal(r.back.disp.clamped, false);
});

test("render: an opening draws a selectable glyph; on an open wall it is hidden but kept", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    const o = addOpening(f, W(f,"a1","a2"), {type:"door"});
    const find = () => { let hit=null; (function walk(n){ if(n.dataset && n.dataset.opening===o.id) hit=n; (n.children||[]).forEach(walk); })(svg); return hit; };
    // the stub svg has no firstChild, so render() can't clear it — do it here
    svg.children = []; render(); const shown = !!find();
    setWallOpen(f, W(f,"a1","a2"), true);
    svg.children = []; render(); const hidden = !find();
    return { shown, hidden, kept: openingsAt(f,"a1|a2").length };
  `);
  assert.ok(r.shown);
  assert.ok(r.hidden);
  assert.equal(r.kept, 1);
});

test("swing side: 'in' points into the reference room's interior, 'out' away; a shared wall picks by room", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    weldPoints(f, "b1", "a2"); weldPoints(f, "b4", "a3");
    const top = addOpening(f, W(f,"a1","a2"), {type:"door"});                    // A's exterior top wall
    const shared = addOpening(f, W(f,"a2","a3"), {type:"door", room:"rB"});      // A | B
    const n = (k,o) => { const v=openingSwingNormal(f,k,o); return [Math.round(v.x), Math.round(v.y)]; };
    const res = { topIn: n("a1|a2", top), intoB: n("a2|a3", shared) };
    updateOpening(f, "a1|a2", top.id, {swing:"out"});
    updateOpening(f, "a2|a3", shared.id, {room:"rA"});
    res.topOut = n("a1|a2", top); res.intoA = n("a2|a3", shared);
    return res;
  `);
  assert.deepEqual(r.topIn, [0, 1], "into A (y grows downward into the room)");
  assert.deepEqual(r.topOut, [0, -1]);
  assert.deepEqual(r.intoB, [1, 0], "B is to the right of the shared wall");
  assert.deepEqual(r.intoA, [-1, 0]);
});

/* ---------------- UI ---------------- */

test("UI: '+ Door' in the wall inspector adds at the center through commit() and selects it; delete + undo", () => {
  const { run } = loadApp();
  vmRun(run, `
    const f = setupTwoRooms();
    sel = { type: "wall", id: wallIdForKey("a1|a2") };
    renderInspector();
  `);
  run(() => document.getElementById("opAdd-door").onclick());
  let s = run(() => ({ h: history.length, sel, ops: openingsAt(activeLevel(), "a1|a2") }));
  assert.equal(s.h, 1);
  assert.equal(s.ops.length, 1);
  assert.equal(s.ops[0].along, 5);
  assert.deepEqual(s.sel, { type: "opening", id: s.ops[0].id, wallKey: "a1|a2" });

  // opening inspector: edit width/offset, then delete
  run(() => { document.getElementById("opAlong").value = "2"; document.getElementById("opWidth").value = "2'6\""; document.getElementById("opApply").onclick(); });
  s = run(() => ({ h: history.length, o: openingsAt(activeLevel(), "a1|a2")[0] }));
  assert.equal(s.h, 2);
  assert.equal(s.o.along, 2);
  assert.equal(s.o.width, 2.5);
  run(() => document.getElementById("opHand").onchange && (document.getElementById("opHand").value = "right", document.getElementById("opHand").onchange()));
  assert.equal(run(() => openingsAt(activeLevel(), "a1|a2")[0].hand), "right");
  run(() => document.getElementById("opDel").onclick());
  s = run(() => ({ h: history.length, ops: openingsAt(activeLevel(), "a1|a2"), sel }));
  assert.equal(s.ops.length, 0);
  assert.deepEqual(s.sel, { type: "wall", id: "w_a1|a2" }, "back to the host wall");
  run(() => undo());
  assert.equal(run(() => openingsAt(activeLevel(), "a1|a2").length), 1, "undo restores it");
});

test("UI: a type that can't fit leaves no undo entry", () => {
  const { run } = loadApp();
  vmRun(run, `
    const f = setupTwoRooms();
    ptOf(f,"b2").x = 16;                                     // B's top wall: 6 ft
    sel = { type: "wall", id: wallIdForKey("b1|b2") };
    renderInspector();
  `);
  run(() => document.getElementById("opAdd-garage").onclick());
  assert.deepEqual(run(() => ({ h: history.length, n: openingsAt(activeLevel(), "b1|b2").length })), { h: 0, n: 0 });
});

test("drag: slides along the wall only, clamps at neighbours, lazy undo, click alone is not a change", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    const d = addOpening(f, W(f,"a1","a2"), {type:"door", along:3});
    addOpening(f, W(f,"a1","a2"), {type:"window", width:2, along:8.5});   // span 7.5..9.5
    history.length = 0;
    const ev = (x,y,alt) => ({ clientX:x, clientY:y, altKey:!!alt, stopPropagation(){}, pointerId:1 });
    const out = {};
    // press + release without moving: selection only
    startDragOpening(ev(100,100), "a1|a2", d.id);
    out.sel = {...sel};
    interactionHandlers.opening.end(interaction, ev(100,100));
    out.hClick = history.length;
    // drag +1 ft along x and 5 ft across (y): only the along-wall part counts
    startDragOpening(ev(100,100), "a1|a2", d.id);
    interactionHandlers.opening.move(interaction, ev(100 + view.scale, 100 + 5*view.scale));
    out.a1 = findOpening(f,"a1|a2",d.id).along;
    // keep dragging far right: stops 2" short of the window
    interactionHandlers.opening.move(interaction, ev(100 + 20*view.scale, 100));
    out.a2 = findOpening(f,"a1|a2",d.id).along;
    interactionHandlers.opening.end(interaction, ev(0,0));
    out.hDrag = history.length;
    undo();
    out.undone = findOpening(activeLevel(),"a1|a2",d.id).along;
    return out;
  `);
  assert.equal(r.sel.type, "opening");
  assert.equal(r.hClick, 0, "a plain click pushes no undo entry");
  near(r.a1, 4, "perpendicular motion ignored");
  near(r.a2, 7.5 - 2 / 12 - 1.5, "clamped against the window with the minimum gap");
  assert.equal(r.hDrag, 1, "one undo entry for the whole drag");
  near(r.undone, 3, "undo restores the pre-drag offset");
});
