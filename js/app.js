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
let snapViz = null;   // transient drag-time snap feedback {targetId?, vx?, vy?}

/* ---------- selection + inspector ---------- */
function selectWall(id){ sel={type:"wall",id}; render(); renderInspector(); }
function selectPoint(id){ sel={type:"point",id}; render(); renderInspector(); }
function selectRoom(id){ sel={type:"room",id}; render(); renderInspector(); }
function clearSel(){ sel={type:null,id:null}; render(); renderInspector(); }

function setReadout(label,val){
  document.getElementById("readoutLabel").textContent=label;
  document.getElementById("readout").textContent=val;
}

function applySnap(v){ return opts.snap>0 ? Math.round(v/opts.snap)*opts.snap : v; }

function addRoom(){
  const f=activeLevel();
  snapshot();
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
  render(); renderInspector();
}

/* ---------- dragging: corners and whole walls ---------- */
let drag=null;       // corner drag
let wallDrag=null;   // whole-wall slide (locked to perpendicular axis)
let roomDrag=null;   // whole-room move (free in both axes)
const DRAG_PX = 3;   // movement before a press counts as a drag (vs. a click)
const SNAP_PX = 12;  // pixel radius for connection/alignment snapping

function svgBox(){ return svg.getBoundingClientRect(); }
function pastThreshold(d,e){
  if(d.active) return true;
  if(Math.hypot(e.clientX-d.startClient.x, e.clientY-d.startClient.y) > DRAG_PX){ d.active=true; return true; }
  return false;
}

function startDragPoint(e,id){
  e.stopPropagation();
  const f=activeLevel(); const p=ptOf(f,id);
  selectPoint(id);
  if(lockedPointIds(f).has(id)){ setReadout("Locked","corner belongs to a locked room"); return; }
  drag={id, startClient:{x:e.clientX,y:e.clientY},
        startWorld:toWorld(e.clientX-svgBox().left, e.clientY-svgBox().top),
        startPt:{x:p.x,y:p.y}, preState:captureState(), committed:false, active:false};
  svg.setPointerCapture(e.pointerId);
}

function startDragRoom(e,roomId){
  e.stopPropagation();
  const f=activeLevel(); const room=f.rooms.find(r=>r.id===roomId); if(!room) return;
  selectRoom(roomId);
  if(room.locked){ setReadout("Locked","unlock this room to move it"); return; }
  // Move every corner of the room by the same offset. Shared corners carry
  // their neighbours along, so adjacent rooms stretch to stay attached.
  const ids=[...new Set(room.loop)];
  const starts=ids.map(id=>{const p=ptOf(f,id);return {id,x:p.x,y:p.y};});
  roomDrag={ roomId, starts, ref:{x:starts[0].x,y:starts[0].y},
    startClient:{x:e.clientX,y:e.clientY},
    startWorld:toWorld(e.clientX-svgBox().left,e.clientY-svgBox().top),
    preState:captureState(), committed:false, active:false };
  svg.setPointerCapture(e.pointerId);
}

function startDragWall(e,id){
  e.stopPropagation();
  const f=activeLevel(); const w=wallById(f,id); if(!w) return;
  selectWall(id);
  const locked=lockedPointIds(f);
  if(locked.has(w.a) && locked.has(w.b)){ setReadout("Locked","wall belongs to a locked room"); return; }
  const a=ptOf(f,w.a), b=ptOf(f,w.b);
  // The wall's dominant orientation picks the single allowed motion axis:
  // a mostly-horizontal wall slides vertically; a mostly-vertical wall slides
  // horizontally. The wall stays parallel and its attached sides stretch evenly.
  const horiz = Math.abs(b.x-a.x) >= Math.abs(b.y-a.y);
  wallDrag={ id, axis: horiz ? "y" : "x",
    aId:w.a, bId:w.b, aStart:{x:a.x,y:a.y}, bStart:{x:b.x,y:b.y},
    startClient:{x:e.clientX,y:e.clientY},
    startWorld:toWorld(e.clientX-svgBox().left, e.clientY-svgBox().top),
    preState:captureState(), committed:false, active:false };
  svg.setPointerCapture(e.pointerId);
}

