"use strict";

/* renderInspector dispatches on sel.type via a lookup table — each selection
   type owns its own render function, so adding a new type later (upcoming:
   item 5's `object`) is "add one more table entry," not another branch in
   a growing if-chain. An `opening` selection is {type, id, wallKey}. */
const INSPECTOR_RENDERERS = {
  wall: renderWallInspector,
  point: renderPointInspector,
  room: renderRoomInspector,
  opening: renderOpeningInspector,
  object: renderObjectInspector,
};

function renderInspector(){
  const empty=document.getElementById("inspectorEmpty");
  const body=document.getElementById("inspectorBody");
  const f=activeLevel();
  const renderer = sel.type!=null ? INSPECTOR_RENDERERS[sel.type] : null;
  if(!renderer){ empty.hidden=false; body.hidden=true; setReadout("Cursor","move over the plan"); return; }
  empty.hidden=true; body.hidden=false;
  renderer(f, body);
}

/* ---------- wall-thickness picker (shared by the wall inspector and the
   level-default control in js/app.js) ----------
   A <select> of the standard presets (WALL_PRESETS, js/model.js) plus
   "Custom…", optionally led by a "Use level default (X)" option, and a
   custom-value row (text input + Set button) shown only for "Custom…". */
function presetIdFor(t){ const p=WALL_PRESETS.find(p=>Math.abs(p.thickness-t)<1e-6); return p ? p.id : "custom"; }
function thicknessOptionsHtml(defaultLabel){
  return (defaultLabel!=null ? `<option value="default">${esc(defaultLabel)}</option>` : "")
    + WALL_PRESETS.map(p=>`<option value="${p.id}">${esc(p.label)} (${fmtThickness(p.thickness)})</option>`).join("")
    + `<option value="custom">Custom…</option>`;
}
/* Wire a picker. `pick(t)` is called with feet, or null for "default"; it
   must do the commit() itself. Choosing "Custom…" only reveals the input —
   nothing is committed until Enter / Set with a valid value. */
function wireThicknessPicker(selEl, rowEl, inputEl, applyEl, pick){
  selEl.onchange=()=>{
    const v=selEl.value;
    if(v==="custom"){ rowEl.hidden=false; inputEl.focus(); inputEl.select(); return; }
    rowEl.hidden=true;
    if(v==="default") pick(null);
    else { const p=WALL_PRESETS.find(p=>p.id===v); if(p) pick(p.thickness); }
  };
  const apply=()=>{
    const t=parseThickness(inputEl.value);
    if(isNaN(t)){ setReadout("Thickness",`enter a thickness up to ${MAX_WALL_THICKNESS} ft (bare number = inches, e.g. 5.5)`); return; }
    pick(t);
  };
  applyEl.onclick=apply;
  inputEl.onkeydown=e=>{ if(e.key==="Enter"){ e.preventDefault(); apply(); } };
}

/* ---------- wall length display/edit mode (opts.lengthMode) ----------
   "centerline" is the raw endpoint-to-endpoint distance, always well-defined.
   "inside" shows/edits the interior clear length of ONE adjacent room, via
   wallSides() (js/model.js) — already computed by the interior-offset
   geometry from a prior task. A wall borders either one room (exterior wall:
   no choice to make) or two (a shared interior wall: pick which room's
   length is shown, exactly like cornerRoom's pattern for a shared corner's
   angle — `lengthRoom` remembers the choice, reset to the first available
   side whenever it doesn't apply to the current wall).
   Falls back to "centerline" (with `degenerate:true`) if wallSides() finds
   no USABLE side at all for this wall — shouldn't happen for a real wall,
   but a room's roomInterior can degenerate (near-collapsed offset geometry);
   never crash or show nonsense, same spirit as other degenerate-geometry
   fallbacks in this codebase.
   Returns {mode, len (the value to show/accept), centerline, sides (the
   usable wallSides() entries), cur (the chosen side, or null), degenerate}. */
function wallLengthState(f, w){
  const a=ptOf(f,w.a), b=ptOf(f,w.b);
  const centerline=Math.hypot(b.x-a.x,b.y-a.y);
  if(opts.lengthMode!=="inside") return {mode:"centerline", len:centerline, centerline, sides:[], cur:null};
  const sides=wallSides(f,w).filter(s=>s.side && s.side.len>1e-6);
  if(!sides.length) return {mode:"centerline", len:centerline, centerline, sides:[], cur:null, degenerate:true};
  if(!lengthRoom || !sides.some(s=>s.room.id===lengthRoom)) lengthRoom=sides[0].room.id;
  const cur=sides.find(s=>s.room.id===lengthRoom) || sides[0];
  return {mode:"inside", len:cur.side.len, centerline, sides, cur};
}

