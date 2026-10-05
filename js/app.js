"use strict";

/* ---------- project name ---------- */
const projNameEl = document.getElementById("projectName");
let projectName = projNameEl.textContent.trim() || "Untitled Plan";
function setProjectName(name){
  projectName = (name||"").trim() || "Untitled Plan";
  projNameEl.textContent = projectName;
  document.title = projectName + " — Plan Editor";
}
setProjectName(projectName);
projNameEl.addEventListener("keydown", e=>{
  if(e.key==="Enter"){ e.preventDefault(); projNameEl.blur(); }
  else if(e.key==="Escape"){ e.preventDefault(); setProjectName(projectName); projNameEl.blur(); }
});
projNameEl.addEventListener("blur", ()=> setProjectName(projNameEl.textContent));

let movingEnd = "b";                 // which wall endpoint moves when length is edited
let cornerRoom = null;               // which room's corner is targeted for angle ops

/* ---------- selection + inspector ---------- */
function selectWall(id){ sel={type:"wall",id}; render(); renderInspector(); }
function selectPoint(id){ sel={type:"point",id}; render(); renderInspector(); }
function selectRoom(id){ sel={type:"room",id}; render(); renderInspector(); }
/* Openings live nested in wallProps[wallKey].openings, so their selection
   carries the wall key too; `id` alone (opening ids are unique) is what
   generic "is X selected" checks compare. */
function selectOpening(wallKey, id){ sel={type:"opening",id,wallKey}; render(); renderInspector(); }
function selectObject(id){ sel={type:"object",id}; render(); renderInspector(); }
function clearSel(){ sel={type:null,id:null}; render(); renderInspector(); }

function setReadout(label,val){
  document.getElementById("readoutLabel").textContent=label;
  document.getElementById("readout").textContent=val;
}

function applySnap(v){ return opts.snap>0 ? Math.round(v/opts.snap)*opts.snap : v; }

function addRoom(){
  const f=activeLevel();
  commit(()=>{
    const W=svg.clientWidth||800, H=svg.clientHeight||600;
    const w=12, h=10;
    let [cx,cy]=toWorld(W/2, H/2);
    cx=applySnap(cx-w/2); cy=applySnap(cy-h/2);
    const mk=(x,y)=>{ const id="pt"+(_pid++); f.points.push({id,x:snapInch(x),y:snapInch(y)}); return id; };
    const a=mk(cx,cy), b=mk(cx+w,cy), c=mk(cx+w,cy+h), d=mk(cx,cy+h);
    const rid="room"+(_pid++);
    f.rooms.push({id:rid, name:"New Room", kind:"room", loop:[a,b,c,d]});
    f._pt=new Map(f.points.map(p=>[p.id,p]));
    deriveWalls(f);
    sel={type:"room", id:rid};
  });
  focusRoomName();
}

/* "A room was just created" -> its name display enters the same in-place
   edit mode a double-click would (startRenameRoom, js/inspector.js), text
   selected and ready to type over. Shared by "+ New room" and both drawing
   tools so every entry point behaves identically. Deferred one task: when
   the room is completed by a click on the plan, the browser's own mousedown
   default action (moving focus to the clicked, non-focusable svg / body)
   runs after our pointerdown handler and would steal focus straight back. */
function focusRoomName(){
  setTimeout(()=>{
    if(sel.type!=="room") return;
    const r=activeLevel().rooms.find(x=>x.id===sel.id); if(!r) return;
    const rn=document.getElementById("roomName");
    if(rn) startRenameRoom(r, rn);
  },0);
}

/* ---------- fixtures & furniture (ARCHITECTURE.md item 5, free-placement
   half) ----------
   Deliberately NOT a click-to-place tool mode (that pattern, js/tools.js'
   rect/poly draw tools, exists for multi-vertex shapes — overkill for a
   single-point drop): each "+ <fixture>" button mints the object at the
   center of the current viewport (same toWorld(W/2,H/2) approach addRoom()
   already uses) and selects it immediately, so the user can drag it into
   place — "add it, then see how well it fits." Buttons are built here
   (rather than hand-listed in index.html) straight from FIXTURE_TYPES
   (js/catalog.js), so a new catalog entry needs no index.html edit. */
