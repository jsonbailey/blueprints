"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./harness");

test("app loads: every script executes top-to-bottom without throwing", () => {
  const { ctx, run } = loadApp();
  assert.equal(typeof ctx.render, "function", "render is a function declaration, so it's a real ctx property");
  assert.equal(typeof ctx.renderInspector, "function");
  const levelCount = run(() => data.levels.length);
  assert.equal(levelCount, 1, "a fresh app starts with exactly one level");
});

test("app loads cleanly a second time (fresh isolated state per loadApp() call)", () => {
  const a = loadApp();
  const b = loadApp();
  assert.notEqual(a.ctx, b.ctx);
  assert.equal(b.run(() => data.levels.length), 1);
  // mutating one instance's state must not leak into the other
  a.run(() => { data.levels[0].name = "Changed"; });
  assert.equal(b.run(() => data.levels[0].name), "Level 1");
});
