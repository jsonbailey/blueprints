"use strict";

/* renderInspector dispatches on sel.type via a lookup table — each selection
   type owns its own render function, so adding a new type later (upcoming:
   `object`, `opening`) is "add one more table entry," not another branch in
   a growing if-chain. */
const INSPECTOR_RENDERERS = {
  wall: renderWallInspector,
  point: renderPointInspector,
  room: renderRoomInspector,
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

function renderWallInspector(f, body){
  const w=wallById(f,sel.id); if(!w){clearSel();return;}
  const a=ptOf(f,w.a), b=ptOf(f,w.b);
  const len=Math.hypot(b.x-a.x,b.y-a.y);
  const horiz = Math.abs(b.x-a.x) >= Math.abs(b.y-a.y);
  body.innerHTML = `
    <div class="kicker">WALL · ${w.id}</div>
    <span class="field-label">Length</span>
    <div class="bigval">${fmtFt(len)}</div>
    <span class="field-label">Set length (e.g. 13' 7" or 13.58)</span>
    <input type="text" id="lenInput" value="${fmtFt(len)}">
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
    </div>`;
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
  setReadout("Wall", fmtFt(len));
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

function renderRoomInspector(f, body){
  const r=f.rooms.find(x=>x.id===sel.id); if(!r){clearSel();return;}
  const area=polyArea(f,r.loop);
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  r.loop.forEach(id=>{const p=ptOf(f,id);minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);});
  body.innerHTML = `
    <div class="kicker">ROOM</div>
    <span class="field-label">Room name</span>
    <input type="text" id="roomName" value="${esc(r.name)}">
    <div style="height:10px"></div>
    <span class="field-label">Floor area</span>
    <div class="bigval">${Math.round(area)} sf</div>
    <span class="field-label">Bounding size (W · H)</span>
    <div class="bigval" style="font-size:16px">${fmtFt(maxX-minX)} · ${fmtFt(maxY-minY)}</div>
    <p class="muted">Drag the room's name on the plan to move the whole room; it snaps onto nearby corners. Shared corners pull their neighbours along.</p>
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
  rn.oninput=()=>{ r.name=rn.value; render(); };           // live label update, keeps focus
  rn.onchange=()=>renderInspector();                        // refresh header on blur/enter
  body.querySelectorAll("[data-nudge]").forEach(btn=>{
    btn.onclick=()=>nudgeRoom(r, btn.dataset.nudge);
  });
  document.getElementById("detachRoom").onclick=()=>{ commit(()=>detachRoom(f,r)); };
  document.getElementById("delRoom").onclick=()=>{
    if(!confirm(`Delete "${r.name}"?`)) return;
    commit(()=>{ f.rooms=f.rooms.filter(x=>x.id!==r.id); gcPoints(f); deriveWalls(f); sel={type:null,id:null}; });
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

function nudgeRoom(r, dir){
  const f=activeLevel(); const step = opts.snap>0 ? opts.snap : 0.25;
  const dx = dir==="left"?-step:dir==="right"?step:0;
  const dy = dir==="up"?-step:dir==="down"?step:0;
  commit(()=>{ [...new Set(r.loop)].forEach(id=>{const p=ptOf(f,id); p.x+=dx; p.y+=dy;}); });
}

function applyLength(w){
  const f=activeLevel();
  const val=parseLen(document.getElementById("lenInput").value);
  if(isNaN(val)||val<=0) return;
  const a=ptOf(f,w.a), b=ptOf(f,w.b);
  let dx=b.x-a.x, dy=b.y-a.y; const cur=Math.hypot(dx,dy);
  if(cur<1e-6){ dx=1; dy=0; } else { dx/=cur; dy/=cur; }
  commit(()=>{
    if(movingEnd==="b"){ b.x=a.x+dx*val; b.y=a.y+dy*val; }
    else               { a.x=b.x-dx*val; a.y=b.y-dy*val; }
  });
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
  f.rooms.forEach(r=>{ if(r.loop.includes(id)) r.loop = r.loop.filter(x=>x!==id); });
  gcPoints(f); deriveWalls(f);
  return true;
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
