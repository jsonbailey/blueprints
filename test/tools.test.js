"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./harness");

/* Unlike model.test.js/persist.test.js's one-shot `run()` calls, these tests
   drive a stateful UI interaction (a tool staying open across several
   clicks) - so each test makes several `run()` calls against the SAME
   loadApp() instance. That's safe: `run()` re-evaluates fresh source each
   time, but it's the same vm context underneath, so `data`/`interaction`
   mutated by one `run()` call are still there for the next one. */

test("rectangle tool (N): two clicks create an axis-aligned 4-point room", () => {
  const { run } = loadApp();
  const before = run(() => activeLevel().rooms.length);
  run(() => toggleDrawTool("rect"));
  assert.equal(run(() => interaction.kind), "rect");
  run(() => interactionHandlers.rect.down(interaction, { clientX: 10, clientY: 10, button: 0, altKey: false, ctrlKey: false, metaKey: false }));
  assert.ok(run(() => !!interaction.a), "first click should record corner A");
  run(() => interactionHandlers.rect.down(interaction, { clientX: 300, clientY: 200, button: 0, altKey: false, ctrlKey: false, metaKey: false }));
  assert.equal(run(() => activeLevel().rooms.length), before + 1, "second click should complete the room");
  assert.equal(run(() => interaction), null, "the tool should exit after completing a room");
  assert.equal(run(() => sel.type), "room", "the new room should be selected");
});

test("rectangle tool: Esc cancels without creating a room", () => {
  const { run } = loadApp();
  const before = run(() => activeLevel().rooms.length);
  run(() => toggleDrawTool("rect"));
  run(() => interactionHandlers.rect.down(interaction, { clientX: 10, clientY: 10, button: 0, altKey: false, ctrlKey: false, metaKey: false }));
  const cancelled = run(() => cancelDrawTool());
  assert.equal(cancelled, true);
  assert.equal(run(() => interaction), null);
  assert.equal(run(() => activeLevel().rooms.length), before);
});

test("rectangle tool: pressing N again while active exits the tool", () => {
  const { run } = loadApp();
  run(() => toggleDrawTool("rect"));
  assert.equal(run(() => interaction.kind), "rect");
  run(() => toggleDrawTool("rect"));
  assert.equal(run(() => interaction), null);
});

test("freeform tool (Shift+N): a valid quad closes and creates a room", () => {
  const { run } = loadApp();
  const before = run(() => activeLevel().rooms.length);
  run(() => toggleDrawTool("poly"));
  const pts = [[10, 10], [300, 10], [300, 300], [10, 300], [10, 10]]; // last click closes on the first vertex
  pts.forEach(([x, y]) => {
    run((x, y) => interactionHandlers.poly.down(interaction, { clientX: x, clientY: y, button: 0, altKey: false, ctrlKey: true, metaKey: false }), x, y);
  });
  assert.equal(run(() => activeLevel().rooms.length), before + 1);
  assert.equal(run(() => interaction), null);
});

test("freeform tool: closing with fewer than 3 vertices is refused", () => {
  const { run } = loadApp();
  const before = run(() => activeLevel().rooms.length);
  run(() => toggleDrawTool("poly"));
  const click = (x, y) => run((x, y) => interactionHandlers.poly.down(interaction, { clientX: x, clientY: y, button: 0, altKey: false, ctrlKey: true, metaKey: false }), x, y);
  click(10, 10);
  click(100, 10);
  click(10, 10); // click back near the first vertex with only 2 placed - should refuse to close
  assert.equal(run(() => activeLevel().rooms.length), before, "fewer than 3 corners must not complete a room");
  assert.notEqual(run(() => interaction), null, "the tool should still be active, not silently exited");
});

test("freeform tool: a self-intersecting (bowtie) shape is rejected and discards the tool", () => {
  const { run } = loadApp();
  const before = run(() => activeLevel().rooms.length);
  run(() => toggleDrawTool("poly"));
  const click = (x, y) => run((x, y) => interactionHandlers.poly.down(interaction, { clientX: x, clientY: y, button: 0, altKey: false, ctrlKey: true, metaKey: false }), x, y);
  [[0, 0], [100, 100], [100, 0], [0, 100], [0, 0]].forEach(([x, y]) => click(x, y));
  assert.equal(run(() => activeLevel().rooms.length), before, "a self-intersecting shape must not create a room");
  assert.equal(run(() => interaction), null, "a rejected shape discards the tool rather than leaving it open");
});

test("new room created via a drawing tool gets its name field focused", async () => {
  const { run, document } = loadApp();
  run(() => toggleDrawTool("rect"));
  run(() => interactionHandlers.rect.down(interaction, { clientX: 10, clientY: 10, button: 0, altKey: false, ctrlKey: false, metaKey: false }));
  run(() => interactionHandlers.rect.down(interaction, { clientX: 300, clientY: 200, button: 0, altKey: false, ctrlKey: false, metaKey: false }));
  // focusRoomName() defers via setTimeout(0) so a click's own focus-shifting
  // default action doesn't immediately steal it back - flush that.
  await new Promise(resolve => setTimeout(resolve, 10));
  const rn = document.getElementById("roomName");
  assert.ok(rn._focused, "the room name field should end up focused");
});

test("whole-room drag moves a welded neighbor along without distorting it", () => {
  const { run } = loadApp();
  const deltas = run(() => {
    const f = activeLevel();
    commit(() => {
      const mk = (x, y) => { const p = { id: "pt" + (_pid++), x, y }; f.points.push(p); return p.id; };
      const a = mk(0, 0), b = mk(10, 0), c = mk(10, 10), d = mk(0, 10);   // room A
      const e = mk(10, 20), g = mk(0, 20);                                 // room B's far corners
      f.rooms.push({ id: "roomA", name: "A", kind: "room", loop: [a, b, c, d] });
      f.rooms.push({ id: "roomB", name: "B", kind: "room", loop: [d, c, e, g] }); // shares c,d with A
      f._pt = new Map(f.points.map(p => [p.id, p]));
      deriveWalls(f);
      // stash the ids on the level so the next run() call can find them again
      f._testIds = { d, g };
    });
    const before = { d: { ...ptOf(f, f._testIds.d) }, g: { ...ptOf(f, f._testIds.g) } };

    startDragRoom({ clientX: 0, clientY: 0, stopPropagation() {}, pointerId: 1 }, "roomA");
    const clusterSize = interaction.roomIds.length;
    interactionHandlers.room.move(interaction, { clientX: 50, clientY: 50, altKey: true }); // Alt bypasses connect-snap for a clean delta
    interactionHandlers.room.end(interaction);

    const after = { d: { ...ptOf(f, f._testIds.d) }, g: { ...ptOf(f, f._testIds.g) } };
    return {
      clusterSize,
      dDelta: { x: after.d.x - before.d.x, y: after.d.y - before.d.y },
      gDelta: { x: after.g.x - before.g.x, y: after.g.y - before.g.y },
    };
  });
  assert.equal(deltas.clusterSize, 2, "the drag should pick up both welded rooms");
  assert.ok(
    Math.abs(deltas.dDelta.x - deltas.gDelta.x) < 1e-6 && Math.abs(deltas.dDelta.y - deltas.gDelta.y) < 1e-6,
    "the shared-wall room and the neighbor's far corner must move by the same delta (rigid translate, no stretching)"
  );
});
