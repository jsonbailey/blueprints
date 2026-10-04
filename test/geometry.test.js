"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./harness");

/* Interior-offset geometry (ARCHITECTURE.md item 3, "Interior
   dimensions/area"): offsetPolygon / roomInterior / interiorArea /
   wallSides, plus the render-side per-side dimension labels. */

const EPS = 1e-9;
function near(actual, expected, msg, eps = EPS) {
  assert.ok(Math.abs(actual - expected) <= eps, `${msg}: expected ${expected}, got ${actual}`);
}
function nearPt(p, q, msg, eps = EPS) {
  near(p.x, q.x, msg + " (x)", eps);
  near(p.y, q.y, msg + " (y)", eps);
}

/* Inside the vm: build a level from raw points/rooms and install it as the
   active level. Source string so every run() can use it. */
const SETUP = `
  function level(points, rooms, defaultThickness){
    const f = makeLevel("T", []);
    f.points = points.map(([id,x,y])=>({id,x,y}));
    f.rooms = rooms.map(([id,loop])=>({id, name:id, kind:"room", loop}));
    if(defaultThickness!=null) f.defaultThickness = defaultThickness;
    indexLevel(f);
    data.levels=[f]; data.activeLevelId=f.id;
    return f;
  }
  function wallOf(f,a,b){ return f.walls.find(w=>wallKeyOf(w)===wallKey(a,b)); }
`;
function vmRun(run, body, args) {
  const fn = `(args)=>{ ${SETUP} ${body} }`;
  return run({ toString: () => fn }, args === undefined ? null : args);
}

/* Perpendicular distance from p to the infinite line through a,b. */
function distToLine(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / Math.hypot(dx, dy);
}
/* Ray-cast point-in-polygon (strict interior is enough for these cases). */
function inside(p, vs) {
  let c = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const a = vs[i], b = vs[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

test("sign convention: the exact rectangle addRoom() produces insets by t/2 on every side (not outward)", () => {
  const { run } = loadApp();
  const t = 0.5;   // ft, uniform on all four walls
  const r = run((t) => {
    const f = activeLevel();
    f.defaultThickness = t;
    addRoom();
    const room = f.rooms[f.rooms.length - 1];
    const pts = room.loop.map(id => { const p = ptOf(f, id); return { x: p.x, y: p.y }; });
    const g = roomInterior(f, room);
    return { pts, sign: signedAreaXY(pts) > 0 ? 1 : -1, g, area: interiorArea(f, room), center: polyArea(f, room.loop) };
  }, t);
  // addRoom's shape: TL, TR, BR, BL of a 12 x 10 rectangle
  const [x0, y0] = [r.pts[0].x, r.pts[0].y];
  const W = 12, H = 10;
  assert.deepEqual(r.pts.map(p => [p.x - x0, p.y - y0]), [[0, 0], [W, 0], [W, H], [0, H]]);
  assert.equal(r.sign, 1, "addRoom's winding has positive signed area");
  assert.equal(r.g.sign, 1);
  const h = t / 2;
  const expected = [[h, h], [W - h, h], [W - h, H - h], [h, H - h]];
  assert.equal(r.g.poly.length, 4);
  r.g.poly.forEach((p, i) => nearPt({ x: p.x - x0, y: p.y - y0 }, { x: expected[i][0], y: expected[i][1] }, `corner ${i}`));
  assert.deepEqual(r.g.kinds, ["miter", "miter", "miter", "miter"]);
  // inward normal of the top edge points DOWN (+y, toward y0+H), etc.
  nearPt(r.g.edges[0].n, { x: 0, y: 1 }, "top edge inward normal");
  nearPt(r.g.edges[1].n, { x: -1, y: 0 }, "right edge inward normal");
  // interior clear lengths per edge
  [W - t, H - t, W - t, H - t].forEach((L, i) => near(r.g.edges[i].len, L, `edge ${i} interior length`));
  near(r.area, (W - t) * (H - t), "interior area");
  near(r.center, W * H, "centerline area");
  assert.ok(r.area < r.center, "interior polygon must be SMALLER than the centerline polygon");
});

test("sign convention: the same rectangle wound the other way gives the same inset polygon", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = level([["a",0,0],["b",0,10],["c",12,10],["d",12,0]], [["R",["a","b","c","d"]]], 0.5);
    const room = f.rooms[0];
    return { sign: roomInterior(f, room).sign, poly: roomInterior(f, room).poly, area: interiorArea(f, room) };
  `);
  assert.equal(r.sign, -1);
  const expected = [[0.25, 0.25], [0.25, 9.75], [11.75, 9.75], [11.75, 0.25]];
  r.poly.forEach((p, i) => nearPt(p, { x: expected[i][0], y: expected[i][1] }, `corner ${i}`));
  near(r.area, 11.5 * 9.5, "interior area");
});

test("L-shaped room: reflex corner is inset correctly (no convexity assumption)", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = level([["p0",0,0],["p1",10,0],["p2",10,4],["p3",4,4],["p4",4,10],["p5",0,10]],
                    [["L",["p0","p1","p2","p3","p4","p5"]]], 0.5);
    const g = roomInterior(f, f.rooms[0]);
    return { g, area: interiorArea(f, f.rooms[0]), center: polyArea(f, f.rooms[0].loop) };
  `);
  const expected = [[0.25, 0.25], [9.75, 0.25], [9.75, 3.75], [3.75, 3.75], [3.75, 9.75], [0.25, 9.75]];
  assert.equal(r.g.poly.length, 6);
  r.g.poly.forEach((p, i) => nearPt(p, { x: expected[i][0], y: expected[i][1] }, `corner ${i}`));
  assert.ok(r.g.kinds.every(k => k === "miter"));
  // shoelace of the expected L: 9.5*3.5 + 3.5*6 = 54.25
  near(r.area, 9.5 * 3.5 + 3.5 * 6, "interior area");
  assert.ok(r.area < r.center);
});

