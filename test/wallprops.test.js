"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./harness");

/* Wall thickness data model (ARCHITECTURE.md item 3): wallKey, wallProps,
   effThickness, the `open` flag, remapWallRefs through every topology op,
   orphan pruning, and the v1 -> v2 schema migration. */

const T24 = 4.5 / 12;   // 2x4 + drywall, ft
const T26 = 6.5 / 12;   // 2x6 + drywall, ft

/* Inside the vm: a level with two UNCONNECTED 10x10 rooms side by side,
   A = a1..a4 at x 0..10 and B = b1..b4 at x 10..20 (B's left edge coincides
   with A's right edge but uses its own point ids). Installed as the active
   level so inspector-level functions (deletePoint) see it too. Source string
   so each run() can rebuild it without sharing host closures. */
const SETUP = `
  function setupTwoRooms(){
    const f = makeLevel("T", []);
    const P = (id,x,y)=>({id,x,y});
    f.points = [P("a1",0,0),P("a2",10,0),P("a3",10,10),P("a4",0,10),
                P("b1",10,0),P("b2",20,0),P("b3",20,10),P("b4",10,10)];
    f.rooms = [{id:"rA",name:"A",kind:"room",loop:["a1","a2","a3","a4"]},
               {id:"rB",name:"B",kind:"room",loop:["b1","b2","b3","b4"]}];
    indexLevel(f);
    data.levels=[f]; data.activeLevelId=f.id;
    return f;
  }
`;
/* run() only needs fn.toString(), so hand it the source of an arrow function
   whose body is SETUP + the test body (one JSON `args` argument). */
function vmRun(run, body, args) {
  const fn = `(args)=>{ ${SETUP} ${body} }`;
  return run({ toString: () => fn }, args === undefined ? null : args);
}

test("wallKey / deriveWalls: wall ids and wallProps keys are derivable from each other", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    return f.walls.map(w => ({
      idMatches: w.id === wallIdForKey(wallKey(w.a, w.b)),
      reversed: wallKey(w.b, w.a) === wallKeyOf(w),
      back: wallKeyFromId(w.id) === wallKeyOf(w),
    }));
  `);
  assert.equal(r.length, 8);
  assert.ok(r.every(x => x.idMatches && x.reversed && x.back));
});

test("effThickness: unset -> level default, override -> that value, open -> 0 even with a stored thickness", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    const w = f.walls.find(w => wallKeyOf(w) === wallKey("a2","a3"));
    const out = { fresh: f.defaultThickness, unset: effThickness(f, w) };
    setWallThickness(f, w, ${T26});
    out.override = effThickness(f, w);
    f.defaultThickness = 1;
    out.overrideIgnoresDefault = effThickness(f, w);
    // hand-written data that violates the invariant must still read as 0
    f.wallProps[wallKeyOf(w)] = { open: true, thickness: 0.5 };
    out.openWithStored = effThickness(f, w);
    // setWallOpen drops any stored thickness; overrides are refused while open
    setWallOpen(f, w, true);
    out.openProps = { ...f.wallProps[wallKeyOf(w)] };
    out.refused = setWallThickness(f, w, 0.4);
    setWallOpen(f, w, false);
    out.afterUnopen = effThickness(f, w);
    out.tidied = !(wallKeyOf(w) in f.wallProps);
    return out;
  `);
  assert.equal(r.fresh, T24, "a fresh level defaults to 2x4 + drywall");
  assert.equal(r.unset, T24);
  assert.equal(r.override, T26);
  assert.equal(r.overrideIgnoresDefault, T26);
  assert.equal(r.openWithStored, 0);
  assert.deepEqual(r.openProps, { open: true });
  assert.equal(r.refused, false);
  assert.equal(r.afterUnopen, 1, "un-flagging open returns the wall to the level default");
  assert.ok(r.tidied, "an entry left empty is removed");
});