/* ---------- pan + zoom + global pointer handling ---------- */
let pan=null;
svg.addEventListener("pointerdown",(e)=>{
  // Active walls + corner handles call stopPropagation, so anything reaching
  // here is empty space / a fill / a shadow level — start a pan.
  clearSel();
  pan={x:e.clientX,y:e.clientY,ox:view.ox,oy:view.oy};
  svg.classList.add("panning");
  svg.setPointerCapture(e.pointerId);
});
svg.addEventListener("pointermove",(e)=>{
  const bx=svgBox();
  if(drag){
    if(!pastThreshold(drag,e)) return;
    commitCaptured(drag);
    const [wx,wy]=toWorld(e.clientX-bx.left,e.clientY-bx.top);
    const f=activeLevel(); const p=ptOf(f,drag.id);
    let nx=applySnap(drag.startPt.x + (wx-drag.startWorld[0]));
    let ny=applySnap(drag.startPt.y + (wy-drag.startWorld[1]));
    drag.snapTarget=null; drag.snapEdge=null; snapViz=null;
    if(opts.snapConnect && !e.altKey){
      const s=computeSnap(f, drag.id, nx, ny);
      nx=s.x; ny=s.y; drag.snapTarget=s.targetId; drag.snapEdge=s.edge;
      snapViz={targetId:s.targetId, edge:s.edge, gx:s.gx, gy:s.gy};
    }
    p.x=nx; p.y=ny;
    render();
    setReadout((drag.snapTarget||drag.snapEdge)?"Corner → connect":"Corner", `${fmtFt(p.x)} · ${fmtFt(p.y)}`);
    return;
  }
  if(wallDrag){
    if(!pastThreshold(wallDrag,e)) return;
    commitCaptured(wallDrag);
    const [wx,wy]=toWorld(e.clientX-bx.left,e.clientY-bx.top);
    const f=activeLevel(); const a=ptOf(f,wallDrag.aId), b=ptOf(f,wallDrag.bId);
    let delta;
    if(wallDrag.axis==="y"){
      delta = applySnap(wallDrag.aStart.y + (wy-wallDrag.startWorld[1])) - wallDrag.aStart.y;
      a.y=wallDrag.aStart.y+delta; b.y=wallDrag.bStart.y+delta;
    } else {
      delta = applySnap(wallDrag.aStart.x + (wx-wallDrag.startWorld[0])) - wallDrag.aStart.x;
      a.x=wallDrag.aStart.x+delta; b.x=wallDrag.bStart.x+delta;
    }
    render();
    const dir = wallDrag.axis==="y" ? (delta<0?"up":"down") : (delta<0?"left":"right");
    setReadout("Wall moved", `${fmtFt(Math.abs(delta))} ${Math.abs(delta)<1e-6?"":dir}`);
    return;
  }
  if(roomDrag){
    if(!pastThreshold(roomDrag,e)) return;
    commitCaptured(roomDrag);
    const [wx,wy]=toWorld(e.clientX-bx.left,e.clientY-bx.top);
    let dx = applySnap(roomDrag.ref.x + (wx-roomDrag.startWorld[0])) - roomDrag.ref.x;
    let dy = applySnap(roomDrag.ref.y + (wy-roomDrag.startWorld[1])) - roomDrag.ref.y;
    const f=activeLevel();
    snapViz=null;
    if(opts.snapConnect && !e.altKey){
      const s=computeRoomSnap(f, roomDrag.starts, dx, dy);
      dx=s.dx; dy=s.dy;
      snapViz={targetId:s.targetId, gx:s.gx, gy:s.gy};
    }
    roomDrag.starts.forEach(s=>{ const p=ptOf(f,s.id); p.x=s.x+dx; p.y=s.y+dy; });
    render();
    setReadout(snapViz&&(snapViz.targetId||snapViz.gx!=null||snapViz.gy!=null)?"Room → connect":"Room moved", `${fmtFt(dx)} · ${fmtFt(dy)}`);
    return;
  }
  if(pan){
    view.ox = pan.ox + (e.clientX-pan.x);
    view.oy = pan.oy + (e.clientY-pan.y);
    render();
    return;
  }
  // idle: show cursor world coords
  if(sel.type==null){
    const [wx,wy]=toWorld(e.clientX-bx.left,e.clientY-bx.top);
    setReadout("Cursor", `${fmtFt(wx)} · ${fmtFt(wy)}`);
  }
});
function endPointer(e){
  if(drag){
    if(drag.active && drag.snapTarget){
      weldPoints(activeLevel(), drag.id, drag.snapTarget);
      sel={type:"point", id:drag.snapTarget};
    } else if(drag.active && drag.snapEdge){
      const f=activeLevel(); const p=ptOf(f,drag.id);
      const mid=insertPointOnWall(f, drag.snapEdge.a, drag.snapEdge.b, p.x, p.y);
      if(mid){ weldPoints(f, drag.id, mid); sel={type:"point", id:mid}; }
    }
    if(!drag.active) drag.preState=null;
    drag=null; snapViz=null; render(); renderInspector();
  }
  if(wallDrag){ wallDrag=null; renderInspector(); }
  if(roomDrag){
    if(roomDrag.active && opts.snapConnect){
      const f=activeLevel(); const inRoom=new Set(roomDrag.starts.map(s=>s.id)); const locked=lockedPointIds(f);
      for(const s of roomDrag.starts){
        const p=ptOf(f,s.id); if(!p) continue;
        let tgt=null;
        for(const q of f.points){
          if(inRoom.has(q.id) || locked.has(q.id)) continue;
          if(Math.hypot(q.x-p.x,q.y-p.y) <= MERGE_TOL){ tgt=q; break; }
        }
        if(tgt) weldPoints(f, s.id, tgt.id);
      }
    }
    roomDrag=null; snapViz=null; render(); renderInspector();
  }
  if(pan){ pan=null; svg.classList.remove("panning"); }
}
svg.addEventListener("pointerup",endPointer);
svg.addEventListener("pointercancel",endPointer);

