"use strict";

/* ---------- local-storage autosave (ARCHITECTURE.md item 6) ----------
   Storage shape, every key namespaced "blueprints:" — this app can run
   from file://, where every local file shares one localStorage origin, so
   the prefix avoids colliding with an unrelated local page that happens to
   be opened from the same machine:

     blueprints:projects          -> [{id, name, updatedAt}, ...]   (index)
     blueprints:project:<id>      -> full saved-plan JSON, the EXACT shape
                                      btnSave already produces:
                                      {name, ...stripIdx(data)}
     blueprints:currentProjectId  -> which project id is "open" right now

   This is a data layer only — no UI here for creating/switching/deleting
   projects (that's item 7, built on top of this). The index is kept in
   sync on every autosave so item 7 has something real to list, but nothing
   in this file reads the index for any purpose beyond that.

   No new persistence-format logic lives here: serializing/deserializing a
   project goes straight through stripIdx/loadData/migrateData from
   js/persist.js (loaded just before this file) — this module only decides
   *where* that existing shape is read from / written to.

   Every localStorage access is wrapped in try/catch: a corrupt JSON blob, a
   missing key, or localStorage being unavailable at all (private browsing,
   disabled storage, file:// restrictions in some browsers) must fall back
   to "start fresh" / "skip this write", never throw and break page load.

   Multi-tab note: two tabs with the same project open both autosaving is
   last-write-wins — there is deliberately no storage-event listening, merge
   logic, or cross-tab locking here (see ARCHITECTURE.md item 6). */

const LS_PREFIX = "blueprints:";
const LS_PROJECTS_KEY = LS_PREFIX + "projects";
const LS_CURRENT_KEY = LS_PREFIX + "currentProjectId";
function lsProjectKey(id) { return LS_PREFIX + "project:" + id; }

/* Debounce delay, exported as a real constant (not a magic number buried in
   a setTimeout call) so tests can reference it, and so flushAutosave()
   below gives tests a way to force the pending write without actually
   sleeping for it. */
const AUTOSAVE_DEBOUNCE_MS = 1500;

function hasLocalStorage() {
  try { return typeof localStorage !== "undefined" && localStorage != null; }
  catch (e) { return false; }
}

function lsGetJSON(key) {
  if (!hasLocalStorage()) return null;
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}
function lsSetJSON(key, value) {
  if (!hasLocalStorage()) return false;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    // QuotaExceededError, Safari private-browsing restrictions, etc. The
    // mutation that triggered this save already succeeded in memory; only
    // the persistence attempt failed, so this must not throw further.
    console.warn("autosave: localStorage write failed for " + key, e);
    return false;
  }
}

function readProjectsIndex() {
  const v = lsGetJSON(LS_PROJECTS_KEY);
  return Array.isArray(v) ? v.filter(e => e && typeof e === "object" && typeof e.id === "string") : [];
}
function writeProjectsIndex(list) { return lsSetJSON(LS_PROJECTS_KEY, list); }

function readProjectBlob(id) { return lsGetJSON(lsProjectKey(id)); }
function writeProjectBlob(id, blob) { return lsSetJSON(lsProjectKey(id), blob); }

function readCurrentProjectId() {
  if (!hasLocalStorage()) return null;
  try {
    const v = localStorage.getItem(LS_CURRENT_KEY);
    return typeof v === "string" && v ? v : null;
  } catch (e) { return null; }
}
function writeCurrentProjectId(id) {
  if (!hasLocalStorage()) return false;
  try { localStorage.setItem(LS_CURRENT_KEY, id); return true; }
  catch (e) {
    console.warn("autosave: localStorage write failed for " + LS_CURRENT_KEY, e);
    return false;
  }
}

function mintProjectId() {
  return "proj" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* Keep the lightweight index entry for one project in sync (name +
   updatedAt) — inserts if the project has no entry yet. */
function upsertProjectIndexEntry(id, name, updatedAt) {
  const list = readProjectsIndex();
  const i = list.findIndex(e => e.id === id);
  const entry = { id, name, updatedAt };
  if (i >= 0) list[i] = entry; else list.push(entry);
  writeProjectsIndex(list);
}

/* ---------- startup ----------
   _currentProjectId is this module's own piece of state — the "which
   project is open" the rest of the app doesn't need to track separately. */
let _currentProjectId = null;
function getCurrentProjectId() { return _currentProjectId; }

/* Resolve what to load at boot. Resumes blueprints:currentProjectId's
   project (migrating it through loadData/migrateData exactly like opening
   an old file, so an autosaved blob from an older schema version upgrades
   transparently) when that id is listed in blueprints:projects AND its
   blob is present and readable. Otherwise mints a fresh project id, writes
   its index entry, and sets it current — same as a brand-new visit. Never
   throws: any corrupt/missing piece just falls through to "start fresh".
   Returns {id, name, data}; callers (js/app.js) are responsible for
   assigning the result onto the live `data`/projectName globals, same
   division of responsibility as loadData() itself. */
function loadStartupProject() {
  const id = readCurrentProjectId();
  if (id) {
    const idx = readProjectsIndex();
    if (idx.some(e => e.id === id)) {
      const blob = readProjectBlob(id);
      if (blob) {
        try {
          const loaded = loadData(blob);
          _currentProjectId = id;
          const name = (typeof blob.name === "string" && blob.name.trim()) || "Untitled Plan";
          return { id, name, data: loaded };
        } catch (e) { /* corrupt/unreadable blob: fall through to fresh */ }
      }
    }
  }
  const freshId = mintProjectId();
  _currentProjectId = freshId;
  upsertProjectIndexEntry(freshId, "Untitled Plan", Date.now());
  writeCurrentProjectId(freshId);
  return { id: freshId, name: "Untitled Plan", data: freshData() };
}

/* ---------- debounced write ----------
   Hooked into js/state.js's markDirty() (covers every commit()-driven
   mutation plus markDirty()-only changes like switching the active level)
   and explicitly into js/app.js's project-name path (the one mutation that
   doesn't flow through commit()/markDirty() at all). */
let _autosaveTimer = null;
function triggerAutosave() {
  if (!hasLocalStorage()) return;
  if (_autosaveTimer) clearTimeout(_autosaveTimer);
  _autosaveTimer = setTimeout(performAutosave, AUTOSAVE_DEBOUNCE_MS);
}
/* Test-only escape hatch: run the pending save synchronously instead of
   waiting out the real debounce delay. A no-op (besides clearing a pending
   timer) if nothing is pending. */
function flushAutosave() {
  if (_autosaveTimer) { clearTimeout(_autosaveTimer); _autosaveTimer = null; }
  performAutosave();
}
function performAutosave() {
  _autosaveTimer = null;
  const id = _currentProjectId;
  if (!id) return;
  // Exact same shape as js/app.js's btnSave handler — reused, not reinvented.
  const out = { name: projectName, ...stripIdx(data) };
  if (!writeProjectBlob(id, out)) return;   // write failure already warned
  upsertProjectIndexEntry(id, projectName, Date.now());
}
