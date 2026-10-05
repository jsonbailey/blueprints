"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./harness");

/* opts.lengthMode ("centerline" | "inside"): a session-only view/edit toggle
   for wall length — see ARCHITECTURE.md/this feature's own spec (not yet a
   named roadmap item) and js/state.js's comment on `opts`. Covers:
     - the wall inspector's Length bigval/input (wallLengthState, applyLength
       in js/inspector.js)
     - the bisection-based inverse (typed inside length -> target centerline,
       solveCenterlineForInside) landing within LENGTH_SOLVE_TOL of the typed
       target across repeated edits, including at a GENUINE turning corner —
       where an earlier linear-delta version was only approximate (verified
       to drift 0.5 -> 0.57 -> 0.70 ft across edits before the fix)
     - a shared wall's two rooms moving together, not independently
     - centerline mode being a pure regression of the original behavior */

const EPS = 1e-6;
function near(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) <= EPS, `${msg}: expected ${expected}, got ${actual}`);
}

/* Build a single rectangular room A(0,0) B(W,0) C(W,H) D(0,H), uniform
   thickness t, install it as the active level, and divide wall A-B at its
   midpoint — so the near half (A to mid) has a FIXED end (A, a genuine 90°
   corner with D-A) and a MOVING end (mid) that is a collinear, same-
   thickness pass-through from room R's point of view (both A-mid and mid-B
   share the wall's thickness via divideWall's copy-to-both-halves rule).
   That moving end is therefore NOT a turn for R, which is exactly the
   condition under which the centerline<->inside delta is exact (see
   applyLength's comment) — this is a realistic, common shape (any wall
   that's been divided, or any point partway along an otherwise-straight
   run), not a contrived one. Returns the near-half wall and which of its
   `a`/`b` is the dividing midpoint (the end to move). */
const SETUP = `
  function rectWithDividedWall(W, H, t){
    const f = makeLevel("T", []);
    f.points = [{id:"A",x:0,y:0},{id:"B",x:W,y:0},{id:"C",x:W,y:H},{id:"D",x:0,y:H}];
    f.rooms = [{id:"R", name:"Room", kind:"room", loop:["A","B","C","D"]}];
    f.defaultThickness = t;
    indexLevel(f);
    data.levels=[f]; data.activeLevelId=f.id;
    const wAB = f.walls.find(w=>wallKeyOf(w)===wallKey("A","B"));
    const midId = divideWall(f, wAB);
    const wAM = f.walls.find(w=>(w.a===midId||w.b===midId) && (w.a==="A"||w.b==="A"));
    movingEnd = (wAM.a===midId) ? "a" : "b";
    return {f, wAM, midId};
  }
  function setLenInside(f, w, mode, value){
    opts.lengthMode = mode;
    sel = {type:"wall", id:w.id}; renderInspector();
    document.getElementById("lenInput").value = value;
    applyLength(w);
  }
`;
function vmRun(run, body, args) {
  const fn = `(args)=>{ ${SETUP} ${body} }`;
  return run({ toString: () => fn }, args === undefined ? null : args);
}

test("inside mode: setting a wall's length produces the exact expected interior length", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const {f, wAM} = rectWithDividedWall(20, 10, 0.5);   // half=0.25; A's corner with D-A costs 0.25 off the near end
    const before = { centerline: Math.hypot(ptOf(f,wAM.b).x-ptOf(f,wAM.a).x, ptOf(f,wAM.b).y-ptOf(f,wAM.a).y),
      inside: wallSides(f, wAM).find(s=>s.side).side.len };
    setLenInside(f, wAM, "inside", "9");   // desired INSIDE length = 9'
    const a=ptOf(f,wAM.a), b=ptOf(f,wAM.b);
    const after = { centerline: Math.hypot(b.x-a.x,b.y-a.y), inside: wallSides(f, wAM).find(s=>s.side).side.len };
    return {before, after};
  `);
  near(r.before.centerline, 10, "sanity: initial centerline is the undivided half-length");
  near(r.before.inside, 9.75, "sanity: initial inside length (10 - 0.25 cutback at A's corner, 0 at the divided end)");
  near(r.after.inside, 9, "typed inside value hit exactly");
  near(r.after.centerline, 9.25, "centerline = desired inside (9) + the unchanged 0.25 delta");
});

test("inside mode: the delta stays exact through a SECOND edit in a row", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const {f, wAM} = rectWithDividedWall(20, 10, 0.5);
    setLenInside(f, wAM, "inside", "9");
    const mid1 = wallSides(f, wAM).find(s=>s.side).side.len;
    setLenInside(f, wAM, "inside", "6'6\\"");   // second edit, further shortened
    const a=ptOf(f,wAM.a), b=ptOf(f,wAM.b);
    const after2 = { centerline: Math.hypot(b.x-a.x,b.y-a.y), inside: wallSides(f, wAM).find(s=>s.side).side.len };
    return {mid1, after2};
  `);
  near(r.mid1, 9, "first edit still exact");
  near(r.after2.inside, 6.5, "second edit also exact — the delta recomputed fresh still holds");
  near(r.after2.centerline, 6.75, "centerline = 6.5 + the same 0.25 delta");
});