test("non-90° corners with per-wall thickness overrides: every corner is h_prev / h_next from its two centerlines, inside the room", () => {
  const { run } = loadApp();
  // trapezoid with a 56.3° and a 123.7° corner; slanted wall gets a thick override
  const pts = [["a", 0, 0], ["b", 10, 0], ["c", 6, 6], ["d", 0, 6]];
  const r = vmRun(run, `
    const f = level(args.pts, [["T",["a","b","c","d"]]], 0.375);
    setWallThickness(f, wallOf(f,"b","c"), 1.0);
    setWallThickness(f, wallOf(f,"c","d"), 0.25);
    const room = f.rooms[0];
    const halfs = room.loop.map((id,i)=>effThickness(f,{a:id,b:room.loop[(i+1)%4]})/2);
    return { g: roomInterior(f, room), halfs, area: interiorArea(f, room), center: polyArea(f, room.loop) };
  `, { pts });
  const V = pts.map(([, x, y]) => ({ x, y }));
  assert.deepEqual(r.halfs, [0.1875, 0.5, 0.125, 0.1875]);
  assert.ok(r.g.kinds.every(k => k === "miter"), "all four corners are real miters: " + r.g.kinds);
  assert.equal(r.g.poly.length, 4);
  r.g.poly.forEach((p, i) => {
    const prev = (i + 3) % 4;
    near(distToLine(p, V[prev], V[i]), r.halfs[prev], `corner ${i} distance to edge ${prev}`);
    near(distToLine(p, V[i], V[(i + 1) % 4]), r.halfs[i], `corner ${i} distance to edge ${i}`);
    assert.ok(inside(p, V), `corner ${i} must lie INSIDE the centerline polygon`);
    assert.ok(Math.hypot(p.x - V[i].x, p.y - V[i].y) < 2, `corner ${i} stays near its vertex`);
  });
  // the acute corner at b (56.3°): miter sits along the bisector, further than h
  // from the vertex but well within reason
  assert.ok(r.area > 0 && r.area < r.center);
});

