"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createDomStub } = require("./dom-stub");

const ROOT = path.join(__dirname, "..");

/* The app's own files are plain, non-module <script src> tags (see
   ARCHITECTURE.md — deliberate, so the app keeps working over file:// with
   no build step). Read the real load order out of index.html itself, rather
   than hand-maintaining a duplicate list here that could silently drift out
   of sync when a script tag is added, removed, or reordered. */
function scriptOrder() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  if (!srcs.length) throw new Error("harness: found no <script src> tags in index.html");
  // strip the "?v=1"-style cache-busting query string back to a real file path
  return srcs.map(s => s.split("?")[0]);
}

/* Load every app script into one fresh sandboxed global scope (mirroring
   how a real page shares one scope across classic, non-module scripts) and
   return that scope plus the stub DOM pieces, for a test to assert against.
   Throws if any file fails to parse/execute at the top level — that's the
   main class of bug this harness catches (see dom-stub.js's header comment
   for what it does and doesn't verify). */
function loadApp() {
  const { document, window, svgEl, makeElement } = createDomStub();
  const ctx = {
    document, window, console, Math, JSON, Array, Object, String, Number,
    Boolean, Map, Set, WeakMap, WeakSet, Symbol,
    parseFloat, parseInt, isNaN, isFinite, Infinity, NaN, Date,
    alert() {}, confirm() { return true; }, prompt() { return null; },
    URL: { createObjectURL() { return "blob:test"; }, revokeObjectURL() {} },
    Blob: function Blob() {},
    FileReader: function FileReader() { this.readAsText = function () {}; },
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  ctx.globalThis = ctx;
  ctx.window.document = document;
  vm.createContext(ctx);

  const files = scriptOrder();
  const code = files
    .map(f => fs.readFileSync(path.join(ROOT, f), "utf8"))
    .join("\n;\n");
  vm.runInContext(code, ctx, { filename: "app-bundle.js" });

  /* The app's top-level `let`/`const` globals (`data`, `sel`, `interaction`,
     etc.) do NOT appear as properties on `ctx`, even though code running
     inside this same vm context can see them fine by lexical scope - only
     `function`/`var` top-level declarations become real properties of a vm
     context's global object. Separately, vm.createContext gives this code
     its own realm with its own Array/Object/etc., so a plain object or
     array *returned* from inside the vm doesn't compare equal (via
     assert.deepStrictEqual) to a same-looking host-realm literal, even when
     their contents are identical.

     `run(fn, ...args)` solves both: it stringifies `fn` and re-evaluates it
     *inside* the vm (so the function body gets real lexical access to every
     global, `let`/`const` included), passing `args` in as JSON and
     JSON-round-tripping the return value back out as a plain host-realm
     value. This means:
       - `args` must be JSON-serializable (plain data - fine for levels,
         points, rooms, raw saved-plan objects; not fine for passing a DOM
         element or a function in).
       - the return value is JSON-round-tripped too, so anything not
         JSON-safe (a Map, `undefined` inside an object, a function) is
         silently dropped/altered, same as any JSON.stringify would do -
         don't rely on this for asserting about non-JSON-safe shapes.
       - a test that needs to read global mutable state as a side effect
         (e.g. the id counters, or `data` itself) should do so by `return`ing
         it from inside `fn`, not by reading `ctx.xyz` afterward. */
  function run(fn, ...args) {
    const argsSrc = args.map(a => JSON.stringify(a)).join(",");
    const src = `(${fn.toString()})(${argsSrc})`;
    const result = vm.runInContext(src, ctx, { filename: "test-bridge.js" });
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
  }

  return { ctx, document, window, svgEl, makeElement, files, run };
}

module.exports = { loadApp, scriptOrder };