const fixtureButtonsEl = document.getElementById("fixtureButtons");
FIXTURE_TYPES.forEach(t=>{
  const btn=document.createElement("button");
  btn.type="button"; btn.className="btn"; btn.textContent="+ "+t.label;
  btn.onclick=()=>addFixture(t.type);
  fixtureButtonsEl.appendChild(btn);
});
function addFixture(type){
  const f=activeLevel();
  commit(()=>{
    const W=svg.clientWidth||800, H=svg.clientHeight||600;
    const [cx,cy]=toWorld(W/2,H/2);
    const o=addObject(f, type, applySnap(cx), applySnap(cy));
    if(o) sel={type:"object", id:o.id};
  });
}

/* ---------- pointer dispatch ----------
   Gesture state and per-kind behavior live in js/tools.js (`interaction` +
   `interactionHandlers`); these listeners only route events there. Corner,
   wall and room-label pointerdowns are wired in js/render.js straight to
   startDragPoint/startDragWall/startDragRoom (which stopPropagation), so
   anything reaching the svg's own pointerdown is empty space → pan.

   Exception: an interaction kind with its own `down` handler (the room-
   drawing tools) owns every pointerdown while it's active. This listener
   runs in the CAPTURE phase on the svg, i.e. before any wall/corner/label
   listener, and stops propagation there — so clicking existing geometry
   places a vertex instead of starting that element's drag, and the pan
   listener below never sees it. Only the primary button places; Ctrl+click
   is accepted even if the platform reports it as a secondary-button press
   (macOS turns Ctrl+click into a right-click). */
svg.addEventListener("pointerdown",(e)=>{
  const h = interaction && interactionHandlers[interaction.kind];
  if(!h || !h.down) return;
  e.stopImmediatePropagation(); e.preventDefault();
  if(e.button===0 || (e.button===2 && e.ctrlKey)) h.down(interaction,e);
}, true);
/* Ctrl+click opens the native context menu on some platforms; suppress it
   only while a draw tool is active (Ctrl+click = free-angle vertex). */
svg.addEventListener("contextmenu",(e)=>{ if(drawToolActive()) e.preventDefault(); });
svg.addEventListener("pointerdown",(e)=>{
  // A room-name rename is open (inspector or the canvas overlay, js/
  // inspector.js's _editingRoomId): don't clear the selection or start a
  // pan. The overlay itself lives outside the svg, so this only matters for
  // a click elsewhere on the plan, whose default action still blurs the
  // overlay (committing the rename) without us doing anything else here.
  if(_editingRoomId) return;
  clearSel();
  startPan(e);
});
svg.addEventListener("pointermove",(e)=>{
  if(interaction){ interactionHandlers[interaction.kind].move(interaction,e); return; }
  // idle: show cursor world coords
  if(sel.type==null){
    const [wx,wy]=eventWorld(e);
    setReadout("Cursor", `${fmtFt(wx)} · ${fmtFt(wy)}`);
  }
});
function endPointer(e){
  if(interaction) interactionHandlers[interaction.kind].end(interaction,e);
}
svg.addEventListener("pointerup",endPointer);
svg.addEventListener("pointercancel",endPointer);

svg.addEventListener("wheel",(e)=>{
  e.preventDefault();
  if(_editingRoomId) return;   // don't zoom out from under an open canvas rename overlay
  const bx=svgBox(); const mx=e.clientX-bx.left, my=e.clientY-bx.top;
  const [wx,wy]=toWorld(mx,my);
  const factor = Math.exp(-e.deltaY*0.0015);
  view.scale = Math.min(80, Math.max(3, view.scale*factor));
  // keep cursor anchored
  view.ox = mx - wx*view.scale;
  view.oy = my - wy*view.scale;
  render();
},{passive:false});

/* ---------- fit to view ---------- */
function fit(){
  const levels = opts.shadow ? [activeLevel(), ...otherLevels()] : [activeLevel()];
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  levels.forEach(f=>f.points.forEach(p=>{minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);}));
  if(!isFinite(minX)) return;
  const W=svg.clientWidth,H=svg.clientHeight,pad=48;
  const sx=(W-2*pad)/Math.max(1,maxX-minX), sy=(H-2*pad)/Math.max(1,maxY-minY);
  view.scale=Math.min(80,Math.max(3,Math.min(sx,sy)));
  view.ox = pad - minX*view.scale + (W-2*pad-(maxX-minX)*view.scale)/2;
  view.oy = pad - minY*view.scale + (H-2*pad-(maxY-minY)*view.scale)/2;
  render();
}