function renderWallInspector(f, body){
  const w=wallById(f,sel.id); if(!w){clearSel();return;}
  const a=ptOf(f,w.a), b=ptOf(f,w.b);
  const horiz = Math.abs(b.x-a.x) >= Math.abs(b.y-a.y);
  const ls = wallLengthState(f, w);
  const len = ls.centerline;      // the ACTUAL wall length — openings placement below needs this, not the display value
  const dispLen = ls.len;
  const lenRoomPicker = ls.sides.length>1
    ? `<select id="lenRoomSel" style="margin-bottom:6px">${ls.sides.map(s=>
        `<option value="${esc(s.room.id)}" ${s.room.id===ls.cur.room.id?"selected":""}>${esc(s.room.name)}</option>`).join("")}</select>`
    : "";
  const open=isOpenWall(f,w), override=wallThicknessOverride(f,w), eff=effThickness(f,w);
  const thkChoice = override==null ? "default" : presetIdFor(override);
  const thkSrc = open ? "open — no wall" : (override==null ? "level default" : "override");
  body.innerHTML = `
    <div class="kicker">WALL · ${w.id}</div>
    <span class="field-label">Length${ls.mode==="inside"?` (inside${ls.sides.length>1?", "+esc(ls.cur.room.name):""})`:""}</span>
    ${lenRoomPicker}
    <div class="bigval">${fmtFt(dispLen)}</div>
    ${ls.degenerate?`<p class="muted">This wall's interior geometry isn't usable right now, so length is shown/edited as centerline instead.</p>`:""}
    <span class="field-label">Set length (e.g. 13' 7" or 13.58)</span>
    <input type="text" id="lenInput" value="${fmtFt(dispLen)}">
    <div class="row" style="margin-top:10px">
      <label>Move which end?</label>
      <select id="endSel" style="flex:0 0 120px">
        <option value="b">End ②</option>
        <option value="a">End ①</option>
      </select>
    </div>
    <p class="muted">Orientation: ${horiz?"horizontal":"vertical"}. The ① and ② badges on the plan mark the ends; the red badge is the one that moves, the dark one stays put.</p>
    <div class="btngrid" style="margin-top:10px">
      <button class="btn primary" id="applyLen">Apply length</button>
      <button class="btn" id="divWall">Divide wall</button>
    </div>
    <div style="border-top:1px solid var(--panel-line);margin-top:12px;padding-top:12px">
      <span class="field-label">Thickness</span>
      <div class="bigval" style="font-size:18px">${fmtThickness(eff)}<span class="thk-src">${thkSrc}</span></div>
      <select id="thkSel" ${open?"disabled":""}>${thicknessOptionsHtml(`Use level default (${fmtThickness(f.defaultThickness)})`)}</select>
      <div class="thk-custom" id="thkCustomRow" ${thkChoice==="custom"&&!open?"":"hidden"}>
        <input type="text" id="thkCustom" placeholder='inches, e.g. 5.5 or 5½"' value="${override!=null&&thkChoice==="custom"?(+(override*12).toFixed(3)):""}">
        <button class="btn" id="thkApply">Set</button>
      </div>
      <label class="toggle row" style="margin-top:10px"><input type="checkbox" id="wallOpen" ${open?"checked":""}><span>Open (no wall)</span></label>
      <p class="muted" style="margin-top:4px">${open
        ? "Open-concept edge: drawn as a dashed line, zero thickness. Uncheck to restore a wall at the level default."
        : "Override this wall's thickness, or leave it on the level default (set in the Walls panel)."}</p>
    </div>
    ${wallOpeningsSectionHtml(f, w, len, open)}`;
  wireWallOpeningsSection(f, w, len, open);
  const thkSel=document.getElementById("thkSel");
  thkSel.value = thkChoice;
  wireThicknessPicker(thkSel, document.getElementById("thkCustomRow"), document.getElementById("thkCustom"),
    document.getElementById("thkApply"),
    t=>{
      const cur=wallThicknessOverride(f,w);
      if(isOpenWall(f,w) || (t==null ? cur==null : (cur!=null && Math.abs(cur-t)<1e-9))) { renderInspector(); return; }   // no-op: no undo entry
      commit(()=>{ setWallThickness(f,w,t); });
    });
  document.getElementById("wallOpen").onchange=e=>{ commit(()=>{ setWallOpen(f,w,e.target.checked); }); };
  if(ls.sides.length>1){
    document.getElementById("lenRoomSel").onchange=e=>{ lengthRoom=e.target.value; renderInspector(); };
  }
  document.getElementById("endSel").value = movingEnd;
  document.getElementById("endSel").onchange = e=>{ movingEnd=e.target.value; render(); };
  const apply=()=>applyLength(w);
  document.getElementById("applyLen").onclick=apply;
  const li=document.getElementById("lenInput");
  li.onkeydown=e=>{ if(e.key==="Enter"){e.preventDefault();apply();} };
  li.focus(); li.select();
  document.getElementById("divWall").onclick=()=>{
    let mid;
    commit(()=>{ mid=divideWall(f,w); sel={type:"point",id:mid}; });
  };
  setReadout("Wall", ls.degenerate ? `${fmtFt(dispLen)} (centerline — interior geometry unavailable)` : fmtFt(dispLen));
}

/* ---------- wall openings (ARCHITECTURE.md item 4) ----------
   The wall inspector lists the wall's openings (click one to select it, ✕
   to delete) and has one "+ <type>" button per catalog entry, which places
   that type at the wall's center — or the nearest free spot if something is
   already there — and selects it. Selected openings get their own inspector
   (renderOpeningInspector). Every mutation goes through commit(). Element
   ids are per-opening/per-type (opSel-<id>, opDel-<id>, opAdd-<type>) so
   they can be wired with getElementById. */
