"use strict";

/* ---------- app state ---------- */
let data = freshData();             // {levels:[level, ...], activeLevelId}
const ORIGINAL = JSON.stringify(stripIdx(data));
let sel = {type:null, id:null};
const view = {scale:14, ox:120, oy:80};   // px per ft, screen offset
const opts = {shadow:true, dims:true, labels:true, grid:true, snap:0.25, snapConnect:true};
const history = [];

function activeLevel(){ return data.levels.find(l=>l.id===data.activeLevelId) || data.levels[0]; }
/* Every level other than the active one that is marked visible — drawn as a
   shadow beneath the active level (when opts.shadow is on). */
function otherLevels(){ const a=activeLevel(); return data.levels.filter(l=>l!==a && l.visible); }

function snapshot(){
  history.push(JSON.stringify(stripIdx(data)));
  if(history.length>120) history.shift();
}
/* Lazy commit: capture state at gesture start, only push to history once the
   user actually moves something — so a plain click never pollutes undo. */
function captureState(){ return JSON.stringify(stripIdx(data)); }
function commitCaptured(d){
  if(d && !d.committed){ history.push(d.preState); if(history.length>120) history.shift(); d.committed=true; }
}
function undo(){
  if(!history.length) return;
  loadData(JSON.parse(history.pop())); sel={type:null,id:null}; render(); renderInspector();
}
