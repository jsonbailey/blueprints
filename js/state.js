"use strict";

/* ---------- app state ---------- */
let data = freshData();             // {levels:[level, ...], activeLevelId}
const ORIGINAL = JSON.stringify(stripIdx(data));
let sel = {type:null, id:null};
const view = {scale:14, ox:120, oy:80};   // px per ft, screen offset
/* lengthMode is a pure session view preference (like shadow/dims/labels/
   grid/snap/snapConnect above) — never persisted to the saved-plan schema
   (see js/persist.js LEVEL_FIELDS, which doesn't mention `opts` at all).
   "inside" (the default, matching the shipped per-room interior dimension
   labels — see js/render.js) shows/edits a wall's INTERIOR clear length
   (drywall face to drywall face, via roomInterior/wallSides); "centerline"
   shows/edits the raw endpoint-to-endpoint distance (the original, still
   available behavior). */
const opts = {shadow:true, dims:true, labels:true, grid:true, snap:0.25, snapConnect:true, lengthMode:"inside"};
const history = [];

function activeLevel(){ return data.levels.find(l=>l.id===data.activeLevelId) || data.levels[0]; }
/* Every level other than the active one that is marked visible — drawn as a
   shadow beneath the active level (when opts.shadow is on). */
function otherLevels(){ const a=activeLevel(); return data.levels.filter(l=>l!==a && l.visible); }

/* Single chokepoint for "an undoable change happened": both the eager
   snapshot() path and the lazy commitCaptured() path (used by drag gestures)
   push through here, so anything that needs to react to "something changed"
   (e.g. a future debounced local-storage autosave) has exactly one place to
   hook, regardless of which of the two commit mechanisms triggered it. */
function pushHistory(serializedState){
  history.push(serializedState);
  if(history.length>120) history.shift();
}
function snapshot(){
  pushHistory(JSON.stringify(stripIdx(data)));
}
/* Lazy commit: capture state at gesture start, only push to history once the
   user actually moves something — so a plain click never pollutes undo. */
function captureState(){ return JSON.stringify(stripIdx(data)); }
function commitCaptured(d){
  if(d && !d.committed){ pushHistory(d.preState); d.committed=true; }
}
/* Re-render chokepoint: the other half of "something changed" — re-draws the
   plan and the inspector. Also called directly (without snapshot()) by
   callers that mutate transient UI state (selection, level switch) that
   isn't itself undoable.
   Also the hook for post-mutation passes: resolveObjects() (js/model.js)
   re-derives every anchored object's cached x/y/rot from its wall (and
   unanchors any whose wall is gone) BEFORE drawing. Every commit(), undo,
   load/reset and drag end funnels through here, so this is the one place
   the rest of the code can trust has already run. It is idempotent and
   cheap, so running it on a selection-only markDirty is harmless; drags
   that move geometry live call resolveObjects() themselves before render(),
   and render() itself never does. */
function markDirty(){
  data.levels.forEach(resolveObjects);
  render(); renderInspector();
}
/* Wrap a single undoable mutation: snapshot the pre-state, run the mutation,
   then re-render. This is the one place most call sites should route
   "this should be undoable and should trigger a re-render" through, instead
   of each repeating `snapshot(); <mutate>; render(); renderInspector();`
   by hand. */
function commit(mutateFn){
  snapshot();
  mutateFn();
  markDirty();
}
function undo(){
  if(!history.length) return;
  data = loadData(JSON.parse(history.pop()));
  sel={type:null,id:null};
  markDirty();
}