function openingSummary(o){ return `${openingLabel(o.type)} · ${fmtFt(o.width)} wide · center ${fmtFt(o.along)}`; }
function wallOpeningsSectionHtml(f, w, len, open){
  const key=wallKeyOf(w), list=openingsAt(f,key);
  const rows=list.map(o=>`<div class="op-row">
      <button class="btn op-pick" id="opSel-${esc(o.id)}">${esc(openingSummary(o))}</button>
      <button class="btn danger op-del" id="opDel-${esc(o.id)}" title="Delete">✕</button>
    </div>`).join("");
  return `<div style="border-top:1px solid var(--panel-line);margin-top:12px;padding-top:12px">
      <span class="field-label">Openings</span>
      ${open
        ? `<p class="muted">Doors and windows can't go on an open (no-wall) edge.${list.length?` ${list.length} opening${list.length>1?"s are":" is"} hidden here and will reappear if you uncheck Open.`:""}</p>`
        : `${rows || '<p class="muted">None yet.</p>'}
      <div class="btngrid" style="margin-top:8px">
        ${OPENING_TYPES.map(t=>`<button class="btn" id="opAdd-${esc(t.type)}">+ ${esc(t.label)}</button>`).join("")}
      </div>
      <p class="muted" style="margin-top:4px">Offsets are measured to the opening's center from corner ${esc(wallFrame(f,key).lo)}. Drag an opening on the plan to slide it along the wall.</p>`}
    </div>`;
}
function wireWallOpeningsSection(f, w, len, open){
  if(open) return;
  const key=wallKeyOf(w);
  openingsAt(f,key).forEach(o=>{
    document.getElementById("opSel-"+o.id).onclick=()=>selectOpening(key, o.id);
    document.getElementById("opDel-"+o.id).onclick=()=>{ commit(()=>{ removeOpening(f,key,o.id); }); };
  });
  OPENING_TYPES.forEach(t=>{
    document.getElementById("opAdd-"+t.type).onclick=()=>{
      // check first, so a refusal doesn't leave an empty undo entry
      if(nearestOpeningSlot(openingsAt(f,key), len/2, t.defaultWidth, len)==null){
        setReadout(t.label, `no room on this ${fmtFt(len)} wall for a ${fmtFt(t.defaultWidth)} ${t.label.toLowerCase()}`);
        return;
      }
      commit(()=>{ const o=addOpening(f, w, {type:t.type}); if(o) sel={type:"opening", id:o.id, wallKey:key}; });
    };
  });
}

function renderOpeningInspector(f, body){
  const key=sel.wallKey, o=key!=null ? findOpening(f,key,sel.id) : null;
  const fr=o && wallFrame(f,key);
  if(!o || !fr){ clearSel(); return; }
  const w=wallById(f, wallIdForKey(key));
  const def=openingTypeDef(o.type), fields=def ? def.fields : [];
  const open=isOpenWall(f,{a:fr.lo,b:fr.hi});
  const disp=displayedOpening(o, fr.len);
  // swing choices are labeled by room so a shared wall is unambiguous:
  // value "in:<roomId>" / "out:<roomId>" (out = away from that room)
  const rooms=wallSides(f,{a:fr.lo,b:fr.hi}).map(s=>s.room);
  let swingOpts="", swingVal="";
  if(fields.includes("swing")){
    const opts=rooms.map(r=>[`in:${r.id}`, `Into ${r.name}`]);
    if(rooms.length===1) opts.push([`out:${rooms[0].id}`, `Outward (away from ${rooms[0].name})`]);
    swingVal = `${o.swing==="out"?"out":"in"}:${o.room||""}`;
    if(!opts.some(([v])=>v===swingVal)) opts.unshift([swingVal, o.swing==="out" ? "Outward" : "Inward"]);
    swingOpts=opts.map(([v,l])=>`<option value="${esc(v)}">${esc(l)}</option>`).join("");
  }
  body.innerHTML = `
    <div class="kicker">${esc(openingLabel(o.type).toUpperCase())} · ${esc(o.id)}</div>
    <span class="field-label">On wall</span>
    <div class="muted">${esc(wallIdForKey(key))} · ${fmtFt(fr.len)} long</div>
    ${open ? `<p class="muted" style="margin-top:8px">This wall is marked open (no wall), so the opening is hidden. Uncheck Open on the wall to show and edit it again.</p>` : `
    <div class="pair" style="margin-top:10px">
      <div><span class="field-label">Center from ${esc(fr.lo)}</span><input type="text" id="opAlong" value="${fmtFt(o.along)}"></div>
      <div><span class="field-label">Width</span><input type="text" id="opWidth" value="${fmtFt(o.width)}"></div>
    </div>
    <div class="btngrid" style="margin-top:8px"><button class="btn primary" id="opApply">Apply</button></div>
    ${disp.clamped?`<p class="muted" style="margin-top:6px">The wall is currently shorter than this opening's stored position, so it's drawn clamped (${fmtFt(disp.width)} wide at ${fmtFt(disp.along)}). Lengthen the wall to restore it.</p>`:""}
    ${fields.includes("swing")?`<span class="field-label" style="margin-top:10px;display:block">Swing</span><select id="opSwing">${swingOpts}</select>`:""}
    ${fields.includes("hand")?`<span class="field-label" style="margin-top:10px;display:block">${o.type==="door"?"Hinge side (seen from the swing side)":"Front panel"}</span>
      <select id="opHand"><option value="left">Left</option><option value="right">Right</option></select>`:""}`}
    <div class="btngrid" style="margin-top:10px">
      ${w?'<button class="btn" id="opWall">Select wall</button>':""}
      <button class="btn danger" id="opDel">Delete</button>
    </div>`;
  if(!open){
    const apply=()=>{
      // an untouched field keeps the exact stored value (the inputs show it
      // rounded to the inch, which would otherwise nudge it on every Apply)
      const av=document.getElementById("opAlong").value, wv=document.getElementById("opWidth").value;
      const al = av===fmtFt(o.along) ? o.along : parseLen(av), wd = wv===fmtFt(o.width) ? o.width : parseLen(wv);
      if(isNaN(al) || !isValidOpeningWidth(wd)){ setReadout("Opening",`enter an offset and a width of ${fmtFt(OPENING_MIN_WIDTH)} to ${fmtFt(OPENING_MAX_WIDTH)}`); return; }
      const slot=nearestOpeningSlot(openingsAt(f,key), al, wd, fr.len, o.id);
      if(slot==null){ setReadout("Opening",`a ${fmtFt(wd)} opening doesn't fit on this wall next to its other openings`); return; }
      if(Math.abs(slot-o.along)<1e-9 && Math.abs(wd-o.width)<1e-9){ renderInspector(); return; }   // no-op: no undo entry
      commit(()=>{ updateOpening(f,key,o.id,{along:al, width:wd}); });
      if(Math.abs(slot-al)>1e-6) setReadout("Opening","moved to the nearest position that fits");
    };
    document.getElementById("opApply").onclick=apply;
    ["opAlong","opWidth"].forEach(id=>{ document.getElementById(id).onkeydown=e=>{ if(e.key==="Enter"){ e.preventDefault(); apply(); } }; });
    if(fields.includes("swing")){
      const s=document.getElementById("opSwing"); s.value=swingVal;
      s.onchange=()=>{ const [sw,room]=s.value.split(":"); commit(()=>{ updateOpening(f,key,o.id,{swing:sw, room}); }); };
    }
    if(fields.includes("hand")){
      const h=document.getElementById("opHand"); h.value=o.hand||"left";
      h.onchange=()=>{ commit(()=>{ updateOpening(f,key,o.id,{hand:h.value}); }); };
    }
  }
  if(w) document.getElementById("opWall").onclick=()=>selectWall(w.id);
  document.getElementById("opDel").onclick=()=>{ commit(()=>{ removeOpening(f,key,o.id); sel=w?{type:"wall",id:w.id}:{type:null,id:null}; }); };
  setReadout(openingLabel(o.type), `${fmtFt(o.width)} wide · ${fmtFt(o.along-o.width/2)} · ${fmtFt(fr.len-o.along-o.width/2)} to the wall ends`);
}

