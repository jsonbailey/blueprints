"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createDomStub, createLocalStorageStub } = require("./dom-stub");

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
/* `opts.localStorageSeed`, an optional {key: stringValue} object, is written
   into the stub store BEFORE the app bundle (and so its startup/autosave
   code) ever runs — this is how the autosave suite (test/autosave.test.js)
   simulates "reopening the page with an existing blueprints:* project
   already in storage" rather than always exercising the fresh-project path. */
function loadApp(opts) {
  const { document, window, svgEl, makeElement } = createDomStub();
  const localStorage = createLocalStorageStub();
  if (opts && opts.localStorageSeed) {
    for (const [k, v] of Object.entries(opts.localStorageSeed)) localStorage.setItem(k, v);
  }
  const ctx = {
    document, window, console, Math, JSON, Array, Object, String, Number,
    Boolean, Map, Set, WeakMap, WeakSet, Symbol,
    parseFloat, parseInt, isNaN, isFinite, Infinity, NaN, Date,
    alert() {}, confirm() { return true; }, prompt() { return null; },
    URL: { createObjectURL() { return "blob:test"; }, revokeObjectURL() {} },
    Blob: function Blob() {},
    FileReader: function FileReader() { this.readAsText = function () {}; },
    /* Real host timers, but unref()'d: any app code running in this vm
       context (not just js/storage.js's autosave debounce — the level-panel
       rename's double-click timer, the cut-tool alert, the Save-link
       blob-URL cleanup, etc.) can schedule a real setTimeout/setInterval,
       and NOTHING here ever calls clearTimeout/clearInterval on a test's
       behalf except where a test does so itself (e.g. flushAutosave()). A
       ref'd real timer keeps Node's event loop - and so the test runner -
       alive until it fires, so a single uncollected 1.5s autosave timer
       left behind by some unrelated test (anything that drives a
       commit()/markDirty()-triggering mutation, which is most of this
       suite) would silently add up to 1.5s of real wall-clock wait per
       test file. unref() tells Node "don't let this timer alone keep the
       process alive" - the timer still fires normally if the process is
       kept alive by something else, but it can never hold one open by
       itself, so every test file runs at the speed of its actual
       assertions regardless of what debounced/delayed work the app code
       under test happens to schedule. */
    setTimeout: (fn, ms, ...args) => { const t = setTimeout(fn, ms, ...args); if (t && t.unref) t.unref(); return t; },
    clearTimeout,
    setInterval: (fn, ms, ...args) => { const t = setInterval(fn, ms, ...args); if (t && t.unref) t.unref(); return t; },
    clearInterval,
    // Fresh, isolated in-memory store per loadApp() call (test/dom-stub.js) —
    // the autosave suite (test/autosave.test.js) needs a real
    // getItem/setItem/key/length-shaped localStorage, and nothing here may
    // leak state between tests via a real persistent backing file.
    localStorage,
  };
  ctx.globalThis = ctx;
  ctx.window.document = document;
  vm.createContext(ctx);

  const files = scriptOrder();
  const code = files
    .map(f => fs.readFileSync(path.join(ROOT, f), "utf8"))
    .join("\n;\n");
  vm.runInContext(code, ctx, { filename: "app-bundle.js" });

  /* js/storage.js's startup path (js/app.js's resumeStartupProject()) always
     calls setProjectName(), which always calls triggerAutosave() — so every
     loadApp() call schedules one real `setTimeout(performAutosave, 1500)`.
     The setTimeout wrapper above already unref()s it (and every other real
     timer the app schedules), so a left-behind one can no longer hold a
     test file's process open on its own — that's the general fix for every
     current and future test. Separately (a convenience, not a correctness
     requirement now), consume/clear that one startup timer immediately so
     a test reading storage right after loadApp() sees the just-loaded
     project's data already written, without needing to know a debounce
     exists. `flushAutosave` is a top-level `function` declaration (unlike
     `let`/`const`, those DO become real
     properties of the vm context's global object - see the comment below),
     so it's reachable here as a plain property; guarded in case loadApp() is
     ever pointed at an older app state without js/storage.js. This only
     clears the startup timer: a test's own subsequent mutation still
     schedules a fresh one the normal way, inspectable pre-flush and flushed
     explicitly by the test exactly as before. The flush itself is a
     harmless, idempotent write of the same data that was just loaded. */
  if (typeof ctx.flushAutosave === "function") ctx.flushAutosave();

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