/* ---------- UI wiring ---------- */
/* Level panel: a dropdown opened from a titleblock button, listing every
   level with an eye toggle (shadow visibility) and double-click-to-rename —
   replaces the earlier flat tab row (see ARCHITECTURE.md item 1). Called
   from every render(); the row elements are only rebuilt when the level
   list (ids/names) changes — visibility icons and the active-row highlight
   are refreshed every call without a rebuild, same "cheap per-call refresh,
   full rebuild only when the list itself changes" pattern the old tab row
   used, so an in-progress rename or dropdown-open state survives re-renders
   triggered by unrelated activity (drags, pans, etc). */
const levelPanelBtn = document.getElementById("levelPanelBtn");
const levelPanelBtnName = document.getElementById("levelPanelBtnName");
const levelPanelEl = document.getElementById("levelPanel");
let _levelPanelSig = null;
let _levelPanelOpen = false;
let _editingLevelId = null;

function levelEyeIcon(visible){
  return visible
    ? '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z" fill="none" stroke="currentColor" stroke-width="1.3"/><line x1="1.5" y1="1.5" x2="14.5" y2="14.5" stroke="currentColor" stroke-width="1.3"/></svg>';
}

function openLevelPanel(){
  if(_levelPanelOpen) return;
  _levelPanelOpen = true;
  levelPanelEl.hidden = false;
  levelPanelBtn.setAttribute("aria-expanded","true");
  document.addEventListener("pointerdown", onLevelPanelOutsideClick, true);
}
function closeLevelPanel(){
  if(!_levelPanelOpen) return;
  _levelPanelOpen = false;
  levelPanelEl.hidden = true;
  levelPanelBtn.setAttribute("aria-expanded","false");
  document.removeEventListener("pointerdown", onLevelPanelOutsideClick, true);
}
function onLevelPanelOutsideClick(e){
  if(levelPanelEl.contains(e.target) || levelPanelBtn.contains(e.target)) return;
  closeLevelPanel();
}
levelPanelBtn.onclick = ()=> _levelPanelOpen ? closeLevelPanel() : openLevelPanel();

function renderLevelPanel(){
  const active = activeLevel();
  levelPanelBtnName.textContent = active.name;

  const sig = JSON.stringify(data.levels.map(l=>[l.id,l.name]));
  if(sig !== _levelPanelSig){
    _levelPanelSig = sig;
    levelPanelEl.textContent = "";
    data.levels.forEach(l=>{
      const row=document.createElement("div");
      row.className="level-row"; row.dataset.level=l.id;
      row.setAttribute("role","menuitemradio");
      // A real double-click fires two "click" events before "dblclick" (click,
      // click, dblclick is standard DOM event order) — switching + closing the
      // panel on that first click would hide the panel before dblclick ever
      // fires, and focusing a hidden (display:none) element is a silent no-op,
      // so double-click-to-rename would never visibly work. Defer the
      // single-click action briefly and cancel it if a dblclick follows.
      row.onclick=(e)=>{
        if(e.target.closest(".level-eye")) return;
        if(l.id===_editingLevelId) return;
        if(row._clickTimer){ clearTimeout(row._clickTimer); row._clickTimer=null; return; }
        row._clickTimer = setTimeout(()=>{ row._clickTimer=null; setLevel(l.id); closeLevelPanel(); }, 250);
      };

      const eye=document.createElement("button");
      eye.type="button"; eye.className="level-eye";
      eye.onclick=(e)=>{ e.stopPropagation(); toggleLevelVisible(l.id); };
      row.appendChild(eye);

      const name=document.createElement("span");
      name.className="level-name"; name.textContent=l.name;
      name.title="Double-click to rename";
      name.ondblclick=(e)=>{
        e.stopPropagation();
        if(row._clickTimer){ clearTimeout(row._clickTimer); row._clickTimer=null; }
        startRenameLevel(l.id, name);
      };
      row.appendChild(name);

      levelPanelEl.appendChild(row);
    });
    const add=document.createElement("button");
    add.type="button"; add.className="level-add"; add.textContent="+ Add level";
    add.onclick=(e)=>{ e.stopPropagation(); addLevel(); };
    levelPanelEl.appendChild(add);
  }

  levelPanelEl.querySelectorAll("[data-level]").forEach(row=>{
    const lvl = data.levels.find(x=>x.id===row.dataset.level); if(!lvl) return;
    row.setAttribute("aria-pressed", String(lvl.id===active.id));
    const eye = row.querySelector(".level-eye");
    eye.innerHTML = levelEyeIcon(lvl.visible);
    eye.title = lvl.visible ? "Hide from shadow view" : "Show in shadow view";
    eye.setAttribute("aria-label", (lvl.visible?"Hide ":"Show ")+lvl.name+" in shadow view");
  });
}