function renderPointInspector(f, body){
  const p=ptOf(f,sel.id); if(!p){clearSel();return;}
  const deg = pointDegree(f,p.id);
  const rs = roomsAt(f,p.id);
  const nRooms = rs.length;
  const shared = deg>=3 || nRooms>1;
  if(!cornerRoom || !rs.find(r=>r.id===cornerRoom)) cornerRoom = rs.length?rs[0].id:null;
  const cr = rs.find(r=>r.id===cornerRoom) || null;
  const ang = cr ? cornerAngle(f, cr, p.id) : null;
  const roomOpts = rs.map(r=>`<option value="${r.id}" ${r.id===cornerRoom?"selected":""}>${esc(r.name)}</option>`).join("");
  body.innerHTML = `
    <div class="kicker">CORNER · ${p.id}</div>
    <span class="field-label">Position (X · Y), feet from origin</span>
    <div class="bigval">${fmtFt(p.x)} · ${fmtFt(p.y)}</div>
    <div class="pair">
      <div><span class="field-label">X</span><input type="text" id="px" value="${p.x.toFixed(3)}"></div>
      <div><span class="field-label">Y</span><input type="text" id="py" value="${p.y.toFixed(3)}"></div>
    </div>
    <p class="muted">${deg} wall${deg===1?"":"s"} meet here${nRooms>1?` across ${nRooms} rooms`:""}. Editing moves them all together.</p>
    <div class="btngrid" style="margin-top:10px">
      <button class="btn primary" id="applyPt">Apply position</button>
      ${shared?'<button class="btn" id="detachPt">Detach junction</button>':''}
      <button class="btn danger" id="delPt">Delete corner</button>
    </div>
    ${shared?'<p class="muted" style="margin-top:8px">Detach separates this junction into one corner per room. Drag two corners back together to re-connect.</p>':''}
    ${cr?`
    <div style="border-top:1px solid var(--panel-line);margin-top:12px;padding-top:12px">
      <span class="field-label">Corner angle in room</span>
      ${nRooms>1?`<select id="cornerRoomSel" style="margin-bottom:8px">${roomOpts}</select>`:`<div class="muted" style="margin-bottom:6px">${esc(cr.name)}</div>`}
      <div class="bigval" style="font-size:18px">${ang!=null?ang.toFixed(1)+"°":"—"}</div>
      <div class="pair">
        <div><span class="field-label">Set angle (°)</span><input type="text" id="angInput" value="${ang!=null?ang.toFixed(1):"90"}"></div>
        <div style="display:flex;align-items:flex-end"><button class="btn" id="ang90" style="width:100%">90°</button></div>
      </div>
      <div class="btngrid" style="margin-top:8px"><button class="btn primary" id="applyAng">Apply angle</button></div>
      <p class="muted" style="margin-top:8px">Rotates an adjacent wall about this corner to set the angle (applied once). The non-locked neighbour moves.</p>
    </div>`:""}`;
  document.getElementById("applyPt").onclick=()=>{
    const nx=parseLen(document.getElementById("px").value);
    const ny=parseLen(document.getElementById("py").value);
    if(isNaN(nx)||isNaN(ny)) return;
    commit(()=>{ p.x=nx; p.y=ny; });
  };
  if(shared) document.getElementById("detachPt").onclick=()=>{ commit(()=>detachCorner(f,p.id)); };
  document.getElementById("delPt").onclick=()=>{ if(deletePoint(f,p.id)) clearSel(); };
  if(cr){
    const sel2=document.getElementById("cornerRoomSel");
    if(sel2) sel2.onchange=e=>{ cornerRoom=e.target.value; renderInspector(); };
    const doAng=(deg)=>{ const v=parseFloat(deg); if(isNaN(v)||v<=0||v>=180){ alert("Enter an angle between 0 and 180."); return; } setCornerAngle(f, cr, p.id, v); };
    document.getElementById("ang90").onclick=()=>doAng(90);
    document.getElementById("applyAng").onclick=()=>doAng(document.getElementById("angInput").value);
  }
  setReadout("Corner", `${fmtFt(p.x)} · ${fmtFt(p.y)}`);
}

/* True while a room name is being edited in place, either here (the
   inspector's "roomName" display) or via the on-canvas overlay js/render.js
   creates for the plan label — both call startRenameRoom below, and share
   this one flag as their "another rename is already in progress" guard
   (mirroring `_editingLevelId` in js/app.js). Also used by js/app.js to
   suppress pan/zoom while a canvas rename is open. */
let _editingRoomId = null;

/* True in-place rename for a room name, following startRenameLevel's exact
   control-flow pattern (js/app.js): Enter commits and blurs, Escape cancels
   and reverts, blur commits — and, unlike the old #roomName <input> this
   replaces, the commit goes through commit() so a room rename is undoable.
   `nameEl` is whatever contenteditable element is showing the name — the
   inspector's display span, or the on-canvas overlay div js/render.js builds
   — so both entry points share this exact logic instead of each reimplementing
   it. `opts.onFinish()`, if given, runs after editing ends either way (used
   by the canvas overlay to remove itself and re-enable pan/zoom). Returns
   false without starting anything if a rename is already in progress
   (here or on the level panel). */