test("divideWall: an override is copied to both halves, and to no other wall", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    const w = wallById(f, wallIdForKey(wallKey("a2","a3")));
    setWallThickness(f, w, ${T26});
    const mid = divideWall(f, w);
    return { mid, props: f.wallProps,
      thick: f.walls.map(w => [wallKeyOf(w), effThickness(f, w)]) };
  `);
  const k1 = [r.mid, "a2"].sort().join("|"), k2 = [r.mid, "a3"].sort().join("|");
  assert.deepEqual(Object.keys(r.props).sort(), [k1, k2].sort(), "old key gone, both halves present");
  for (const [k, t] of r.thick) assert.equal(t, (k === k1 || k === k2) ? T26 : T24, "wall " + k);
});

test("insertPointOnWall: same split rule as divideWall; open is copied too", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    setWallOpen(f, wallById(f, wallIdForKey(wallKey("a1","a2"))), true);
    const mid = insertPointOnWall(f, "a1", "a2", 4, 0);
    return { mid, props: f.wallProps };
  `);
  assert.deepEqual(r.props, {
    [["a1", r.mid].sort().join("|")]: { open: true },
    [["a2", r.mid].sort().join("|")]: { open: true },
  });
});

test("weldPoints: a renamed wall carries its props; merging into an existing wall keeps the existing wall's thickness", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    const byKey = (a,b) => wallById(f, wallIdForKey(wallKey(a,b)));
    setWallThickness(f, byKey("a2","a3"), ${T26});   // A's right wall
    setWallThickness(f, byKey("b1","b2"), 0.5);      // B's top wall
    setWallThickness(f, byKey("b4","b1"), 0.25);     // B's left wall (will merge onto A's right)
    weldPoints(f, "b1", "a2");
    const afterFirst = JSON.parse(JSON.stringify(f.wallProps));
    weldPoints(f, "b4", "a3");
    return { afterFirst, props: f.wallProps, walls: f.walls.length };
  `);
  // after weld b1 -> a2: b1|b2 renamed to a2|b2, b4|b1 renamed to a2|b4
  assert.deepEqual(r.afterFirst, {
    "a2|a3": { thickness: 6.5 / 12 },
    "a2|b2": { thickness: 0.5 },
    "a2|b4": { thickness: 0.25 },
  });
  // after weld b4 -> a3: B's left wall lands on A's right wall (a2|a3), which
  // already existed -> it is "the first wall" and its thickness wins
  assert.equal(r.walls, 7, "two rooms sharing one wall");
  assert.deepEqual(r.props, { "a2|a3": { thickness: 6.5 / 12 }, "a2|b2": { thickness: 0.5 } });
});

test("weldPoints: a merged wall is open only if both inputs were", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const results = [];
    for (const [openA, openB] of [[true,true],[true,false],[false,true]]) {
      const f = setupTwoRooms();
      const byKey = (a,b) => wallById(f, wallIdForKey(wallKey(a,b)));
      if (openA) setWallOpen(f, byKey("a2","a3"), true);
      if (openB) setWallOpen(f, byKey("b4","b1"), true);
      weldPoints(f, "b1", "a2"); weldPoints(f, "b4", "a3");
      results.push(f.wallProps["a2|a3"] || null);
    }
    return results;
  `);
  assert.deepEqual(r, [{ open: true }, null, null]);
});