/* Sidebar "Walls" section: the active level's defaultThickness. Lives in the
   always-visible sidebar (not the level dropdown) because it's a drafting
   setting you adjust while working, independent of any selection. Called
   from every render(); like renderLevelPanel, it only touches the DOM when
   (active level, its default) actually changes, so an open dropdown or a
   half-typed custom value survives re-renders from drags/pans. */
const defThkSel = document.getElementById("defThkSel");
const defThkRow = document.getElementById("defThkCustomRow");
const defThkInput = document.getElementById("defThkCustom");
let _wallDefaultsSig = null;
defThkSel.innerHTML = thicknessOptionsHtml(null);
wireThicknessPicker(defThkSel, defThkRow, defThkInput, document.getElementById("defThkApply"), t=>{
  const f=activeLevel();
  if(t==null || Math.abs(t-f.defaultThickness)<1e-9){ _wallDefaultsSig=null; render(); return; }   // no-op: resync, no undo entry
  commit(()=>{ setDefaultThickness(f,t); });
});
function renderWallDefaults(){
  const f=activeLevel();
  const sig=JSON.stringify([f.id, f.name, f.defaultThickness]);
  if(sig===_wallDefaultsSig) return;
  _wallDefaultsSig=sig;
  document.getElementById("defThkLabel").textContent = "Default thickness · "+f.name;
  const choice=presetIdFor(f.defaultThickness);
  defThkSel.value=choice;
  defThkRow.hidden = choice!=="custom";
  defThkInput.value = choice==="custom" ? String(+(f.defaultThickness*12).toFixed(3)) : "";
}

function setLevel(id){
  // Switching the active level isn't itself an undoable change (only
  // adding/renaming/visibility of a level is — see ARCHITECTURE.md), so this
  // uses markDirty() directly rather than commit().
  if(!data.levels.some(l=>l.id===id)) return;
  data.activeLevelId=id; sel={type:null,id:null};
  markDirty();
}
function addLevel(){
  commit(()=>{
    const lvl = makeLevel("Level "+(data.levels.length+1), []);
    data.levels.push(lvl);
    data.activeLevelId = lvl.id;
    sel={type:null,id:null};
  });
}
/* level.visible is persisted per-level data (LEVEL_META_FIELDS in
   js/persist.js), unlike the active-level cursor above, so toggling it goes
   through commit() — undoable and saved, same treatment as renaming. */
function toggleLevelVisible(id){
  const l=data.levels.find(x=>x.id===id); if(!l) return;
  commit(()=>{ l.visible = !l.visible; });
}
/* True in-place rename, following the #projectName contenteditable pattern:
   Enter commits and blurs, Escape cancels and reverts, blur commits. No
   prompt() dialog. */
function startRenameLevel(id, nameEl){
  const l=data.levels.find(x=>x.id===id); if(!l) return;
  if(_editingLevelId) return;
  _editingLevelId = id;
  nameEl.contentEditable = "true";
  nameEl.spellcheck = false;
  nameEl.classList.add("editing");
  nameEl.focus();
  const range=document.createRange(); range.selectNodeContents(nameEl);
  const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range);

  function finish(apply){
    nameEl.removeEventListener("keydown", onKey);
    nameEl.removeEventListener("blur", onBlur);
    nameEl.contentEditable = "false";
    nameEl.classList.remove("editing");
    _editingLevelId = null;
    const text = nameEl.textContent.trim();
    if(apply && text && text!==l.name){
      commit(()=>{ l.name = text; });
    } else {
      nameEl.textContent = l.name;
    }
  }
  function onKey(e){
    if(e.key==="Enter"){ e.preventDefault(); nameEl.blur(); }
    else if(e.key==="Escape"){ e.preventDefault(); finish(false); nameEl.blur(); }
  }
  function onBlur(){ finish(true); }
  nameEl.addEventListener("keydown", onKey);
  nameEl.addEventListener("blur", onBlur);
}