function startRenameRoom(room, nameEl, opts){
  opts = opts || {};
  if(_editingLevelId || _editingRoomId) return false;
  _editingRoomId = room.id;
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
    _editingRoomId = null;
    const text = nameEl.textContent.trim();
    if(apply && text && text!==room.name){
      commit(()=>{ room.name = text; });
    } else {
      nameEl.textContent = room.name;
    }
    if(opts.onFinish) opts.onFinish();
  }
  function onKey(e){
    if(e.key==="Enter"){ e.preventDefault(); nameEl.blur(); }
    else if(e.key==="Escape"){ e.preventDefault(); finish(false); nameEl.blur(); }
  }
  function onBlur(){ finish(true); }
  nameEl.addEventListener("keydown", onKey);
  nameEl.addEventListener("blur", onBlur);
  return true;
}

function renderRoomInspector(f, body){
  const r=f.rooms.find(x=>x.id===sel.id); if(!r){clearSel();return;}
  const area=interiorArea(f,r);   // inside the walls' interior faces
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  r.loop.forEach(id=>{const p=ptOf(f,id);minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);});
  body.innerHTML = `
    <div class="kicker">ROOM</div>
    <span class="field-label">Room name</span>
    <div class="room-name-display" id="roomName" title="Double-click to rename">${esc(r.name)}</div>
    <div style="height:10px"></div>
    <span class="field-label">Floor area (inside walls)</span>
    <div class="bigval">${Math.round(area)} sf</div>
    <span class="field-label">Bounding size (W · H)</span>
    <div class="bigval" style="font-size:16px">${fmtFt(maxX-minX)} · ${fmtFt(maxY-minY)}</div>
    <p class="muted">Drag the room's name on the plan to move the whole room; it snaps onto nearby corners. Rooms welded to it (sharing a corner, directly or through a chain) move with it so they keep their shape; locked rooms stay put.</p>
    <span class="field-label">Nudge (by snap step)</span>
    <div class="btngrid" style="margin-top:6px">
      <button class="btn" data-nudge="up">↑</button>
      <button class="btn" data-nudge="down">↓</button>
      <button class="btn" data-nudge="left">←</button>
      <button class="btn" data-nudge="right">→</button>
    </div>
    <div class="btngrid" style="margin-top:8px">
      <button class="btn" id="detachRoom">Detach room (move solo)</button>
      <button class="btn danger" id="delRoom">Delete room</button>
    </div>
    <div class="btngrid" style="margin-top:8px">
      <button class="btn" id="cutRoomBtn">Cut overlaps from others</button>
    </div>
    <label class="toggle row" style="margin-top:10px"><input type="checkbox" id="lockRoom" ${r.locked?"checked":""}><span>Lock geometry</span></label>
    <p class="muted" style="margin-top:4px">Cut trims this room's shape out of any room it overlaps. Lock freezes this room so moving a connected room won't reshape it.</p>`;
  const rn=document.getElementById("roomName");
  rn.ondblclick=()=> startRenameRoom(r, rn);
  body.querySelectorAll("[data-nudge]").forEach(btn=>{
    btn.onclick=()=>nudgeRoom(r, btn.dataset.nudge);
  });
  document.getElementById("detachRoom").onclick=()=>{ commit(()=>detachRoom(f,r)); };
  document.getElementById("delRoom").onclick=()=>{
    if(!confirm(`Delete "${r.name}"?`)) return;
    commit(()=>{
      f.rooms=f.rooms.filter(x=>x.id!==r.id); gcPoints(f); deriveWalls(f);
      // Orphan (don't delete) any free object that belonged to this room,
      // rather than silently dropping furniture the user placed — the room
      // deletion's own confirm() above already covers this as part of "delete
      // the room", so the object doesn't need a second ceremony.
      (f.objects||[]).forEach(o=>{ if(o.roomId===r.id) o.roomId=null; });
      sel={type:null,id:null};
    });
  };
  document.getElementById("cutRoomBtn").onclick=()=>{
    // Not a plain commit(): on a no-op cut we roll the snapshot back instead
    // of rendering, and a "dropped a piece" warning needs the post-cut
    // render to have already happened — both are one-off exceptions to the
    // generic wrap, so this stays a manual snapshot()/render() sequence.
    snapshot();
    const res=cutRoom(f,r);
    if(res.err){ alert("Cut tool unavailable."); }
    else if(!res.changed){ history.pop(); /* nothing overlapped → drop snapshot */ }
    else if(res.dropped){ setTimeout(()=>alert("Cut done. A room split into pieces or got a hole; only the largest piece was kept — you may want to redraw that one."),0); }
    markDirty();
  };
  document.getElementById("lockRoom").onchange=(ev)=>{
    commit(()=>{
      if(ev.target.checked){ detachRoom(f,r); r.locked=true; }   // detach so it shares nothing, then freeze
      else { r.locked=false; }
    });
  };
  setReadout("Room", `${r.name} · ${Math.round(area)} sf${r.locked?" · LOCKED":""}`);
}

/* Same move-set as a room drag: the whole welded cluster, bounded by locked
   rooms (connectedRoomPoints in js/model.js). A locked room doesn't nudge. */
function nudgeRoom(r, dir){
  const f=activeLevel(); const step = opts.snap>0 ? opts.snap : 0.25;
  if(r.locked){ setReadout("Locked","unlock this room to move it"); return; }
  const cluster=connectedRoomPoints(f, r.id);
  const ids=cluster.ids;
  if(!ids.length) return;
  const dx = dir==="left"?-step:dir==="right"?step:0;
  const dy = dir==="up"?-step:dir==="down"?step:0;
  commit(()=>{
    ids.forEach(id=>{const p=ptOf(f,id); p.x+=dx; p.y+=dy;});
    // Same carry-along rule as the room-drag interaction (js/tools.js
    // startDragRoom/room.move): every free object whose roomId is anywhere
    // in the moved cluster, not just the room nudged directly.
    (f.objects||[]).forEach(o=>{ if(o.anchor==null && cluster.roomIds.includes(o.roomId)){ o.x+=dx; o.y+=dy; } });
  });
}