test("near-collinear: a divideWall midpoint on a straight wall projects (no NaN / wild point)", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = level([["a",0,0],["b",10,0],["c",10,10],["d",0,10]], [["R",["a","b","c","d"]]], 0.5);
    const before = interiorArea(f, f.rooms[0]);
    const mid = divideWall(f, wallOf(f,"a","b"));
    const room = f.rooms[0];
    const i = room.loop.indexOf(mid);
    const same = roomInterior(f, room);
    // now give the two halves DIFFERENT thicknesses: a real step at the mid
    setWallThickness(f, wallOf(f,"a",mid), 0.5);
    setWallThickness(f, wallOf(f,mid,"b"), 1.0);
    const step = roomInterior(f, room);
    return { before, i, same, step, after: interiorArea(f, room) };
  `);
  assert.equal(r.same.kinds[r.i], "collinear");
  // equal thickness: one corner, exactly on the shared offset line
  nearPt(r.same.poly[r.i], { x: 5, y: 0.25 }, "pass-through corner");
  near(r.same.area, r.before, "area unchanged by inserting a collinear point");
  near(r.same.edges[r.i - 1].len + r.same.edges[r.i].len, 9.5, "the two halves' interior lengths add up");
  // unequal thickness: two projections — the true interior step
  assert.equal(r.step.kinds[r.i], "collinear");
  const all = r.step.poly.flatMap(p => [p.x, p.y]);
  assert.ok(all.every(Number.isFinite), "no NaN/Infinity anywhere");
  nearPt(r.step.edges[r.i - 1].b, { x: 5, y: 0.25 }, "first half ends on its own (0.25) face");
  nearPt(r.step.edges[r.i].a, { x: 5, y: 0.5 }, "second half starts on its own (0.5) face");
  near(r.step.edges[r.i - 1].len, 5 - 0.25, "first half interior length");
  near(r.step.edges[r.i].len, 5 - 0.25, "second half interior length");
  // area: 0.25..9.75 wide; depth 9.5 on the left half, 9.25 on the right
  near(r.after, 4.75 * 9.5 + 4.75 * 9.25, "stepped interior area");
});

test("near-collinear but not exact (snapInch kink on a diagonal) with unequal thickness falls back to a bevel near the vertex", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    // diagonal bottom edge; the inserted point is 0.03 ft off the a-b line (~0.34° kink)
    const f = level([["a",0,0],["m",5,1.03],["b",10,2],["c",10,12],["d",0,12]], [["R",["a","m","b","c","d"]]], 0.375);
    setWallThickness(f, wallOf(f,"a","m"), 0.375);
    setWallThickness(f, wallOf(f,"m","b"), 1.0);
    return { g: roomInterior(f, f.rooms[0]) };
  `);
  const k = r.g.kinds[1];
  assert.ok(k === "bevel" || k === "collinear", "kink vertex must not produce a raw miter: " + k);
  assert.ok(r.g.poly.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
  // both fallback points sit right next to the vertex (5,1.03)
  r.g.poly.filter(p => Math.abs(p.x - 5) < 1).forEach(p =>
    assert.ok(Math.hypot(p.x - 5, p.y - 1.03) <= 0.5 + 1e-9, `fallback point ${JSON.stringify(p)} near vertex`));
  // and the raw miter it replaced really would have been wild (feet away)
  const d0 = { x: 5 / Math.hypot(5, 1.03), y: 1.03 / Math.hypot(5, 1.03) };
  const d1 = { x: 5 / Math.hypot(5, 0.97), y: 0.97 / Math.hypot(5, 0.97) };
  const sin = Math.abs(d0.x * d1.y - d0.y * d1.x);
  assert.ok((0.5 - 0.1875) / sin > 10 * 0.5, "sanity: an unguarded intersection would land far away");
});

