"use strict";

/* =========================================================================
   Interaction state machine (see ARCHITECTURE.md, "js/tools.js").

   Exactly one pointer interaction can be in progress at a time, held in
   `interaction` (null when idle). Its `kind` picks an entry in
   `interactionHandlers`, and js/app.js's pointer listeners are short
   dispatchers into that table — adding a new mode means adding one table
   entry, not another branch in a shared if-chain.

   Handler shape (every method receives the live interaction object `it`
   plus the DOM event):
     move(it, e)  — pointermove while this interaction is active
     end(it, e)   — pointerup / pointercancel; responsible for clearing
                    `interaction` when the gesture is over

   Loaded after render.js/inspector.js and BEFORE app.js: app.js's startup
   code calls render(), which reads `snapViz` (declared here), so this file's
   top-level bindings must already exist by then.
   ========================================================================= */

let interaction = null;  // {kind:"point"|"wall"|"room"|"pan", ...} or null
let snapViz = null;      // transient drag-time snap feedback {targetId?, edge?, gx?, gy?}
const DRAG_PX = 3;       // movement before a press counts as a drag (vs. a click)
const SNAP_PX = 12;      // pixel radius for connection/alignment snapping

function svgBox(){ return svg.getBoundingClientRect(); }
function eventWorld(e){ const bx=svgBox(); return toWorld(e.clientX-bx.left, e.clientY-bx.top); }
function pastThreshold(d,e){
  if(d.active) return true;
  if(Math.hypot(e.clientX-d.startClient.x, e.clientY-d.startClient.y) > DRAG_PX){ d.active=true; return true; }
  return false;
}

/* ---------- gesture entry points (wired from js/render.js / js/app.js) ---------- */