/* Move the endpoint picked by `movingEnd` so the wall's CENTERLINE length
   becomes `targetCenterline`, sliding it along the wall's own current
   direction — this is the one place that actually moves a wall-length
   endpoint; both length-edit modes below route through it so there is a
   single "move an endpoint to make the centerline this long" function
   rather than two near-duplicate implementations. */
function setWallCenterlineLength(f, w, targetCenterline){
  const a=ptOf(f,w.a), b=ptOf(f,w.b);
  let dx=b.x-a.x, dy=b.y-a.y; const cur=Math.hypot(dx,dy);
  if(cur<1e-6){ dx=1; dy=0; } else { dx/=cur; dy/=cur; }
  if(movingEnd==="b"){ b.x=a.x+dx*targetCenterline; b.y=a.y+dy*targetCenterline; }
  else               { a.x=b.x-dx*targetCenterline; a.y=b.y-dy*targetCenterline; }
}

/* Wall length edit. Deliberately does NOT touch the wall's openings: their
   stored `along`/`width` stay as they are and rendering clamps what it draws
   to the new length (displayedOpening in js/model.js), so shortening a wall
   and lengthening it again puts every opening back exactly where it was.

   In "inside" mode (opts.lengthMode), the typed value is the DESIRED
   interior clear length for the room picked by wallLengthState/lengthRoom,
   not the centerline length — convert it via a delta computed fresh, right
   here, from the wall's CURRENT (pre-edit) geometry:
       delta = currentCenterlineLength - currentInsideLengthForSelectedRoom
       targetCenterlineLength = typedInsideValue + delta
   Why this is exact, not an approximation: setWallCenterlineLength moves
   only the picked endpoint, sliding it along the wall's OWN existing
   direction — it never touches the room's other corners, and the corner at
   the end that does NOT move is obviously unaffected since that point never
   moves. At the end that DOES move, the wall's own offset (interior-face)
   line is anchored by the FIXED endpoint and the (preserved) direction, so
   it doesn't move either; what can move is the interior corner where it
   meets the NEXT wall's offset line. That intersection stays on this fixed
   offset line, slid by exactly the same amount the endpoint is slid,
   whenever the next wall's own offset line doesn't rotate as the endpoint
   moves along the shared wall's direction — true whenever that end isn't a
   genuine turn for the point of view of the room picked (e.g. the far side
   of a divided/subdivided straight run, or most real wall-length edits in
   practice). The gap between centerline length and this room's interior
   length at each end is therefore unchanged by the edit, so the delta
   computed before the edit remains valid after it, including through a
   second, third, ... edit in a row, since each call recomputes it fresh
   from the CURRENT geometry rather than reusing a stale value. */
function applyLength(w){
  const f=activeLevel();
  const val=parseLen(document.getElementById("lenInput").value);
  if(isNaN(val)||val<=0) return;
  const ls=wallLengthState(f, w);   // fresh, pre-edit state — never cached
  let target = val;
  if(ls.mode==="inside" && ls.cur){
    const delta = ls.centerline - ls.cur.side.len;
    target = val + delta;
  }
  if(target<=0) return;
  commit(()=>{ setWallCenterlineLength(f, w, target); });
}

/* Delete a point. Rooms that still have >=3 corners afterward just lose the
   corner; any room that would drop below 3 is deleted (with confirmation).
   Deliberately left as a manual snapshot() (not commit()): the confirm()
   dialog and "may abort, return false" shape sit before the mutation, and
   the caller (delPt's onclick) does its own render via clearSel() on
   success — wrapping this in commit() would double-render. */
function deletePoint(f, id){
  const rs=roomsAt(f,id);
  const willDelete = rs.filter(r=>r.loop.length<=3);
  if(willDelete.length){
    const names=willDelete.map(r=>`"${r.name}"`).join(", ");
    if(!confirm(`This corner belongs to ${willDelete.length} room${willDelete.length>1?"s":""} with only 3 corners. Deleting it will delete ${names}. Continue?`)) return false;
  }
  snapshot();
  const delIds=new Set(willDelete.map(r=>r.id));
  f.rooms = f.rooms.filter(r=>!delIds.has(r.id));
  // Removing the corner merges walls prev|id and id|next into prev|next
  // (remapWallRefs "merge"); every other edge is an identity pair so a wall
  // already at prev|next counts as the first contributor.
  const pairs=[];
  f.rooms.forEach(r=>{
    const L=r.loop, i=L.indexOf(id);
    if(i<0){ loopWallKeys(L).forEach(k=>{ if(k) pairs.push([k,k]); }); return; }
    const prev=L[(i-1+L.length)%L.length], next=L[(i+1)%L.length];
    const merged = prev===next ? null : wallKey(prev,next);
    // "first wall" for the merge = prev→id (loop order), then id→next
    pairs.push([wallKey(prev,id), merged], [wallKey(id,next), merged]);
    loopWallKeys(L).forEach(k=>{ if(k && !k.split("|").includes(id)) pairs.push([k,k]); });
    r.loop = L.filter(x=>x!==id);
  });
  remapWallRefs(f, {kind:"merge", pairs});
  gcPoints(f); deriveWalls(f);
  // the caller re-renders via clearSel(), not markDirty(), so run the
  // anchored-object pass here (see markDirty in js/state.js)
  resolveObjects(f);
  return true;
}

