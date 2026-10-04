"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./harness");

/* Builds the {points, rooms, _pt} shape connectedRoomPoints expects, inside
   the vm (see harness.js's `run` doc comment for why this has to happen
   inside, not be constructed on the host and passed in as a finished
   object with a Map on it - Maps aren't JSON-safe). */
function connectedRoomPointsOn(run, rooms, startRoomId) {
  return run((rooms, startRoomId) => {
    const pts = new Map();
    rooms.forEach(r => r.loop.forEach(id => { if (!pts.has(id)) pts.set(id, { id, x: 0, y: 0 }); }));
    const f = { points: [...pts.values()], rooms };
    f._pt = new Map(f.points.map(p => [p.id, p]));
    return connectedRoomPoints(f, startRoomId);
  }, rooms, startRoomId);
}

test("connectedRoomPoints: a chain of 3 welded rooms all move together", () => {
  const { run } = loadApp();
  // A: p1-p2-p3-p4, B: p3-p4-p5-p6 (shares p3,p4 with A), C: p5-p6-p7-p8 (shares p5,p6 with B)
  const r = connectedRoomPointsOn(run, [
    { id: "A", loop: ["p1", "p2", "p3", "p4"] },
    { id: "B", loop: ["p3", "p4", "p5", "p6"] },
    { id: "C", loop: ["p5", "p6", "p7", "p8"] },
  ], "A");
  assert.deepEqual([...r.roomIds].sort(), ["A", "B", "C"]);
  assert.equal(r.ids.length, 8, "all 8 distinct points across the chain should move");
  assert.equal(r.pinnedIds.length, 0);
});

test("connectedRoomPoints: a locked room blocks propagation and pins its shared corners", () => {
  const { run } = loadApp();
  const r = connectedRoomPointsOn(run, [
    { id: "A", loop: ["p1", "p2", "p3", "p4"] },
    { id: "B", loop: ["p3", "p4", "p5", "p6"], locked: true },
    { id: "C", loop: ["p5", "p6", "p7", "p8"] },
  ], "A");
  assert.deepEqual(r.roomIds, ["A"], "the cluster must not cross the locked room into C");
  assert.deepEqual([...r.ids].sort(), ["p1", "p2"], "only A's unshared corners move");
  assert.deepEqual([...r.pinnedIds].sort(), ["p3", "p4"], "the corners A shares with locked B stay pinned");
});

test("connectedRoomPoints: dragging a locked room itself yields nothing to move", () => {
  const { run } = loadApp();
  const r = run(() => {
    const f = { points: [], rooms: [
      { id: "A", loop: ["p1", "p2", "p3", "p4"] },
      { id: "B", loop: ["p3", "p4", "p5", "p6"], locked: true },
    ] };
    ["p1","p2","p3","p4","p5","p6"].forEach(id => f.points.push({ id, x: 0, y: 0 }));
    f._pt = new Map(f.points.map(p => [p.id, p]));
    return connectedRoomPoints(f, "B");
  });
  assert.equal(r.ids.length, 0);
  assert.equal(r.roomIds.length, 0);
});

test("connectedRoomPoints: rooms touching at a single corner are still connected", () => {
  const { run } = loadApp();
  const r = connectedRoomPointsOn(run, [
    { id: "A", loop: ["p1", "p2", "p3"] },
    { id: "B", loop: ["p3", "p4", "p5"] }, // shares only p3
  ], "A");
  assert.deepEqual([...r.roomIds].sort(), ["A", "B"]);
});

test("connectedRoomPoints: an unrelated room is not pulled in", () => {
  const { run } = loadApp();
  const r = connectedRoomPointsOn(run, [
    { id: "A", loop: ["p1", "p2", "p3", "p4"] },
    { id: "Z", loop: ["p9", "p10", "p11", "p12"] }, // shares nothing with A
  ], "A");
  assert.deepEqual(r.roomIds, ["A"]);
});

test("loopSelfIntersects: a plain quad does not self-intersect", () => {
  const { run } = loadApp();
  const quad = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.equal(run((vs) => loopSelfIntersects(vs), quad), false);
});

test("loopSelfIntersects: an L-shape does not self-intersect", () => {
  const { run } = loadApp();
  const L = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 10 }, { x: 0, y: 10 }];
  assert.equal(run((vs) => loopSelfIntersects(vs), L), false);
});

test("loopSelfIntersects: a bowtie self-intersects", () => {
  const { run } = loadApp();
  const bowtie = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
  assert.equal(run((vs) => loopSelfIntersects(vs), bowtie), true);
});

test("loopSelfIntersects: a vertex touching a non-adjacent edge is rejected", () => {
  const { run } = loadApp();
  const folded = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 0 }, { x: 0, y: 10 }];
  assert.equal(run((vs) => loopSelfIntersects(vs), folded), true);
});

test("signedAreaXY: matches the winding addRoom()/buildLevel() already produce", () => {
  const { run } = loadApp();
  // top-left -> top-right -> bottom-right -> bottom-left, y-down world coords
  const rect = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }];
  assert.equal(run((vs) => signedAreaXY(vs), rect), 50);
  assert.equal(run((vs) => signedAreaXY(vs), [...rect].reverse()), -50);
});

test("esc(): escapes the characters that matter for innerHTML interpolation", () => {
  const { run } = loadApp();
  assert.equal(run((s) => esc(s), "<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.equal(run((s) => esc(s), `Tom & Jerry's "show"`), "Tom &amp; Jerry&#39;s &quot;show&quot;");
});

test("syncIds: bumps counters past every id in the file, including nested/future collections", () => {
  const { run } = loadApp();
  const level = {
    id: "lvl0",
    points: [{ id: "p100", x: 0, y: 0 }],
    rooms: [{ id: "r3", loop: ["p100"] }],
    objects: [{ id: "obj250" }],                                   // not a real field yet - generic scan must still find it
    wallProps: { "p0|p100": { openings: [{ id: "op77" }] } },      // nested two levels deep
  };
  const pidAfter = run((level) => {
    _pid = 0; _lid = 0;
    syncIds({ levels: [level] });
    return _pid;
  }, level);
  assert.equal(pidAfter, 251, "must be past the highest id found anywhere under the level (250), not just points/rooms");
});
