"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./harness");

test("loadData: does not mutate its input", () => {
  const { run } = loadApp();
  const raw = {
    schemaVersion: 1,
    activeLevelId: "lvl0",
    levels: [{ id: "lvl0", name: "Level 1", visible: true, points: [], walls: [], rooms: [] }],
  };
  // Construct + call + compare all inside one vm run, so "raw" here is the
  // actual same-realm object loadData receives - not a host-side object the
  // bridge already cloned away from loadData's reach.
  const { before, after } = run((raw) => {
    const before = JSON.stringify(raw);
    loadData(raw);
    const after = JSON.stringify(raw);
    return { before, after };
  }, raw);
  assert.equal(before, after, "loadData must not mutate the object it was given");
});

test("loadData: is pure - same input produces structurally equivalent output each time", () => {
  const { run } = loadApp();
  const raw = {
    schemaVersion: 1,
    activeLevelId: "lvl0",
    levels: [{ id: "lvl0", name: "Level 1", visible: true, points: [], walls: [], rooms: [] }],
  };
  const summarize = (raw) => {
    const d = loadData(raw);
    return { activeLevelId: d.activeLevelId, ids: d.levels.map(l => l.id), names: d.levels.map(l => l.name) };
  };
  const a = run(summarize, raw);
  const b = run(summarize, raw);
  assert.deepEqual(a, b);
});

test("loadData: migrates a legacy {main, basement} file (schemaVersion 0) to levels", () => {
  const { run } = loadApp();
  const legacy = {
    main: { points: [], walls: [], rooms: [] },
    basement: { points: [], walls: [], rooms: [] },
  };
  const result = run((raw) => {
    const d = loadData(raw);
    return { names: d.levels.map(l => l.name), visible: d.levels.map(l => l.visible), activeIsFirst: d.activeLevelId === d.levels[0].id };
  }, legacy);
  assert.deepEqual(result.names, ["Main", "Basement"]);
  assert.ok(result.visible.every(v => v === true));
  assert.ok(result.activeIsFirst, "Main should be active after migration");
});

test("loadData: rejects a file from a newer, unsupported schema version", () => {
  const { run } = loadApp();
  const threw = run(() => {
    try { loadData({ schemaVersion: 9999, levels: [] }); return false; }
    catch (e) { return true; }
  });
  assert.equal(threw, true);
});

test("loadData: rejects something that isn't a plan at all", () => {
  const { run } = loadApp();
  const results = run(() => {
    const tried = (v) => { try { loadData(v); return false; } catch (e) { return true; } };
    return [tried({ hello: "world" }), tried(null), tried("not an object")];
  });
  assert.deepEqual(results, [true, true, true]);
});

test("loadData: re-mints duplicate or missing level ids rather than colliding", () => {
  const { run } = loadApp();
  const raw = {
    schemaVersion: 1,
    activeLevelId: "dup",
    levels: [
      { id: "dup", name: "One", visible: true, points: [], walls: [], rooms: [] },
      { id: "dup", name: "Two", visible: true, points: [], walls: [], rooms: [] }, // duplicate id
      { name: "Three", visible: true, points: [], walls: [], rooms: [] },          // missing id entirely
    ],
  };
  const ids = run((raw) => loadData(raw).levels.map(l => l.id), raw);
  assert.equal(new Set(ids).size, ids.length, "every level must end up with a unique id");
});

test("loadData: an empty levels array still produces one usable blank level", () => {
  const { run } = loadApp();
  const count = run(() => loadData({ schemaVersion: 1, levels: [] }).levels.length);
  assert.equal(count, 1);
});

test("stripIdx -> loadData round trip preserves level names and point/room data", () => {
  const { run } = loadApp();
  const result = run(() => {
    const f = activeLevel();
    const roomsBefore = f.rooms.length;
    commit(() => {
      const a = { id: "pt" + (_pid++), x: 0, y: 0 };
      const b = { id: "pt" + (_pid++), x: 10, y: 0 };
      const c = { id: "pt" + (_pid++), x: 10, y: 10 };
      const d = { id: "pt" + (_pid++), x: 0, y: 10 };
      f.points.push(a, b, c, d);
      f.rooms.push({ id: "room" + (_pid++), name: "Test Room", kind: "room", loop: [a.id, b.id, c.id, d.id] });
      f._pt = new Map(f.points.map(p => [p.id, p]));
      deriveWalls(f);
    });
    const saved = stripIdx(data);
    const reloaded = loadData(JSON.parse(JSON.stringify(saved)));
    const reloadedLevel = reloaded.levels.find(l => l.id === reloaded.activeLevelId);
    return { roomsBefore, roomsAfter: reloadedLevel.rooms.length, hasTestRoom: reloadedLevel.rooms.some(r => r.name === "Test Room") };
  });
  assert.equal(result.roomsAfter, result.roomsBefore + 1);
  assert.ok(result.hasTestRoom);
});