/* ---------- object inspector (ARCHITECTURE.md item 5; anchoring below)
   ----------
   Objects live in a flat level.objects array (unlike openings, which nest
   under wallProps), so selection ({type:"object", id}) is a direct
   f.objects.find(). Rotation is a free-form degrees input plus a "Rotate
   90°" button (no drag-handle interaction — unnecessary complexity for a
   free object with no wall to measure against); resize is w/d text inputs
   following the same fmtFt/parseLen convention as the wall-length input in
   renderWallInspector; mirror is a checkbox. Delete has no confirm() dialog
   (unlike room deletion): removing one free object is low-stakes — it
   doesn't cascade into walls/corners/other rooms the way deleting a room
   does — which matches removeOpening's ✕ button (also confirm-free). */
/* Anchoring (anchored half of item 5): a free object gets a "Measure from
   wall…" button (js/tools.js startPickWall: the next click on a wall of its
   room anchors it) and a computed, unstored "nearest wall" readout. An
   anchored object instead shows its wall, an edge picker and along/gap
   fields (same clamping as the drag: along within the wall, gap >= 0, via
   updateAnchor), an "Unanchor" button, and its rotation controls are
   disabled — rotation is derived from the wall while anchored. */
const ANCHOR_EDGE_LABELS = {back:"Back", front:"Front", left:"Left side", right:"Right side"};
function nearestWallReadout(f, o){
  const room=f.rooms.find(r=>r.id===o.roomId); if(!room) return null;
  let best=null;
  loopWallKeys(room.loop).forEach(k=>{
    if(!k) return; const d=defaultAnchorFor(f,o,k); if(!d) return;
    if(!best || d.rawGap<best.rawGap) best=d;
  });
  return best;
}
function objectAnchorSectionHtml(f, o){
  const a=o.anchor;
  if(!a){
    const near=nearestWallReadout(f,o);
    return `<div style="border-top:1px solid var(--panel-line);margin-top:12px;padding-top:12px">
      <span class="field-label">Wall anchor</span>
      <div class="muted">Free${near?` · nearest wall ${fmtInches(Math.max(0,near.rawGap))} away (${esc(ANCHOR_EDGE_LABELS[near.anchor.edge].toLowerCase())} edge)`:""}</div>
      <div class="btngrid" style="margin-top:8px"><button class="btn" id="objAnchor" ${o.roomId?"":"disabled"}>Measure from wall…</button></div>
      <p class="muted" style="margin-top:4px">${o.roomId
        ? "Click this, then a wall of the object's room: it stays that far from the wall and follows it when the wall moves. Dropping it flush against a wall also anchors it."
        : "Move it into a room first — it can only be anchored to its own room's walls."}</p>
    </div>`;
  }
  const fr=wallFrame(f,a.wall);
  const opts=Object.keys(ANCHOR_EDGE_LABELS).map(e=>`<option value="${e}">${esc(ANCHOR_EDGE_LABELS[e])}</option>`).join("");
  return `<div style="border-top:1px solid var(--panel-line);margin-top:12px;padding-top:12px">
      <span class="field-label">Wall anchor</span>
      <div class="muted">${esc(wallIdForKey(a.wall))}${fr?` · ${fmtFt(fr.len)} long`:""}</div>
      <span class="field-label" style="margin-top:8px;display:block">Edge facing the wall</span>
      <select id="objAnchorEdge">${opts}</select>
      <div class="pair" style="margin-top:8px">
        <div><span class="field-label">Center from ${esc(fr?fr.lo:"")}</span><input type="text" id="objAnchorAlong" value="${fmtFt(a.along)}"></div>
        <div><span class="field-label">Gap from wall</span><input type="text" id="objAnchorGap" value="${fmtFt(a.gap)}"></div>
      </div>
      <div class="btngrid" style="margin-top:8px">
        <button class="btn primary" id="objAnchorApply">Apply</button>
        <button class="btn" id="objUnanchor">Unanchor</button>
      </div>
      <p class="muted" style="margin-top:4px">${fmtInches(a.gap)} from the wall's inside face. Drag it on the plan to slide it along / away from the wall; Unanchor makes it free again where it is.</p>
    </div>`;
}
function wireObjectAnchorSection(f, o){
  if(!o.anchor){
    const b=document.getElementById("objAnchor");
    if(b) b.onclick=()=>{ startPickWall(o.id); };
    return;
  }
  const a=o.anchor;
  const es=document.getElementById("objAnchorEdge"); es.value=a.edge;
  es.onchange=()=>{ if(es.value===a.edge) return; commit(()=>{ updateAnchor(f,o,{edge:es.value}); }); };
  const apply=()=>{
    // an untouched field keeps the exact stored value (inputs show it rounded to the inch)
    const av=document.getElementById("objAnchorAlong").value, gv=document.getElementById("objAnchorGap").value;
    const al = av===fmtFt(a.along) ? a.along : parseLen(av), gp = gv===fmtFt(a.gap) ? a.gap : parseLen(gv);
    if(isNaN(al) || isNaN(gp)){ setReadout("Anchor","enter a center offset and a gap (e.g. 3' 6\")"); return; }
    const fr=wallFrame(f,a.wall); if(!fr) return;
    const nal=_r6(Math.max(0,Math.min(fr.len,al))), ngp=_r6(Math.max(0,gp));
    if(Math.abs(nal-a.along)<1e-9 && Math.abs(ngp-a.gap)<1e-9){ renderInspector(); return; }   // no-op: no undo entry
    commit(()=>{ updateAnchor(f,o,{along:al, gap:gp}); });
    if(Math.abs(nal-al)>1e-6 || Math.abs(ngp-gp)>1e-6) setReadout("Anchor","clamped: the center stays on the wall and the gap can't be negative");
  };
  document.getElementById("objAnchorApply").onclick=apply;
  ["objAnchorAlong","objAnchorGap"].forEach(id=>{ document.getElementById(id).onkeydown=e=>{ if(e.key==="Enter"){ e.preventDefault(); apply(); } }; });
  document.getElementById("objUnanchor").onclick=()=>{ commit(()=>{ unanchorObject(o); }); };
}