test("weldPoints: collapsing a wall to zero length drops its props", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    // give A a fifth corner so it survives losing one
    f.points.push({id:"a5", x:5, y:0}); f._pt.set("a5", f.points[f.points.length-1]);
    f.rooms[0].loop = ["a1","a5","a2","a3","a4"]; deriveWalls(f);
    setWallThickness(f, wallById(f, wallIdForKey(wallKey("a5","a2"))), 0.5);
    weldPoints(f, "a5", "a2");
    return { props: f.wallProps, loop: f.rooms[0].loop };
  `);
  assert.deepEqual(r.loop, ["a1", "a2", "a3", "a4"]);
  assert.deepEqual(r.props, {}, "the zero-length wall's props must not land on a neighbouring wall");
});

test("detachRoom: a shared wall's override ends up on both resulting walls", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    weldPoints(f, "b1", "a2"); weldPoints(f, "b4", "a3");           // share A's right wall
    setWallThickness(f, wallById(f, wallIdForKey("a2|a3")), ${T26});
    setWallThickness(f, wallById(f, wallIdForKey("a1|a2")), 0.5);    // A-only wall
    detachRoom(f, f.rooms[1]);                                        // B gets private corners
    const bLoop = f.rooms[1].loop;
    return { props: f.wallProps, bLoop,
      bThick: loopWallKeys(bLoop).map(k => effThickness(f, {a:k.split("|")[0], b:k.split("|")[1]})) };
  `);
  assert.equal(r.props["a2|a3"].thickness, T26, "A keeps its side");
  const bSide = Object.keys(r.props).filter(k => k !== "a2|a3" && k !== "a1|a2");
  assert.equal(bSide.length, 1, "exactly one new key: B's copy of the shared wall");
  assert.equal(r.props[bSide[0]].thickness, T26);
  assert.ok(bSide[0].split("|").every(id => r.bLoop.includes(id)));
  assert.equal(r.props["a1|a2"].thickness, 0.5, "A's unshared wall untouched");
  assert.deepEqual(r.bThick.slice().sort(), [T24, T24, T24, T26].sort());
});

test("detachCorner: walls at the split corner keep their props on every side", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    weldPoints(f, "b1", "a2"); weldPoints(f, "b4", "a3");
    setWallThickness(f, wallById(f, wallIdForKey("a2|a3")), ${T26});
    setWallThickness(f, wallById(f, wallIdForKey("a2|b2")), 0.5);
    detachCorner(f, "a2");
    return { props: f.wallProps, live: f.walls.map(wallKeyOf) };
  `);
  // every stored key is a real wall, and the thicknesses still exist
  for (const k of Object.keys(r.props)) assert.ok(r.live.includes(k), "no orphan " + k);
  const vals = Object.values(r.props).map(p => p.thickness).sort();
  assert.deepEqual(vals, [0.5, T26, T26].sort(), "shared wall now two walls (both 2x6), B's top wall still 0.5");
});

test("deletePoint: removing a corner merges its two walls' props onto the joined wall", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    f.points.push({id:"a5", x:5, y:0}); f._pt.set("a5", f.points[f.points.length-1]);
    f.rooms[0].loop = ["a1","a5","a2","a3","a4"]; deriveWalls(f);
    setWallThickness(f, wallById(f, wallIdForKey(wallKey("a5","a2"))), 0.5);
    deletePoint(f, "a5");
    return f.wallProps;
  `);
  assert.deepEqual(r, { "a1|a2": { thickness: 0.5 } });
});

test("orphan prune: props of a wall that disappears are removed, not accumulated", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    setWallThickness(f, wallById(f, wallIdForKey("b1|b2")), 0.5);
    setWallThickness(f, wallById(f, wallIdForKey("a1|a2")), 0.25);
    f.wallProps["zz|zzz"] = { thickness: 0.3 };       // garbage that was never a wall
    f.rooms = f.rooms.filter(r => r.id !== "rB");     // delete room B (same as the inspector's Delete room)
    gcPoints(f); deriveWalls(f);
    return f.wallProps;
  `);
  assert.deepEqual(r, { "a1|a2": { thickness: 0.25 } });
});

test("cutRoom: a fully consumed room's props are pruned; untouched walls keep theirs", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    // C covers B entirely
    const P=(id,x,y)=>{ const p={id,x,y}; f.points.push(p); return id; };
    f.rooms.push({id:"rC",name:"C",kind:"room",loop:[P("c1",9.5,-1),P("c2",21,-1),P("c3",21,11),P("c4",9.5,11)]});
    f._pt=new Map(f.points.map(p=>[p.id,p])); deriveWalls(f);
    setWallThickness(f, wallById(f, wallIdForKey("b1|b2")), 0.5);
    setWallThickness(f, wallById(f, wallIdForKey("a1|a4")), 0.25);   // A's left wall, outside the cut
    // the vendored UMD bundle attaches itself to globalThis; in a browser
    // that IS window, but the harness's stub window is a separate object
    window.polygonClipping = window.polygonClipping || globalThis.polygonClipping;
    const res = cutRoom(f, f.rooms.find(r=>r.id==="rC"));
    return { res, props: f.wallProps, rooms: f.rooms.map(r=>r.id) };
  `);
  assert.equal(r.res.err, false, "polygon-clipping should be available in the harness");
  assert.ok(!r.rooms.includes("rB"));
  assert.deepEqual(r.props, { "a1|a4": { thickness: 0.25 } });
});

