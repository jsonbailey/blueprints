"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./harness");

/* startRenameRoom (js/inspector.js) is the shared in-place-rename function
   behind both the Inspector panel's room-name display and the on-canvas
   overlay js/render.js builds (startRoomNameOverlay) - exercising it
   directly here covers the commit/undo semantics common to both without
   needing real browser focus/blur plumbing (see CONTRIBUTING.md on what
   this suite can't catch - the stub DOM's .blur() doesn't itself fire a
   "blur" event the way a real browser would, so tests dispatch that event
   by hand). */

/* Build a single rectangular room directly (same minting pattern as
   tools.test.js's whole-room-drag test) rather than going through addRoom(),
   which would also schedule a focusRoomName() rename via setTimeout(0) that
   could fire mid-test and race with the rename this test is driving by
   hand. */
function makeTestRoom(run) {
  return run(() => {
    const f = activeLevel();
    commit(() => {
      const mk = (x, y) => { const p = { id: "pt" + (_pid++), x, y }; f.points.push(p); return p.id; };
      const a = mk(0, 0), b = mk(10, 0), c = mk(10, 10), d = mk(0, 10);
      const rid = "room" + (_pid++);
      f.rooms.push({ id: rid, name: "Living Room", kind: "room", loop: [a, b, c, d] });
      f._pt = new Map(f.points.map(p => [p.id, p]));
      deriveWalls(f);
    });
    const r = f.rooms[f.rooms.length - 1];
    return { roomId: r.id, name: r.name };
  });
}

function roomName(run, roomId) {
  return run((roomId) => activeLevel().rooms.find(x => x.id === roomId).name, roomId);
}

test("renaming a room via startRenameRoom commits (undoable) and undo() reverts it", () => {
  const { run } = loadApp();
  const { roomId, name } = makeTestRoom(run);
  const historyBefore = run(() => history.length);

  run((roomId) => {
    const f = activeLevel();
    const r = f.rooms.find(x => x.id === roomId);
    const nameEl = document.createElement("div");
    startRenameRoom(r, nameEl);
    nameEl.textContent = "Kitchen";
    nameEl.dispatchEvent({ type: "blur" });
  }, roomId);

  assert.equal(run(() => history.length), historyBefore + 1, "a rename should push exactly one undo entry");
  assert.equal(roomName(run, roomId), "Kitchen");

  run(() => undo());
  assert.equal(roomName(run, roomId), name, "undo should restore the original name");
});

test("Escape cancels a room rename without committing", () => {
  const { run } = loadApp();
  const { roomId, name } = makeTestRoom(run);
  const historyBefore = run(() => history.length);

  run((roomId) => {
    const f = activeLevel();
    const r = f.rooms.find(x => x.id === roomId);
    const nameEl = document.createElement("div");
    startRenameRoom(r, nameEl);
    nameEl.textContent = "Kitchen";
    nameEl.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {} });
  }, roomId);

  assert.equal(run(() => history.length), historyBefore, "Escape must not push an undo entry");
  assert.equal(roomName(run, roomId), name, "the name should be unchanged after Escape");
});

test("a no-op rename (same text) on blur does not push a spurious undo entry", () => {
  const { run } = loadApp();
  const { roomId, name } = makeTestRoom(run);
  const historyBefore = run(() => history.length);

  run((roomId, name) => {
    const f = activeLevel();
    const r = f.rooms.find(x => x.id === roomId);
    const nameEl = document.createElement("div");
    startRenameRoom(r, nameEl);
    nameEl.textContent = name; // unchanged
    nameEl.dispatchEvent({ type: "blur" });
  }, roomId, name);

  assert.equal(run(() => history.length), historyBefore, "an unchanged name must not push an undo entry");
});

test("Enter commits the rename via the same blur path startRenameLevel uses", () => {
  const { run } = loadApp();
  const { roomId } = makeTestRoom(run);
  const historyBefore = run(() => history.length);

  run((roomId) => {
    const f = activeLevel();
    const r = f.rooms.find(x => x.id === roomId);
    const nameEl = document.createElement("div");
    // Enter calls nameEl.blur(), which a real browser turns into a "blur"
    // event our listener commits on; the stub DOM's blur() only flips a
    // flag, so patch in that one piece of real-browser plumbing here.
    const realBlur = nameEl.blur.bind(nameEl);
    nameEl.blur = () => { realBlur(); nameEl.dispatchEvent({ type: "blur" }); };
    startRenameRoom(r, nameEl);
    nameEl.textContent = "Garage";
    nameEl.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {} });
  }, roomId);

  assert.equal(run(() => history.length), historyBefore + 1, "Enter should commit exactly once");
  assert.equal(roomName(run, roomId), "Garage");
});

test("startRenameRoom refuses a second concurrent rename", () => {
  const { run } = loadApp();
  const { roomId } = makeTestRoom(run);

  const result = run((roomId) => {
    const f = activeLevel();
    const r = f.rooms.find(x => x.id === roomId);
    const el1 = document.createElement("div");
    const el2 = document.createElement("div");
    const started1 = startRenameRoom(r, el1);
    const started2 = startRenameRoom(r, el2);
    return { started1, started2 };
  }, roomId);

  assert.equal(result.started1, true, "the first rename should be allowed to start");
  assert.equal(result.started2, false, "a second rename while one is in progress must be refused");
});