document.getElementById("optShadow").onchange=e=>{opts.shadow=e.target.checked;render();};
document.getElementById("optDims").onchange  =e=>{opts.dims=e.target.checked;render();};
document.getElementById("optLabels").onchange=e=>{opts.labels=e.target.checked;render();};
document.getElementById("optGrid").onchange  =e=>{opts.grid=e.target.checked;render();};
document.getElementById("optSnap").onchange  =e=>{opts.snap=parseFloat(e.target.value);};
document.getElementById("optSnapConnect").onchange =e=>{opts.snapConnect=e.target.checked;};
document.getElementById("btnFit").onclick=fit;
document.getElementById("btnAddRoom").onclick=addRoom;
document.getElementById("btnUndo").onclick=undo;
document.getElementById("btnReset").onclick=()=>{
  if(!confirm("Reset to a single blank level? Unsaved edits will be lost.")) return;
  data = loadData(JSON.parse(ORIGINAL));
  sel={type:null,id:null};
  markDirty();
};

/* save / load */
document.getElementById("btnSave").onclick=()=>{
  const out={name:projectName, ...stripIdx(data)};
  const blob=new Blob([JSON.stringify(out,null,2)],{type:"application/json"});
  const a=document.getElementById("dl"); a.href=URL.createObjectURL(blob);
  const slug=projectName.trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"") || "plan";
  a.download=slug+".json"; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000);
};
document.getElementById("btnLoad").onclick=()=>document.getElementById("fileInput").click();
document.getElementById("fileInput").onchange=(e)=>{
  const file=e.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=()=>{ try{
      const obj=JSON.parse(reader.result);
      // loadData migrates (any schema version) + validates, and only replaces
      // `data` on success — so push the undo entry only after it succeeds.
      const pre=captureState();
      data = loadData(obj);
      commitCaptured({preState:pre, committed:false});
      setProjectName(obj.name); sel={type:null,id:null}; markDirty();
    }catch(err){
      alert(err && err.tooNew
        ? "That plan was saved by a newer version of this editor and can't be opened here."
        : "Couldn't read that file — it doesn't look like a saved plan.");
    }
  };
  reader.readAsText(file); e.target.value="";
};

/* True while the keydown's target is somewhere the user is typing (a form
   field or a contenteditable, like the project-name titleblock field) —
   global shortcuts must not fire there, or e.g. Ctrl/Cmd+Z would hijack the
   browser's native text-undo instead of editing it. */
function isTypingTarget(e){
  const t = e.target;
  if(!t) return false;
  const tag = t.tagName;
  return tag==="INPUT" || tag==="SELECT" || tag==="TEXTAREA" || !!t.isContentEditable;
}

document.addEventListener("keydown",(e)=>{
  if(isTypingTarget(e)) return;

  if(e.key==="Escape"){
    // Esc priority: cancel an active draw tool (discarding its in-progress
    // shape) or wall-pick mode first, then close an open level panel, then clear the current
    // selection — each an early-return guard clause.
    if(cancelDrawTool()) return;
    if(cancelPickWall()) return;   // "Measure from wall…" pick mode
    if(_levelPanelOpen){ closeLevelPanel(); return; }
    clearSel();
    return;
  }

  // e.code (not e.key) for letter shortcuts: e.key changes with Shift/
  // modifier state ("z" vs "Z"), while e.code ("KeyZ") stays stable
  // regardless — needed so a future Shift+N can be told apart from plain N.
  if((e.ctrlKey||e.metaKey) && e.code==="KeyZ"){ e.preventDefault(); undo(); return; }

  // N = rectangle tool, Shift+N = freeform tool (ARCHITECTURE.md item 2).
  // Not with Ctrl/Cmd/Alt (leave browser shortcuts like Cmd+N alone), and
  // not on key auto-repeat (holding N would toggle the tool on and off).
  if(e.code==="KeyN" && !e.ctrlKey && !e.metaKey && !e.altKey){
    e.preventDefault();
    if(!e.repeat) toggleDrawTool(e.shiftKey ? "poly" : "rect");
    return;
  }

  // Ctrl/Cmd/Alt pressed with the mouse still: refresh the draw preview's
  // free-angle / snap-bypass state without waiting for a pointermove.
  if(e.key==="Control" || e.key==="Meta" || e.key==="Alt") refreshDrawPreview(e);
});
document.addEventListener("keyup",(e)=>{
  if(e.key==="Control" || e.key==="Meta" || e.key==="Alt") refreshDrawPreview(e);
});

window.addEventListener("resize", render);

/* ---------- go ---------- */
fit();
render();            // fit() skips rendering on a blank plan; this also builds the level panel
renderInspector();
