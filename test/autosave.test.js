"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./harness");

/* js/storage.js (ARCHITECTURE.md item 6). `ctx.localStorage` (test/
   dom-stub.js's in-memory stub) is the same object the app code inside the
   vm reads/writes, so tests read it back directly rather than through the
   run() bridge — it's a plain host-realm Map-backed object, nothing to
   JSON-round-trip. flushAutosave() (js/storage.js) lets tests force the
   pending debounced write synchronously instead of sleeping for the real
   1.5s delay. */

test("fresh app (no prior blueprints:* keys): starts with freshData()-equivalent content and creates an index entry + current-id pointer", () => {
  const { ctx, run } = loadApp();

  const currentId = ctx.localStorage.getItem("blueprints:currentProjectId");
  assert.ok(currentId, "a currentProjectId should be minted and stored");

  const idx = JSON.parse(ctx.localStorage.getItem("blueprints:projects"));
  assert.equal(idx.length, 1);
  assert.equal(idx[0].id, currentId);
  assert.equal(idx[0].name, "Untitled Plan");
  assert.equal(typeof idx[0].updatedAt, "number");

  // No project blob yet — that's only written once an autosave actually runs.
  assert.equal(ctx.localStorage.getItem("blueprints:project:" + currentId), null);

  const info = run(() => ({ levelNames: data.levels.map(l => l.name), id: getCurrentProjectId() }));
  assert.deepEqual(info.levelNames, ["Level 1"]);
  assert.equal(info.id, currentId);
});

test("AUTOSAVE_DEBOUNCE_MS is exposed as a real, referenceable constant", () => {
  const { run } = loadApp();
  assert.equal(run(() => AUTOSAVE_DEBOUNCE_MS), 1500);
});

test("autosave: a commit()-driven mutation writes nothing until the debounce elapses, then updates the blob + bumps the index's updatedAt", () => {
  const { ctx, run } = loadApp();
  const id = ctx.localStorage.getItem("blueprints:currentProjectId");
  const updatedAtBefore = JSON.parse(ctx.localStorage.getItem("blueprints:projects"))[0].updatedAt;

  run(() => { addLevel(); });   // a commit()-driven mutation
  assert.equal(ctx.localStorage.getItem("blueprints:project:" + id), null,
    "must not write before the debounce elapses");

  run(() => { flushAutosave(); });
  const blob = JSON.parse(ctx.localStorage.getItem("blueprints:project:" + id));
  assert.equal(blob.levels.length, 2);
  assert.equal(blob.name, "Untitled Plan");

  const idxEntry = JSON.parse(ctx.localStorage.getItem("blueprints:projects"))[0];
  assert.ok(idxEntry.updatedAt >= updatedAtBefore);
});

test("autosave: rapid-fire changes collapse into exactly one debounced write, not one per change", () => {
  const { ctx, run } = loadApp();
  let projectWrites = 0;
  const realSetItem = ctx.localStorage.setItem.bind(ctx.localStorage);
  ctx.localStorage.setItem = (k, v) => {
    if (k.startsWith("blueprints:project:")) projectWrites++;
    realSetItem(k, v);
  };

  run(() => { addLevel(); addLevel(); addLevel(); });   // three separate commits
  run(() => { flushAutosave(); });

  assert.equal(projectWrites, 1, "three rapid commits should collapse into a single blob write");
});

test("autosave: renaming the project (setProjectName) triggers an eventual autosave, even though it bypasses commit()/markDirty()", () => {
  const { ctx, run } = loadApp();
  const id = ctx.localStorage.getItem("blueprints:currentProjectId");

  run(() => { setProjectName("My House"); });
  assert.equal(ctx.localStorage.getItem("blueprints:project:" + id), null,
    "must not write before the debounce elapses");

  run(() => { flushAutosave(); });
  const blob = JSON.parse(ctx.localStorage.getItem("blueprints:project:" + id));
  assert.equal(blob.name, "My House");
  const idxEntry = JSON.parse(ctx.localStorage.getItem("blueprints:projects"))[0];
  assert.equal(idxEntry.name, "My House");
});

test("autosave: Reset (which replaces `data` the same way opening a file does) still flows through markDirty() and autosaves", () => {
  const { ctx, run } = loadApp();
  const id = ctx.localStorage.getItem("blueprints:currentProjectId");
  run(() => { addLevel(); });
  run(() => { document.getElementById("btnReset").onclick(); });
  run(() => { flushAutosave(); });
  const blob = JSON.parse(ctx.localStorage.getItem("blueprints:project:" + id));
  assert.equal(blob.levels.length, 1, "reset plan should be a single blank level, and it should have been autosaved");
});