/* The actual scenario that exposed the linear-delta bug: a wall whose
   MOVING end is a genuine 90° turn (not a divided/collinear continuation).
   Extending wall AB by sliding B rotates the perpendicular wall BC (C stays
   fixed in space), which is a nonlinear effect on the interior-corner
   intersection — a plain "delta = centerline - inside, add it back" came out
   wrong and kept drifting further wrong across repeated edits (measured:
   0.5 -> 0.57 -> 0.70 ft gap instead of a constant 0.5 ft). This is the
   regression test for solveCenterlineForInside fixing that by bisection
   against the real geometry instead of a formula. */
test("inside mode at a GENUINE turning corner: bisection lands on the typed target exactly (the case where the old linear delta drifted)", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    // Plain (undivided) rectangle: A(0,0) B(10,0) C(10,8) D(0,8), thickness
    // 0.5 (half 0.25) on every wall. Edit wall AB, moving its B end — which
    // is also the near end of wall BC, a real 90 degree turn.
    const f = makeLevel("T", []);
    f.points = [{id:"A",x:0,y:0},{id:"B",x:10,y:0},{id:"C",x:10,y:8},{id:"D",x:0,y:8}];
    f.rooms = [{id:"R", name:"R", kind:"room", loop:["A","B","C","D"]}];
    f.defaultThickness = 0.5;
    indexLevel(f);
    data.levels=[f]; data.activeLevelId=f.id;
    const wAB = f.walls.find(w=>wallKeyOf(w)===wallKey("A","B"));
    movingEnd = "b";   // B moves; A (and the far end of BC's neighbour, D) stays fixed
    function insideLen(){ return wallSides(f, wAB).find(s=>s.side).side.len; }
    const before = { centerline: Math.hypot(ptOf(f,"B").x-ptOf(f,"A").x, ptOf(f,"B").y-ptOf(f,"A").y), inside: insideLen() };
    setLenInside(f, wAB, "inside", "11.43");   // a value the OLD linear delta could not hit exactly here
    const after1 = { centerline: Math.hypot(ptOf(f,"B").x-ptOf(f,"A").x, ptOf(f,"B").y-ptOf(f,"A").y), inside: insideLen() };
    setLenInside(f, wAB, "inside", "14.3");    // second edit in a row — must still be exact, not drifting further
    const after2 = { centerline: Math.hypot(ptOf(f,"B").x-ptOf(f,"A").x, ptOf(f,"B").y-ptOf(f,"A").y), inside: insideLen() };
    return {before, after1, after2};
  `);
  near(r.before.centerline, 10, "sanity: initial centerline");
  near(r.before.inside, 9.5, "sanity: initial inside length (90 degree corner, cutback 0.25 at each end)");
  near(r.after1.inside, 11.43, "bisection hits the typed target exactly at a real turning corner");
  near(r.after2.inside, 14.3, "a second edit in a row is still exact — no drift");
});

test("inside mode on a shared wall: the targeted room's length hits exactly; the other room's shifts by the same raw delta, not independently", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    // A (x 0..10) and B (x 10..20) share a DIVIDED wall at x=10, split at y=5.
    // A's OTHER walls are thick (1.0 ft) so A's interior length differs from B's.
    const f = makeLevel("T", []);
    f.points = [{id:"a1",x:0,y:0},{id:"s1",x:10,y:0},{id:"s2",x:10,y:10},{id:"a4",x:0,y:10},
                {id:"b2",x:20,y:0},{id:"b3",x:20,y:10}];
    f.rooms = [{id:"A", name:"A", kind:"room", loop:["a1","s1","s2","a4"]},
               {id:"B", name:"B", kind:"room", loop:["s1","s2","b3","b2"]}];
    f.defaultThickness = 0.375;
    indexLevel(f);
    data.levels=[f]; data.activeLevelId=f.id;
    setWallThickness(f, f.walls.find(w=>wallKeyOf(w)===wallKey("a1","s1")), 1.0);
    setWallThickness(f, f.walls.find(w=>wallKeyOf(w)===wallKey("s2","a4")), 1.0);
    const shared = f.walls.find(w=>wallKeyOf(w)===wallKey("s1","s2"));
    const midId = divideWall(f, shared);
    const wTop = f.walls.find(w=>(w.a===midId||w.b===midId) && (w.a==="s1"||w.b==="s1"));
    movingEnd = (wTop.a===midId) ? "a" : "b";
    function lens(){
      const sides = wallSides(f, wTop).filter(s=>s.side);
      const A = sides.find(s=>s.room.id==="A").side.len, B = sides.find(s=>s.room.id==="B").side.len;
      const a=ptOf(f,wTop.a), b=ptOf(f,wTop.b);
      return {A, B, centerline: Math.hypot(b.x-a.x,b.y-a.y)};
    }
    const before = lens();
    opts.lengthMode = "inside";
    sel = {type:"wall", id:wTop.id}; renderInspector();
    lengthRoom = "A";   // target room A explicitly (mirrors the inspector's room picker)
    renderInspector();
    document.getElementById("lenInput").value = "4";   // desired inside length for A
    applyLength(wTop);
    const after = lens();
    return {before, after};
  `);
  near(r.before.centerline, 5, "sanity: half of the 10' shared wall");
  near(r.after.A, 4, "room A's targeted inside length hit exactly");
  const centerlineDelta = r.after.centerline - r.before.centerline;
  const bDelta = r.after.B - r.before.B;
  near(bDelta, centerlineDelta, "room B's interior length shifted by the SAME amount the centerline changed — not independently targeted");
});