function renderObjectInspector(f, body){
  const o=(f.objects||[]).find(x=>x.id===sel.id); if(!o){clearSel();return;}
  const def=fixtureTypeDef(o.type);
  const room=f.rooms.find(r=>r.id===o.roomId);
  const anchored=!!o.anchor, dis=anchored?"disabled":"";
  body.innerHTML = `
    <div class="kicker">${esc((def?def.label:o.type).toUpperCase())} · ${esc(o.id)}</div>
    <span class="field-label">Room</span>
    <div class="muted">${room?esc(room.name):"Not in any room"}</div>
    <div style="height:8px"></div>
    <span class="field-label">Position (X · Y), feet from origin</span>
    <div class="bigval" style="font-size:16px">${fmtFt(o.x)} · ${fmtFt(o.y)}</div>
    <span class="field-label">Size (W × D)</span>
    <div class="pair">
      <div><span class="field-label">Width</span><input type="text" id="objW" value="${fmtFt(o.w)}"></div>
      <div><span class="field-label">Depth</span><input type="text" id="objD" value="${fmtFt(o.d)}"></div>
    </div>
    <div class="btngrid" style="margin-top:8px"><button class="btn primary" id="objApplySize">Apply size</button></div>
    <div style="border-top:1px solid var(--panel-line);margin-top:12px;padding-top:12px">
      <span class="field-label">Rotation (°)</span>
      <div class="pair">
        <div><input type="text" id="objRot" value="${+(o.rot||0).toFixed(1)}" ${dis}></div>
        <div style="display:flex;align-items:flex-end"><button class="btn" id="objRot90" style="width:100%" ${dis}>Rotate 90°</button></div>
      </div>
      <div class="btngrid" style="margin-top:8px"><button class="btn primary" id="objApplyRot" ${dis}>Apply rotation</button></div>
      ${anchored?`<p class="muted" style="margin-top:4px">Rotation follows the wall while anchored — pick a different edge below, or Unanchor to rotate freely.</p>`:""}
      <label class="toggle row" style="margin-top:10px"><input type="checkbox" id="objMirror" ${o.mirror?"checked":""}><span>Mirror</span></label>
    </div>
    ${objectAnchorSectionHtml(f, o)}
    <div class="btngrid" style="margin-top:12px"><button class="btn danger" id="objDel">Delete</button></div>
    <p class="muted" style="margin-top:8px">${anchored
      ? "Dragging it on the plan keeps it anchored: it slides along the wall and away from it."
      : "Drag it on the plan to move it; dropping it inside a room reassigns which room it belongs to."}</p>`;
  wireObjectAnchorSection(f, o);
  const applySize=()=>{
    const wv=document.getElementById("objW").value, dv=document.getElementById("objD").value;
    const w = wv===fmtFt(o.w) ? o.w : parseLen(wv);
    const d = dv===fmtFt(o.d) ? o.d : parseLen(dv);
    if(isNaN(w)||isNaN(d)||w<=0||d<=0){ setReadout("Object","enter a positive width and depth"); return; }
    if(Math.abs(w-o.w)<1e-9 && Math.abs(d-o.d)<1e-9) return;   // no-op: no undo entry
    commit(()=>{ o.w=w; o.d=d; });
  };
  document.getElementById("objApplySize").onclick=applySize;
  ["objW","objD"].forEach(id=>{ document.getElementById(id).onkeydown=e=>{ if(e.key==="Enter"){ e.preventDefault(); applySize(); } }; });
  const applyRot=()=>{
    if(o.anchor) return;   // derived from the wall while anchored
    const v=parseFloat(document.getElementById("objRot").value);
    if(isNaN(v)){ setReadout("Object","enter a rotation in degrees"); return; }
    const norm=((v%360)+360)%360;
    if(Math.abs(norm-(o.rot||0))<1e-9) return;   // no-op: no undo entry
    commit(()=>{ o.rot=norm; });
  };
  document.getElementById("objApplyRot").onclick=applyRot;
  document.getElementById("objRot").onkeydown=e=>{ if(e.key==="Enter"){ e.preventDefault(); applyRot(); } };
  document.getElementById("objRot90").onclick=()=>{ if(o.anchor) return; commit(()=>{ o.rot=(((o.rot||0)+90)%360+360)%360; }); };
  document.getElementById("objMirror").onchange=e=>{ commit(()=>{ o.mirror=e.target.checked; }); };
  document.getElementById("objDel").onclick=()=>{ commit(()=>{ removeObject(f,o.id); sel={type:null,id:null}; }); };
  setReadout(def?def.label:o.type, o.anchor ? anchorReadout(o.anchor) : `${fmtFt(o.w)} × ${fmtFt(o.d)}${room?" · "+room.name:" · not in a room"}`);
}

/* Set the interior angle at V (within room) by rotating one adjacent edge about V. */
function setCornerAngle(f, room, V, deg){
  const nb=cornerNeighbors(f,room,V); if(!nb) return false;
  const locked=lockedPointIds(f);
  let moving=nb.N, fixed=nb.P;
  if(locked.has(moving)){ if(locked.has(fixed)){ alert("Both adjacent corners are locked — unlock one to set this angle."); return false; } moving=nb.P; fixed=nb.N; }
  const v=ptOf(f,V), fx=ptOf(f,fixed), mv=ptOf(f,moving);
  const ax=fx.x-v.x, ay=fx.y-v.y;                  // fixed edge direction
  const mx=mv.x-v.x, my=mv.y-v.y; const lenM=Math.hypot(mx,my); if(lenM<1e-6) return false;
  const la=Math.hypot(ax,ay)||1; const ua={x:ax/la, y:ay/la};
  const cross=ax*my-ay*mx; const sign=cross>=0?1:-1;
  const phi=sign*deg*Math.PI/180;
  const dirx=ua.x*Math.cos(phi)-ua.y*Math.sin(phi);
  const diry=ua.x*Math.sin(phi)+ua.y*Math.cos(phi);
  commit(()=>{ mv.x=snapInch(v.x+dirx*lenM); mv.y=snapInch(v.y+diry*lenM); });
  return true;
}