test("reload: resumes the same project, including its data and active level", () => {
  const first = loadApp();
  const id = first.ctx.localStorage.getItem("blueprints:currentProjectId");

  const picked = first.run(() => {
    addLevel();
    const secondLevelId = data.levels[1].id;
    setLevel(secondLevelId);
    setProjectName("Resumed House");
    return { secondLevelId };
  });
  first.run(() => { flushAutosave(); });

  const seed = {
    "blueprints:currentProjectId": first.ctx.localStorage.getItem("blueprints:currentProjectId"),
    "blueprints:projects": first.ctx.localStorage.getItem("blueprints:projects"),
    ["blueprints:project:" + id]: first.ctx.localStorage.getItem("blueprints:project:" + id),
  };

  const second = loadApp({ localStorageSeed: seed });
  const info = second.run(() => ({
    levelCount: data.levels.length,
    activeLevelId: data.activeLevelId,
    name: projectName,
    id: getCurrentProjectId(),
  }));
  assert.equal(info.levelCount, 2);
  assert.equal(info.activeLevelId, picked.secondLevelId);
  assert.equal(info.name, "Resumed House");
  assert.equal(info.id, id);
});

test("startup: a currentProjectId pointing at nothing in the index falls back to a fresh project, without throwing", () => {
  assert.doesNotThrow(() => {
    const { run } = loadApp({ localStorageSeed: { "blueprints:currentProjectId": "doesnotexist" } });
    const count = run(() => data.levels.length);
    assert.equal(count, 1);
  });
});

test("startup: an id listed in the index but with no project blob falls back to fresh, without throwing", () => {
  const seed = {
    "blueprints:currentProjectId": "projGhost",
    "blueprints:projects": JSON.stringify([{ id: "projGhost", name: "Ghost", updatedAt: 1 }]),
  };
  assert.doesNotThrow(() => {
    const { run } = loadApp({ localStorageSeed: seed });
    const info = run(() => ({ count: data.levels.length, id: getCurrentProjectId() }));
    assert.equal(info.count, 1);
    assert.notEqual(info.id, "projGhost");
  });
});

test("startup: a corrupt (unparsable) project blob falls back to fresh, without throwing", () => {
  const seed = {
    "blueprints:currentProjectId": "projBad",
    "blueprints:projects": JSON.stringify([{ id: "projBad", name: "Bad", updatedAt: 1 }]),
    "blueprints:project:projBad": "{ not valid json",
  };
  assert.doesNotThrow(() => {
    const { run } = loadApp({ localStorageSeed: seed });
    const info = run(() => ({ count: data.levels.length, id: getCurrentProjectId() }));
    assert.equal(info.count, 1);
    assert.notEqual(info.id, "projBad");
  });
});

test("startup: a corrupt blueprints:projects index (not an array) falls back to fresh, without throwing", () => {
  const seed = { "blueprints:projects": "not json at all", "blueprints:currentProjectId": "whatever" };
  assert.doesNotThrow(() => {
    const { run } = loadApp({ localStorageSeed: seed });
    const count = run(() => data.levels.length);
    assert.equal(count, 1);
  });
});

test("autosave: a localStorage.setItem that throws does not crash the app — the in-memory mutation still succeeds", () => {
  const { ctx, run } = loadApp();
  ctx.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };

  assert.doesNotThrow(() => {
    run(() => { addLevel(); });
    run(() => { flushAutosave(); });
  });
  const count = run(() => data.levels.length);
  assert.equal(count, 2, "the mutation itself must still have applied in memory");
});

test("startup: an older-schema autosaved blob is migrated transparently on load, same as opening an old file", () => {
  const v1Blob = {
    name: "Old Schema Plan",
    schemaVersion: 1,
    activeLevelId: "lvl0",
    levels: [{ id: "lvl0", name: "Level 1", visible: true, points: [], walls: [], rooms: [] }],
  };
  const seed = {
    "blueprints:currentProjectId": "projOld",
    "blueprints:projects": JSON.stringify([{ id: "projOld", name: "Old Schema Plan", updatedAt: 1 }]),
    "blueprints:project:projOld": JSON.stringify(v1Blob),
  };
  const { run } = loadApp({ localStorageSeed: seed });
  const info = run(() => ({
    name: projectName,
    id: getCurrentProjectId(),
    hasWallProps: data.levels.every(l => l.wallProps && typeof l.wallProps === "object"),
    hasDefaultThickness: data.levels.every(l => typeof l.defaultThickness === "number"),
  }));
  assert.equal(info.id, "projOld");
  assert.equal(info.name, "Old Schema Plan");
  assert.ok(info.hasWallProps, "v1 -> v2 migration should have added wallProps to every level");
  assert.ok(info.hasDefaultThickness, "v1 -> v2 migration should have added defaultThickness to every level");
});