test("parseThickness: bare numbers are inches, explicit units honoured, nonsense rejected", () => {
  const { run } = loadApp();
  const r = run(() => ["5", "5.5", '6.5"', "0' 4.5\"", "0.5'", "abc", "0", "-3", "100"].map(s => parseThickness(s)));
  assert.equal(r[0], 5 / 12);
  assert.equal(r[1], 5.5 / 12);
  assert.equal(r[2], 6.5 / 12);
  assert.equal(r[3], 4.5 / 12);
  assert.equal(r[4], 0.5);
  for (const v of r.slice(5)) assert.equal(v, null, "JSON-round-tripped NaN"); // NaN -> null via JSON
});

test("presets use real 2x4 / 2x6 + 1/2\" drywall dimensions, in feet", () => {
  const { run } = loadApp();
  const r = run(() => ({ presets: WALL_PRESETS.map(p => [p.id, p.thickness]), def: DEFAULT_WALL_THICKNESS }));
  assert.deepEqual(r.presets, [["2x4", T24], ["2x6", T26]]);
  assert.equal(r.def, T24);
});

test("migration: a v1 file loads with wallProps {} and a valid defaultThickness on every level", () => {
  const { run } = loadApp();
  const v1 = {
    schemaVersion: 1, activeLevelId: "lvl0",
    levels: [
      { id: "lvl0", name: "One", visible: true, points: [], walls: [], rooms: [] },
      { id: "lvl1", name: "Two", visible: true, points: [], walls: [], rooms: [] },
    ],
  };
  const r = run((raw) => {
    const m = migrateData(raw);
    const d = loadData(raw);
    return { version: m.schemaVersion, migrated: m.levels.map(l => [l.wallProps, l.defaultThickness]),
      loaded: d.levels.map(l => [l.wallProps, l.defaultThickness]), current: CURRENT_SCHEMA_VERSION };
  }, v1);
  assert.equal(r.current, 2);
  assert.equal(r.version, 2);
  assert.deepEqual(r.migrated, [[{}, T24], [{}, T24]]);
  assert.deepEqual(r.loaded, [[{}, T24], [{}, T24]]);
});

test("migration: a legacy v0 {main, basement} file also ends up with thickness fields", () => {
  const { run } = loadApp();
  const r = run(() => loadData({ main: { points: [], walls: [], rooms: [] }, basement: { points: [], walls: [], rooms: [] } })
    .levels.map(l => [l.wallProps, l.defaultThickness]));
  assert.deepEqual(r, [[{}, T24], [{}, T24]]);
});