function startDragPoint(e,id){
  e.stopPropagation();
  const f=activeLevel(); const p=ptOf(f,id);
  selectPoint(id);
  if(lockedPointIds(f).has(id)){ setReadout("Locked","corner belongs to a locked room"); return; }
  interaction={kind:"point", id, startClient:{x:e.clientX,y:e.clientY},
        startWorld:eventWorld(e),
        startPt:{x:p.x,y:p.y}, preState:captureState(), committed:false, active:false,
        snapTarget:null, snapEdge:null};
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
  interaction={kind:"room", roomId, starts, ref:{x:starts[0].x,y:starts[0].y},
    startClient:{x:e.clientX,y:e.clientY},
    startWorld:eventWorld(e),
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
  interaction={kind:"wall", id, axis: horiz ? "y" : "x",
    aId:w.a, bId:w.b, aStart:{x:a.x,y:a.y}, bStart:{x:b.x,y:b.y},
    startClient:{x:e.clientX,y:e.clientY},
    startWorld:eventWorld(e),
    preState:captureState(), committed:false, active:false };
  svg.setPointerCapture(e.pointerId);
}

/* Empty space / a fill / a shadow level: walls, corners and room labels call
   stopPropagation, so anything reaching the svg's own pointerdown pans. */
function startPan(e){
  interaction={kind:"pan", x:e.clientX, y:e.clientY, ox:view.ox, oy:view.oy};
  svg.classList.add("panning");
  svg.setPointerCapture(e.pointerId);
}

/* ---------- handler table ---------- */

const interactionHandlers = {
  /* corner drag: grid snap, then connect-snap onto a corner / wall line /
     alignment guide; welds (or T-splits a wall) on release */
  point: {
    move(it,e){
      if(!pastThreshold(it,e)) return;
      commitCaptured(it);
      const [wx,wy]=eventWorld(e);
      const f=activeLevel(); const p=ptOf(f,it.id);
      let nx=applySnap(it.startPt.x + (wx-it.startWorld[0]));
      let ny=applySnap(it.startPt.y + (wy-it.startWorld[1]));
      it.snapTarget=null; it.snapEdge=null; snapViz=null;
      if(opts.snapConnect && !e.altKey){
        const s=computeSnap(f, it.id, nx, ny);
        nx=s.x; ny=s.y; it.snapTarget=s.targetId; it.snapEdge=s.edge;
        snapViz={targetId:s.targetId, edge:s.edge, gx:s.gx, gy:s.gy};
      }
      p.x=nx; p.y=ny;
      render();
      setReadout((it.snapTarget||it.snapEdge)?"Corner → connect":"Corner", `${fmtFt(p.x)} · ${fmtFt(p.y)}`);
    },
    end(it){
      if(it.active && it.snapTarget){
        weldPoints(activeLevel(), it.id, it.snapTarget);
        sel={type:"point", id:it.snapTarget};
      } else if(it.active && it.snapEdge){
        const f=activeLevel(); const p=ptOf(f,it.id);
        const mid=insertPointOnWall(f, it.snapEdge.a, it.snapEdge.b, p.x, p.y);
        if(mid){ weldPoints(f, it.id, mid); sel={type:"point", id:mid}; }
      }
      if(!it.active) it.preState=null;
      interaction=null; snapViz=null; markDirty();
    },
  },

  /* whole-wall slide, locked to the wall's perpendicular axis */
  wall: {
    move(it,e){
      if(!pastThreshold(it,e)) return;
      commitCaptured(it);
      const [wx,wy]=eventWorld(e);
      const f=activeLevel(); const a=ptOf(f,it.aId), b=ptOf(f,it.bId);
      let delta;
      if(it.axis==="y"){
        delta = applySnap(it.aStart.y + (wy-it.startWorld[1])) - it.aStart.y;
        a.y=it.aStart.y+delta; b.y=it.bStart.y+delta;
      } else {
        delta = applySnap(it.aStart.x + (wx-it.startWorld[0])) - it.aStart.x;
        a.x=it.aStart.x+delta; b.x=it.bStart.x+delta;
      }
      render();
      const dir = it.axis==="y" ? (delta<0?"up":"down") : (delta<0?"left":"right");
      setReadout("Wall moved", `${fmtFt(Math.abs(delta))} ${Math.abs(delta)<1e-6?"":dir}`);
    },
    end(){
      interaction=null; renderInspector();
    },
  },

  /* whole-room translate (free in both axes), snapping the moved corners
     onto other corners / alignment guides; welds coincident corners on release */
  room: {
    move(it,e){
      if(!pastThreshold(it,e)) return;
      commitCaptured(it);
      const [wx,wy]=eventWorld(e);
      let dx = applySnap(it.ref.x + (wx-it.startWorld[0])) - it.ref.x;
      let dy = applySnap(it.ref.y + (wy-it.startWorld[1])) - it.ref.y;
      const f=activeLevel();
      snapViz=null;
      if(opts.snapConnect && !e.altKey){
        const s=computeRoomSnap(f, it.starts, dx, dy);
        dx=s.dx; dy=s.dy;
        snapViz={targetId:s.targetId, gx:s.gx, gy:s.gy};
      }
      it.starts.forEach(s=>{ const p=ptOf(f,s.id); p.x=s.x+dx; p.y=s.y+dy; });
      render();
      setReadout(snapViz&&(snapViz.targetId||snapViz.gx!=null||snapViz.gy!=null)?"Room → connect":"Room moved", `${fmtFt(dx)} · ${fmtFt(dy)}`);
    },
    end(it){
      if(it.active && opts.snapConnect){
        const f=activeLevel(); const inRoom=new Set(it.starts.map(s=>s.id)); const locked=lockedPointIds(f);
        for(const s of it.starts){
          const p=ptOf(f,s.id); if(!p) continue;
          let tgt=null;
          for(const q of f.points){
            if(inRoom.has(q.id) || locked.has(q.id)) continue;
            if(Math.hypot(q.x-p.x,q.y-p.y) <= MERGE_TOL){ tgt=q; break; }
          }
          if(tgt) weldPoints(f, s.id, tgt.id);
        }
      }
      interaction=null; snapViz=null; markDirty();
    },
  },

  /* view pan */
  pan: {
    move(it,e){
      view.ox = it.ox + (e.clientX-it.x);
      view.oy = it.oy + (e.clientY-it.y);
      render();
    },
    end(){
      interaction=null; svg.classList.remove("panning");
    },
  },
};