test("shared wall: each room gets its own interior length, computed from its own offset polygon", () => {
  const { run } = loadApp();
  // A (x 0..10) and B (x 10..20) share wall s1|s2 at x=10. B is wound the
  // OTHER way to make sure each side's inward normal comes from its own loop.
  const r = vmRun(run, `
    const f = level([["a1",0,0],["s1",10,0],["s2",10,10],["a4",0,10],["b2",20,0],["b3",20,10]],
      [["A",["a1","s1","s2","a4"]], ["B",["s1","s2","b3","b2"]]], 0.375);
    // A's top/bottom walls are thick (1 ft); B's stay at the 0.375 default
    setWallThickness(f, wallOf(f,"a1","s1"), 1.0);
    setWallThickness(f, wallOf(f,"s2","a4"), 1.0);
    const w = wallOf(f,"s1","s2");
    const sides = wallSides(f, w).map(s=>({room:s.room.id, edge:s.edge, side:s.side}));
    const others = f.walls.filter(x=>x!==w).map(x=>wallSides(f,x).length);
    return { wroom: w.room, sides, others, sA: roomInterior(f,f.rooms[0]).sign, sB: roomInterior(f,f.rooms[1]).sign };
  `);
  assert.equal(r.sA, 1); assert.equal(r.sB, -1);
  assert.equal(r.sides.length, 2, "both rooms found, not just w.room=" + r.wroom);
  assert.ok(r.others.every(n => n === 1), "every other wall is exterior (one side)");
  const A = r.sides.find(s => s.room === "A").side, B = r.sides.find(s => s.room === "B").side;
  const h = 0.375 / 2;
  near(A.len, 10 - 0.5 - 0.5, "A's interior length (thick top/bottom)");
  near(B.len, 10 - h - h, "B's interior length (default top/bottom)");
  nearPt(A.n, { x: -1, y: 0 }, "A's face looks toward A (x<10)");
  nearPt(B.n, { x: 1, y: 0 }, "B's face looks toward B (x>10)");
  near(A.a.x, 10 - h, "A's face x"); near(B.a.x, 10 + h, "B's face x");
  near(Math.min(A.a.y, A.b.y), 0.5, "A's face starts at A's thick top wall");
  near(Math.min(B.a.y, B.b.y), h, "B's face starts at B's own top wall");
});

test("render: a shared wall draws one dimension label per side with that side's interior length", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = level([["a1",0,0],["s1",10,0],["s2",10,10],["a4",0,10],["b2",20,0],["b3",20,10]],
      [["A",["a1","s1","s2","a4"]], ["B",["s1","s2","b3","b2"]]], 0.375);
    setWallThickness(f, wallOf(f,"a1","s1"), 1.0);
    setWallThickness(f, wallOf(f,"s2","a4"), 1.0);
    opts.dims = true; view.scale = 20; view.ox = 0; view.oy = 0;
    render();
    const texts = [], clips = [];
    (function walk(n){ (n.children||[]).forEach(c=>{
      if(c.tagName==="TEXT") texts.push(c.textContent);
      if(c.tagName==="CLIPPATH") clips.push(c.attributes.id);
      walk(c); }); })(svg);
    return { texts, clips, wallClip: f.walls.map(w=>w.id) };
  `);
  // A: 10 - 0.5 - 0.5 = 9'0"; B: 10 - 0.375 = 9.625 = 9'7.5" → 9'8"
  assert.ok(r.texts.includes(`9'0"`), "A's side of the shared wall: " + r.texts);
  assert.ok(r.texts.includes(`9'8"`), "B's side of the shared wall: " + r.texts);
  // 7 walls; 8 room-edges → 8 dimension labels in total
  const dims = r.texts.filter(t => /^\d+'\d+"$/.test(t));
  assert.equal(dims.length, 8);
  assert.equal(r.clips.length, 7, "every real-scale band gets a miter clip");
});

test("interior area < centerline area for positive thickness; equal when every wall is open; converges as t → 0", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = level([["p0",0,0],["p1",10,0],["p2",10,4],["p3",4,4],["p4",4,10],["p5",0,10]],
                    [["L",["p0","p1","p2","p3","p4","p5"]]], 0.375);
    const room = f.rooms[0];
    const out = { center: polyArea(f, room.loop), thick: interiorArea(f, room) };
    f.defaultThickness = 1e-6; out.tiny = interiorArea(f, room);
    f.defaultThickness = 0.375;
    f.walls.forEach(w=>setWallOpen(f, w, true));
    out.open = interiorArea(f, room);
    out.openKinds = roomInterior(f, room).kinds;
    return out;
  `);
  assert.ok(r.thick < r.center);
  near(r.open, r.center, "all walls open → interior == centerline");
  near(r.tiny, r.center, "t → 0 converges", 1e-4);
  assert.ok(r.openKinds.every(k => k === "miter" || k === "collinear"));
});

test("walls thicker than the room is wide: interior area clamps to 0 instead of going negative", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = level([["a",0,0],["b",1,0],["c",1,1],["d",0,1]], [["R",["a","b","c","d"]]], 3);
    return interiorArea(f, f.rooms[0]);
  `);
  assert.equal(r, 0);
});