test("save/load round trip keeps overrides, open flags and the level default; loadData sanitizes bad entries", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    setWallThickness(f, wallById(f, wallIdForKey("a1|a2")), 0.5);
    setWallOpen(f, wallById(f, wallIdForKey("a2|a3")), true);
    setDefaultThickness(f, ${T26});
    const saved = JSON.parse(JSON.stringify(stripIdx(data)));
    const lvl = saved.levels[0];
    lvl.wallProps["b1|b2"] = { open: true, thickness: 0.4 };   // invariant violation -> thickness dropped
    lvl.wallProps["b2|b3"] = { thickness: -1 };                 // invalid -> entry dropped
    lvl.wallProps["nope|zz"] = { thickness: 0.4 };              // not a wall -> pruned
    lvl.wallProps["b3|b4"] = "junk";                            // not an object -> dropped
    const d = loadData(saved);
    return { savedVersion: saved.schemaVersion, props: d.levels[0].wallProps, def: d.levels[0].defaultThickness };
  `);
  assert.equal(r.savedVersion, 2);
  assert.equal(r.def, T26);
  assert.deepEqual(r.props, { "a1|a2": { thickness: 0.5 }, "a2|a3": { open: true }, "b1|b2": { open: true } });
});

test("loadData: a missing or invalid defaultThickness falls back to the baseline", () => {
  const { run } = loadApp();
  const r = run(() => loadData({ schemaVersion: 2, levels: [
    { id: "lvl0", name: "A", points: [], walls: [], rooms: [] },
    { id: "lvl1", name: "B", points: [], walls: [], rooms: [], defaultThickness: "wide", wallProps: [1, 2] },
  ] }).levels.map(l => [l.wallProps, l.defaultThickness]));
  assert.deepEqual(r, [[{}, T24], [{}, T24]]);
});

test("UI: wall inspector picker and open toggle mutate through commit() (undoable)", () => {
  const { run } = loadApp();
  vmRun(run, `
    const f = setupTwoRooms();
    sel = { type: "wall", id: wallIdForKey("a1|a2") };
    history.length = 0;
    renderInspector();
  `);
  run(() => { const s = document.getElementById("thkSel"); s.value = "2x6"; s.onchange(); });
  let s = run(() => ({ h: history.length, p: activeLevel().wallProps }));
  assert.equal(s.h, 1);
  assert.deepEqual(s.p, { "a1|a2": { thickness: 6.5 / 12 } });

  run(() => { const c = document.getElementById("wallOpen"); c.checked = true; c.onchange({ target: c }); });
  s = run(() => ({ h: history.length, p: activeLevel().wallProps }));
  assert.equal(s.h, 2);
  assert.deepEqual(s.p, { "a1|a2": { open: true } });

  // custom value: picking "Custom…" alone commits nothing; Set does
  run(() => { const s = document.getElementById("thkSel"); s.value = "custom"; });
  run(() => { const c = document.getElementById("wallOpen"); c.checked = false; c.onchange({ target: c }); });
  run(() => {
    const s = document.getElementById("thkSel"); s.value = "custom"; s.onchange();
    document.getElementById("thkCustom").value = "8"; document.getElementById("thkApply").onclick();
  });
  s = run(() => ({ h: history.length, p: activeLevel().wallProps }));
  assert.equal(s.h, 4);
  assert.deepEqual(s.p, { "a1|a2": { thickness: 8 / 12 } });

  run(() => { undo(); undo(); });
  assert.deepEqual(run(() => activeLevel().wallProps), { "a1|a2": { open: true } });
});

test("UI: level default control commits through commit() and is undoable", () => {
  const { run } = loadApp();
  const before = run(() => ({ h: history.length, t: activeLevel().defaultThickness }));
  run(() => { const s = document.getElementById("defThkSel"); s.value = "2x6"; s.onchange(); });
  const after = run(() => ({ h: history.length, t: activeLevel().defaultThickness }));
  assert.equal(before.t, T24);
  assert.equal(after.t, T26);
  assert.equal(after.h, before.h + 1);
  run(() => undo());
  assert.equal(run(() => activeLevel().defaultThickness), T24);
});

test("render: wall stroke width follows effThickness; open walls get a dashed line + hit target", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupTwoRooms();
    setWallThickness(f, wallById(f, wallIdForKey("a1|a2")), 1);
    setWallOpen(f, wallById(f, wallIdForKey("a2|a3")), true);
    render();
    const found = {};
    (function walk(n){ if(n.dataset && n.dataset.wall) found[n.dataset.wall] = n.attributes;
      (n.children||[]).forEach(walk); })(svg);
    return { scale: view.scale, a12: found["w_a1|a2"], a23: found["w_a2|a3"], a14: found["w_a1|a4"] };
  `);
  assert.equal(+r.a12["stroke-width"], 1 * r.scale);
  assert.equal(+r.a14["stroke-width"], Math.max(2.6, T24 * r.scale));
  assert.equal(r.a23.stroke, "transparent", "open wall's selectable element is the invisible hit target");
});