test("centerline mode: Set length still sets the raw endpoint distance exactly, unchanged from before this feature", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const {f, wAM} = rectWithDividedWall(20, 10, 0.5);
    setLenInside(f, wAM, "centerline", "12.5");
    const a=ptOf(f,wAM.a), b=ptOf(f,wAM.b);
    return { centerline: Math.hypot(b.x-a.x,b.y-a.y) };
  `);
  near(r.centerline, 12.5, "centerline mode: typed value is the raw endpoint distance, no delta conversion");
});

test("wallLengthState falls back to centerline (with a degenerate flag) when a wall has no usable interior side", () => {
  const { run } = loadApp();
  const r = run(() => {
    const f = makeLevel("T", []);
    // A zero-area "room" (every corner collapsed onto one of two points) —
    // roomInterior finds no usable offset geometry at all (sign 0, every
    // edge null), so wallSides reports {side:null} for this wall.
    f.points = [{id:"p0",x:0,y:0},{id:"p1",x:10,y:0},{id:"p2",x:10,y:0},{id:"p3",x:0,y:0}];
    f.rooms = [{id:"R", name:"R", kind:"room", loop:["p0","p1","p2","p3"]}];
    f.defaultThickness = 0.5;
    indexLevel(f);
    data.levels=[f]; data.activeLevelId=f.id;
    opts.lengthMode = "inside";
    const w = f.walls.find(x=>wallKeyOf(x)===wallKey("p0","p1"));
    sel = {type:"wall", id:w.id};
    renderInspector();
    // the dom-stub doesn't parse innerHTML into real nodes (getElementById
    // returns a fresh stand-in regardless of markup), so assert against the
    // rendered HTML string itself rather than reading a "value" attribute
    // back off a stub element.
    const html = document.getElementById("inspectorBody").innerHTML;
    return { html, state: wallLengthState(f, w) };
  });
  assert.ok(r.html.includes("centerline instead"), "degenerate geometry should fall back to centerline with an explanatory note, not crash or show nonsense");
  assert.equal(r.state.mode, "centerline");
  assert.equal(r.state.degenerate, true);
  near(r.state.len, 10, "falls back to showing the raw centerline length");
});

test("render: centerline mode shows ONE dimension label per wall at the raw length (not per-room interior length)", () => {
  const { run } = loadApp();
  const r = run(() => {
    const f = makeLevel("T", []);
    f.points = [{id:"a1",x:0,y:0},{id:"s1",x:10,y:0},{id:"s2",x:10,y:10},{id:"a4",x:0,y:10},
                {id:"b2",x:20,y:0},{id:"b3",x:20,y:10}];
    f.rooms = [{id:"A", name:"A", kind:"room", loop:["a1","s1","s2","a4"]},
               {id:"B", name:"B", kind:"room", loop:["s1","s2","b3","b2"]}];
    f.defaultThickness = 0.375;
    indexLevel(f);
    data.levels=[f]; data.activeLevelId=f.id;
    opts.lengthMode = "centerline"; opts.dims = true;
    view.scale = 20; view.ox = 0; view.oy = 0;
    render();
    const texts = [];
    (function walk(n){ (n.children||[]).forEach(c=>{ if(c.tagName==="TEXT") texts.push(c.textContent); walk(c); }); })(svg);
    return { texts };
  });
  const dims = r.texts.filter(t => /^\d+'\d+"$/.test(t));
  // 7 walls total (a1-s1, s1-s2 shared, s2-a4, a4-a1, s1-b2, b2-b3, b3-s2) -> 7 labels, not 8
  assert.equal(dims.length, 7, "one label per wall in centerline mode: " + JSON.stringify(r.texts));
  assert.ok(dims.includes(`10'0"`), "the shared wall shows its raw 10' centerline length once: " + JSON.stringify(dims));
});