svg.addEventListener("wheel",(e)=>{
  e.preventDefault();
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
/* Level tabs: one button per level plus "+" to add a level. Called from every
   render(); the buttons are only rebuilt when the level list (ids/names)
   changes, otherwise just aria-pressed is refreshed — so keyboard focus on a
   tab survives re-renders. Minimal by design; a richer level panel (per-level
   visibility toggles etc.) is a follow-up. */
const levelTabsEl = document.getElementById("levelTabs");
let _levelTabsSig = null;
function renderLevelTabs(){
  const activeId = activeLevel().id;
  const sig = JSON.stringify(data.levels.map(l=>[l.id,l.name]));
  if(sig !== _levelTabsSig){
    _levelTabsSig = sig;
    levelTabsEl.textContent = "";
    data.levels.forEach(l=>{
      const b=document.createElement("button");
      b.className="leveltab"; b.dataset.level=l.id; b.textContent=l.name;
      b.title="Double-click to rename";
      b.onclick=()=>setLevel(l.id);
      b.ondblclick=()=>renameLevel(l.id);
      levelTabsEl.appendChild(b);
    });
    const add=document.createElement("button");
    add.className="leveltab add"; add.textContent="+";
    add.title="Add level"; add.setAttribute("aria-label","Add level");
    add.onclick=addLevel;
    levelTabsEl.appendChild(add);
  }
  levelTabsEl.querySelectorAll("[data-level]").forEach(b=>b.setAttribute("aria-pressed", String(b.dataset.level===activeId)));
}
function setLevel(id){
  if(!data.levels.some(l=>l.id===id)) return;
  data.activeLevelId=id; sel={type:null,id:null};
  render(); renderInspector();
}
function addLevel(){
  snapshot();
  const lvl = makeLevel("Level "+(data.levels.length+1), []);
  data.levels.push(lvl);
  setLevel(lvl.id);
}
function renameLevel(id){
  const l=data.levels.find(x=>x.id===id); if(!l) return;
  const name=prompt("Level name:", l.name);
  if(name==null || !name.trim() || name.trim()===l.name) return;
  snapshot(); l.name=name.trim(); render();
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
  loadData(JSON.parse(ORIGINAL)); sel={type:null,id:null}; render(); renderInspector();
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
      loadData(obj);
      commitCaptured({preState:pre, committed:false});
      setProjectName(obj.name); sel={type:null,id:null}; render(); renderInspector();
    }catch(err){
      alert(err && err.tooNew
        ? "That plan was saved by a newer version of this editor and can't be opened here."
        : "Couldn't read that file — it doesn't look like a saved plan.");
    }
  };
  reader.readAsText(file); e.target.value="";
};

document.addEventListener("keydown",(e)=>{
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="z"){ e.preventDefault(); undo(); }
  if(e.key==="Escape") clearSel();
});

window.addEventListener("resize", render);

/* ---------- go ---------- */
fit();
render();            // fit() skips rendering on a blank plan; this also builds the level tabs
renderInspector();
