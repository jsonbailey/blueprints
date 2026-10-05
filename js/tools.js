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
     down(it, e)  — optional: if present, this kind owns svg pointerdown
                    while active (the persistent draw tools)
     overlay(it)  — optional: returns an SVG <g> drawn on top by render()

   Loaded after render.js/inspector.js and BEFORE app.js: app.js's startup
   code calls render(), which reads `snapViz` (declared here), so this file's
   top-level bindings must already exist by then.
   ========================================================================= */

let interaction = null;  // {kind:"point"|"wall"|"room"|"opening"|"object"|"anchoredObject"|"pickWall"|"pan"|"rect"|"poly", ...} or null
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
  // Translate the whole welded cluster (every room transitively sharing a
  // corner with this one) by the same offset, so neighbours keep their shape
  // instead of stretching. Locked rooms bound the cluster — see
  // connectedRoomPoints in js/model.js.
  const cluster=connectedRoomPoints(f, roomId);
  const starts=cluster.ids.map(id=>{const p=ptOf(f,id);return {id,x:p.x,y:p.y};});
  if(!starts.length){ setReadout("Locked","every corner of this room is pinned by a locked room"); return; }
  // Carry along every FREE object (anchor==null — anchored objects follow
  // their wall via resolveObjects() instead, never this translate) whose
  // roomId is anywhere in the moved cluster, not just the room directly
  // dragged (ARCHITECTURE.md item 5: "carry a free object along whenever its
  // roomId is in that cluster's roomIds"). Starting positions are captured
  // once here, exactly like `starts` above, so repeated move() events apply
  // a consistent delta from the drag's origin rather than drifting.
  const objStarts=(f.objects||[])
    .filter(o=>o.anchor==null && cluster.roomIds.includes(o.roomId))
    .map(o=>({id:o.id, x:o.x, y:o.y}));
  interaction={kind:"room", roomId, starts, roomIds:cluster.roomIds, pinned:cluster.pinnedIds.length>0,
    objStarts,
    ref:{x:starts[0].x,y:starts[0].y},
    startClient:{x:e.clientX,y:e.clientY},
    startWorld:eventWorld(e),
    preState:captureState(), committed:false, active:false };
  svg.setPointerCapture(e.pointerId);
}

/* Press on a free object's plan symbol (js/render.js drawObjects): select it,
   and arm a free (unconstrained, grid-snapped) drag. On release, a point-in-
   polygon test against every room reassigns roomId — see the `object` kind's
   end() below. */
function startDragObject(e,id){
  e.stopPropagation();
  const f=activeLevel(); const o=(f.objects||[]).find(x=>x.id===id); if(!o) return;
  selectObject(id);
  if(o.anchor){
    // An anchored object drags in its wall's frame (along/gap), never freely
    // — see the `anchoredObject` kind. The frame and inward normal are
    // captured once: topology can't change mid-drag.
    const face=anchorFace(f, o.roomId, o.anchor.wall);
    if(face && face.side){
      interaction={kind:"anchoredObject", id, fr:face.fr, n:face.side.n,
        startAlong:o.anchor.along, startGap:o.anchor.gap,
        startClient:{x:e.clientX,y:e.clientY}, startWorld:eventWorld(e),
        preState:captureState(), committed:false, active:false};
      svg.setPointerCapture(e.pointerId);
    }
    return;
  }
  interaction={kind:"object", id, startClient:{x:e.clientX,y:e.clientY},
    startWorld:eventWorld(e), startPt:{x:o.x,y:o.y},
    preState:captureState(), committed:false, active:false};
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

/* Press on an opening's glyph (js/render.js drawOpenings): select it, and arm
   a drag that slides it along its own wall. The wall key is captured here
   (openings are addressed by {wallKey, id}); topology can't change mid-drag. */
function startDragOpening(e, key, id){
  e.stopPropagation();
  const f=activeLevel(); const o=findOpening(f,key,id); if(!o) return;
  selectOpening(key, id);
  interaction={kind:"opening", key, id, startAlong:o.along,
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
      resolveObjects(f);   // anchored objects follow their wall live
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
      resolveObjects(f);   // anchored objects follow their wall live
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
      // Carry along every free object captured in objStarts by this same
      // (post-snap) delta — see startDragRoom's comment.
      (it.objStarts||[]).forEach(s=>{ const o=(f.objects||[]).find(x=>x.id===s.id); if(o){ o.x=s.x+dx; o.y=s.y+dy; } });
      // ANCHORED objects are not in objStarts — they follow their (moved)
      // walls through resolveObjects instead, never both
      resolveObjects(f);
      render();
      setReadout(snapViz&&(snapViz.targetId||snapViz.gx!=null||snapViz.gy!=null)?"Room → connect":"Room moved",
        `${fmtFt(dx)} · ${fmtFt(dy)}${it.roomIds.length>1?` · ${it.roomIds.length} connected rooms`:""}${it.pinned?" · pinned by locked room":""}`);
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

  /* slide an opening along its wall: the pointer delta is projected onto the
     wall's lo → hi direction (so motion across the wall is ignored), the
     resulting center offset is grid-snapped (Alt bypasses), then moved to
     the nearest position that keeps the opening inside the wall and clear of
     its neighbours (nearestOpeningSlot — the same rule creation uses). The
     undo snapshot is pushed lazily, only once the offset actually changes. */
  opening: {
    move(it,e){
      if(!pastThreshold(it,e)) return;
      const f=activeLevel(); const o=findOpening(f,it.key,it.id); const fr=wallFrame(f,it.key);
      if(!o || !fr) return;
      const [wx,wy]=eventWorld(e);
      let want = it.startAlong + (wx-it.startWorld[0])*fr.dir.x + (wy-it.startWorld[1])*fr.dir.y;
      if(!e.altKey) want=applySnap(want);
      const slot=nearestOpeningSlot(openingsAt(f,it.key), want, o.width, fr.len, o.id);
      if(slot!=null && Math.abs(slot-o.along)>1e-9){
        commitCaptured(it);
        o.along=_r6(slot);
        render();
      }
      setReadout(openingLabel(o.type), `${fmtFt(o.along-o.width/2)} · ${fmtFt(fr.len-o.along-o.width/2)} to the wall ends`);
    },
    end(it){
      if(it.active && it.committed){
        const list=openingsAt(activeLevel(), it.key); list.sort((a,b)=>a.along-b.along);
      }
      if(!it.active) it.preState=null;
      interaction=null; markDirty();
    },
  },

  /* free (unanchored) object drag: grid-snapped move in both axes, no
     connect-snapping (objects don't weld to corners). On release, a
     point-in-polygon test against every room reassigns roomId — a plain
     field update, not a geometry change, so it still goes through the
     normal commitCaptured()/commit() flow like everything else here. */
  object: {
    move(it,e){
      if(!pastThreshold(it,e)) return;
      commitCaptured(it);
      const [wx,wy]=eventWorld(e);
      const f=activeLevel(); const o=(f.objects||[]).find(x=>x.id===it.id); if(!o) return;
      o.x = applySnap(it.startPt.x + (wx-it.startWorld[0]));
      o.y = applySnap(it.startPt.y + (wy-it.startWorld[1]));
      render();
      setReadout(fixtureLabel(o.type), `${fmtFt(o.x)} · ${fmtFt(o.y)}`);
    },
    end(it,e){
      if(it.active){
        const f=activeLevel(); const o=(f.objects||[]).find(x=>x.id===it.id);
        if(o){
          const r=roomContainingPoint(f,o.x,o.y); o.roomId = r?r.id:null;
          // auto-anchor: dropped flush against a wall of its (new) room
          if(!(e && e.altKey)){ const a=autoAnchorOnDrop(f,o); if(a) setReadout(fixtureLabel(o.type), "anchored to the wall it was dropped against"); }
        }
      }
      if(!it.active) it.preState=null;
      interaction=null; markDirty();
    },
  },

  /* anchored object drag: the pointer delta is split into the wall's lo→hi
     direction (→ along) and roomId's inward normal (→ gap), each grid-
     snapped (Alt bypasses); along is clamped to the wall's length and gap to
     >= 0 (an object never pushes through the wall face). Only the ANCHOR is
     edited — x/y/rot are re-derived by resolveObjects — and the anchor is
     never broken by a drag (that's the inspector's explicit Unanchor). Lazy
     undo: the snapshot is pushed only once along/gap actually change. */
  anchoredObject: {
    move(it,e){
      if(!pastThreshold(it,e)) return;
      const f=activeLevel(); const o=(f.objects||[]).find(x=>x.id===it.id);
      if(!o || !o.anchor) return;
      const [wx,wy]=eventWorld(e);
      const dx=wx-it.startWorld[0], dy=wy-it.startWorld[1];
      let along=it.startAlong + dx*it.fr.dir.x + dy*it.fr.dir.y;
      let gap=it.startGap + dx*it.n.x + dy*it.n.y;
      if(!e.altKey){ along=applySnap(along); gap=applySnap(gap); }
      along=_r6(Math.max(0, Math.min(it.fr.len, along)));
      gap=_r6(Math.max(0, gap));
      if(Math.abs(along-o.anchor.along)>1e-9 || Math.abs(gap-o.anchor.gap)>1e-9){
        commitCaptured(it);
        o.anchor.along=along; o.anchor.gap=gap;
        resolveObjects(f);
        render();
      }
      setReadout(fixtureLabel(o.type), anchorReadout(o.anchor));
    },
    end(it){
      if(!it.active) it.preState=null;
      interaction=null; markDirty();
    },
  },

  /* "Measure from wall…" (object inspector): a persistent pick mode — the
     next click on a wall of the object's room anchors the selected object to
     it with defaultAnchorFor's edge/along/gap (fine-tuned afterwards in the
     inspector). Owns pointerdown while active (like the draw tools), so the
     click doesn't start a wall drag; hovering highlights the wall it would
     pick. Esc cancels (js/app.js). */
  pickWall: {
    down(it,e){
      const f=activeLevel(); const o=(f.objects||[]).find(x=>x.id===it.objectId);
      if(!o || o.anchor){ cancelPickWall(); return; }
      const w=pickableWallAt(f, o, eventWorld(e));
      if(!w){
        const near=wallNearPoint(f, eventWorld(e));
        setReadout("Measure from wall", near
          ? (isOpenWall(f,near) ? "that edge is open (no wall) — pick a real wall" : "pick a wall of this object's own room")
          : "click a wall of the object's room · Esc cancels");
        return;
      }
      exitPickWall();
      commit(()=>{ anchorObject(f, o, wallKeyOf(w)); sel={type:"object", id:o.id}; });
      if(o.anchor) setReadout(fixtureLabel(o.type), anchorReadout(o.anchor));
    },
    move(it,e){
      const f=activeLevel(); const o=(f.objects||[]).find(x=>x.id===it.objectId);
      const w=o && pickableWallAt(f, o, eventWorld(e));
      snapViz = w ? {edge:{a:w.a, b:w.b}} : null;
      render();
    },
    end(){},
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

  /* N: rectangle tool. Click corner A, click corner B. */
  rect: {
    down(it,e){
      const q=snapDrawPoint(e, eventWorld(e));
      if(!it.a){
        it.a=q; it.cur=q;
        setReadout("Rectangle","click the opposite corner · Esc to cancel");
        render(); return;
      }
      if(Math.abs(q.x-it.a.x)<MIN_SEG || Math.abs(q.y-it.a.y)<MIN_SEG){
        setReadout("Rectangle","too thin — click farther from the first corner"); return;
      }
      const x0=Math.min(it.a.x,q.x), x1=Math.max(it.a.x,q.x), y0=Math.min(it.a.y,q.y), y1=Math.max(it.a.y,q.y);
      const weld=it.a.weld && q.weld;
      // top-left → top-right → bottom-right → bottom-left: positive signed
      // area, the same winding addRoom() uses (see signedAreaXY)
      createDrawnRoom([{x:x0,y:y0,weld},{x:x1,y:y0,weld},{x:x1,y:y1,weld},{x:x0,y:y1,weld}]);
    },
    move(it,e){
      const q=snapDrawPoint(e, eventWorld(e));
      it.cur=q; snapViz=q.viz; render();
      if(it.a) setReadout("Rectangle", `${fmtFt(Math.abs(q.x-it.a.x))} × ${fmtFt(Math.abs(q.y-it.a.y))}`);
      else setReadout("Rectangle · first corner", `${fmtFt(q.x)} · ${fmtFt(q.y)}`);
    },
    end(){},   // the tool outlives each click's pointerup
    overlay(it){
      const g=el("g",{"pointer-events":"none"});
      if(it.a && it.cur){
        const [ax,ay]=toScreen(it.a.x,it.a.y), [bx,by]=toScreen(it.cur.x,it.cur.y);
        g.appendChild(el("polygon",{points:`${ax},${ay} ${bx},${ay} ${bx},${by} ${ax},${by}`,
          fill:"rgba(206,59,35,0.08)",stroke:"var(--markup)","stroke-width":2,"stroke-dasharray":"6 4"}));
        g.appendChild(el("circle",{cx:ax,cy:ay,r:4.5,fill:"var(--markup)"}));
      }
      if(it.cur){ const [cx,cy]=toScreen(it.cur.x,it.cur.y); g.appendChild(el("circle",{cx,cy,r:4,fill:"none",stroke:"var(--markup)","stroke-width":1.5})); }
      return g;
    },
  },

  /* Shift+N: freeform tool. Click each vertex; segments are axis-locked
     unless Ctrl/Cmd is held; finishes only by clicking the first vertex. */
  poly: {
    down(it,e){
      const q=polyCandidate(it,e);
      if(q.close){
        if(it.verts.length<3){ setReadout("Freeform","place at least 3 corners before closing the shape"); return; }
        finishPoly(it); return;
      }
      const last=it.verts[it.verts.length-1];
      if(last && Math.hypot(q.x-last.x,q.y-last.y)<MIN_SEG) return;   // repeat click on the same spot
      it.verts.push({x:q.x, y:q.y, weld:q.weld});
      it.cur=q;
      setReadout("Freeform", `${it.verts.length} corner${it.verts.length>1?"s":""} · click the first corner to finish · Ctrl/Cmd: free angle · Esc cancels`);
      render();
    },
    move(it,e){
      const q=polyCandidate(it,e);
      it.cur=q; snapViz=q.viz; render();
      const last=it.verts[it.verts.length-1];
      if(q.close) setReadout("Freeform", it.verts.length>=3 ? "click to close the shape" : "need at least 3 corners to close");
      else if(last) setReadout(q.free?"Freeform · free angle":"Freeform", fmtFt(Math.hypot(q.x-last.x,q.y-last.y)));
      else setReadout("Freeform · first corner", `${fmtFt(q.x)} · ${fmtFt(q.y)}`);
    },
    end(){},
    overlay(it){
      const g=el("g",{"pointer-events":"none"});
      const vs=it.verts.map(v=>toScreen(v.x,v.y));
      if(vs.length>1) g.appendChild(el("polyline",{points:vs.map(p=>p.join(",")).join(" "),fill:"none",stroke:"var(--markup)","stroke-width":2.4,"stroke-linecap":"round","stroke-linejoin":"round"}));
      if(vs.length && it.cur){
        const [cx,cy]=toScreen(it.cur.x,it.cur.y), [lx,ly]=vs[vs.length-1];
        g.appendChild(el("line",{x1:lx,y1:ly,x2:cx,y2:cy,stroke:"var(--markup)","stroke-width":2,"stroke-dasharray":"6 4"}));
      }
      vs.forEach(([x,y],i)=>{
        if(i===0){
          const hot = it.cur && it.cur.close;
          g.appendChild(el("circle",{cx:x,cy:y,r:hot?9:7,fill:hot?"rgba(206,59,35,0.25)":"none",stroke:"var(--markup)","stroke-width":2}));
        }
        g.appendChild(el("circle",{cx:x,cy:y,r:3.5,fill:"var(--markup)"}));
      });
      if(it.cur && !it.cur.close){ const [cx,cy]=toScreen(it.cur.x,it.cur.y); g.appendChild(el("circle",{cx,cy,r:4,fill:"none",stroke:"var(--markup)","stroke-width":1.5})); }
      return g;
    },
  },
};

/* ---------- wall anchoring helpers (ARCHITECTURE.md item 5, anchored half) ---------- */

/* Live readout for an anchor, e.g. `42" from wall · center 5'0" along`. */
function fmtInches(ft){ return (+(ft*12).toFixed(1))+'"'; }
function anchorReadout(a){ return `${fmtInches(a.gap)} from wall · center ${fmtFt(a.along)} along`; }

/* Nearest wall to world point `pt` ([x,y]) within a click tolerance: the
   SNAP_PX screen radius, or half the wall's band if that is wider (so a
   click anywhere on a thick wall counts). `accept(w)` filters candidates. */
function wallNearPoint(f, pt, accept){
  const [x,y]=pt; let best=null, bd=Infinity;
  for(const w of f.walls){
    if(accept && !accept(w)) continue;
    const A=ptOf(f,w.a), B=ptOf(f,w.b); if(!A || !B) continue;
    const pr=projectPointSeg(x,y,A.x,A.y,B.x,B.y), d=Math.hypot(pr.x-x, pr.y-y);
    const tol=Math.max(SNAP_PX/view.scale, effThickness(f,w)/2);
    if(d<=tol && d<bd){ bd=d; best=w; }
  }
  return best;
}
/* A wall object `o` could be anchored to at `pt` (an edge of its own room,
   not open, not degenerate — whatever defaultAnchorFor accepts). */
function pickableWallAt(f, o, pt){
  return wallNearPoint(f, pt, w=>!!defaultAnchorFor(f, o, wallKeyOf(w)));
}

function pickWallActive(){ return !!interaction && interaction.kind==="pickWall"; }
/* Enter the pick-wall mode for a FREE object (the inspector's "Measure from
   wall…"). Refused mid-drag / while another tool is active, and for an
   object with no room (an anchor's wall must be an edge of its roomId). */
function startPickWall(objectId){
  if(interaction) return false;
  const f=activeLevel(); const o=(f.objects||[]).find(x=>x.id===objectId);
  if(!o || o.anchor) return false;
  if(!o.roomId){ setReadout("Measure from wall","move the object into a room first — it can only measure from its own room's walls"); return false; }
  interaction={kind:"pickWall", objectId};
  snapViz=null;
  svg.classList.add("drawing");
  setReadout("Measure from wall","click a wall of the object's room · Esc cancels");
  return true;
}
function exitPickWall(){
  interaction=null; snapViz=null;
  svg.classList.remove("drawing");
}
/* Esc: leave the pick mode without anchoring. Returns whether it was active. */
function cancelPickWall(){
  if(!pickWallActive()) return false;
  exitPickWall(); render();
  setReadout("Measure from wall","cancelled");
  return true;
}

/* Auto-anchor on drop (ARCHITECTURE.md item 5's optional nicety): a free
   object released within snap tolerance of a wall of its own room — some
   box edge within SNAP_PX (in world units, the same radius computeSnap uses
   for corners/walls) of that wall's interior face, either side of it — and
   already squared up to it (within AUTO_ANCHOR_MAX_SKEW, so a drop never
   silently rotates an object), with its center inside the wall's extent,
   is anchored to the nearest such wall FLUSH (gap 0) with the facing edge.
   Returns the new anchor, or null (the object stays free). Alt on release
   bypasses it, like every other snap. */
const AUTO_ANCHOR_MAX_SKEW = 1;   // degrees
function autoAnchorOnDrop(f, o){
  if(!o || o.anchor || !o.roomId) return null;
  const room=f.rooms.find(r=>r.id===o.roomId); if(!room) return null;
  const tol=SNAP_PX/view.scale, interiors=new Map();
  let best=null, bd=Infinity;
  loopWallKeys(room.loop).forEach(key=>{
    if(!key) return;
    const def=defaultAnchorFor(f, o, key, interiors); if(!def) return;
    const fr=wallFrame(f,key), t=worldToAlong(fr, o);
    if(t<=0 || t>=fr.len || def.skew>AUTO_ANCHOR_MAX_SKEW || Math.abs(def.rawGap)>tol) return;
    if(Math.abs(def.rawGap)<bd){ bd=Math.abs(def.rawGap); best=key; }
  });
  if(!best || !anchorObject(f, o, best, {gap:0})) return null;
  return o.anchor;
}

/* =========================================================================
   Room-drawing tools (ARCHITECTURE.md item 2). Unlike the drag kinds above,
   a draw tool is a persistent mode: it stays in `interaction` across many
   clicks and owns pointerdown itself (handler.down) — js/app.js routes every
   svg pointerdown to it in the CAPTURE phase and stops propagation, so
   clicking an existing wall/corner/label places a vertex instead of starting
   that element's drag. Vertices are kept as plain {x,y,weld} until the shape
   completes; only then are points minted/welded into the level, in one
   undoable commit.
   ========================================================================= */
const DRAW_TOOLS = {rect:"Rectangle", poly:"Freeform"};
const MIN_SEG = 2*MERGE_TOL;   // closer vertices could weld onto one existing corner

function drawToolActive(){ return !!interaction && Object.prototype.hasOwnProperty.call(DRAW_TOOLS, interaction.kind); }

function startDrawTool(kind){
  interaction = kind==="rect" ? {kind, a:null, cur:null} : {kind, verts:[], cur:null};
  snapViz=null;
  svg.classList.add("drawing");
  render();
  setReadout(DRAW_TOOLS[kind], kind==="rect" ? "click the first corner · Esc to cancel" : "click to place the first corner · Esc to cancel");
}
function exitDrawTool(){
  interaction=null; snapViz=null;
  svg.classList.remove("drawing");
}
/* Esc / toggling the hotkey: discard the in-progress shape. Returns whether
   there was a tool to cancel (for the keydown handler's Esc priority). */
function cancelDrawTool(){
  if(!drawToolActive()) return false;
  const label=DRAW_TOOLS[interaction.kind];
  exitDrawTool(); render();
  setReadout(label, "cancelled");
  return true;
}
/* N / Shift+N. Ignored mid-drag; pressing the active tool's key again exits it. */
function toggleDrawTool(kind){
  if(interaction && !drawToolActive()) return;
  if(interaction && interaction.kind===kind){ cancelDrawTool(); return; }
  startDrawTool(kind);
}
/* Re-run the active tool's preview with fresh modifier state (Ctrl/Alt
   pressed or released without moving the mouse). */
function refreshDrawPreview(e){
  if(!drawToolActive() || !interaction.lastClient) return;
  const c=interaction.lastClient;
  interactionHandlers[interaction.kind].move(interaction,
    {clientX:c.x, clientY:c.y, ctrlKey:e.ctrlKey, metaKey:e.metaKey, altKey:e.altKey, shiftKey:e.shiftKey});
}

/* Where a click at world `raw` would land: grid snap, then the same
   connect-snap a dragged corner uses (computeSnap with no dragged point).
   `weld` records whether connect-snap was on (and Alt not held) so the
   vertex may later join an existing corner/wall. */
function snapDrawPoint(e, raw){
  if(interaction) interaction.lastClient={x:e.clientX, y:e.clientY};
  let x=applySnap(raw[0]), y=applySnap(raw[1]);
  const weld = opts.snapConnect && !e.altKey;
  let viz=null;
  if(weld){
    const s=computeSnap(activeLevel(), null, x, y);
    x=s.x; y=s.y; viz={targetId:s.targetId, edge:s.edge, gx:s.gx, gy:s.gy};
  }
  return {x, y, weld, viz};
}

/* Axis-locked placement from `prev`: lock to whichever axis the cursor is
   closer to FIRST, then snap only along the free axis — a corner/wall snap
   is accepted only if it already lies on the locked line; otherwise fall
   back to an alignment guide on the free coordinate. */
function snapDrawPointOnAxis(e, raw, prev){
  if(interaction) interaction.lastClient={x:e.clientX, y:e.clientY};
  const horiz = Math.abs(raw[0]-prev.x) >= Math.abs(raw[1]-prev.y);
  let x = horiz ? applySnap(raw[0]) : prev.x;
  let y = horiz ? prev.y : applySnap(raw[1]);
  const weld = opts.snapConnect && !e.altKey;
  let viz=null;
  if(weld){
    const f=activeLevel();
    const s=computeSnap(f, null, x, y);
    const onAxis = horiz ? Math.abs(s.y-prev.y)<=MERGE_TOL : Math.abs(s.x-prev.x)<=MERGE_TOL;
    if((s.targetId || s.edge) && onAxis){
      if(horiz) x=s.x; else y=s.y;
      viz={targetId:s.targetId, edge:s.edge, gx:null, gy:null};
    } else {
      // guide along the free axis only (computeSnap's guide pass is skipped
      // whenever it found an off-axis corner/wall, so redo just that pass)
      const tolW=SNAP_PX/view.scale; let best=tolW, g=null;
      for(const p of f.points){
        const d = horiz ? Math.abs(p.x-x) : Math.abs(p.y-y);
        if(d<best){ best=d; g = horiz ? p.x : p.y; }
      }
      if(g!=null){ if(horiz) x=g; else y=g; }
      viz={targetId:null, edge:null, gx: horiz?g:null, gy: horiz?null:g};
    }
  }
  return {x, y, weld, viz};
}

/* The freeform tool's candidate vertex for this event: the first vertex if
   the cursor is within SNAP_PX of it on screen (closing the loop — a screen
   radius rather than MERGE_TOL, which is under a pixel at normal zoom and
   unusable as a click target), else an axis-locked point, else (Ctrl/Cmd
   held, or no previous vertex) a free one. */
function polyCandidate(it, e){
  const raw=eventWorld(e);
  it.lastClient={x:e.clientX, y:e.clientY};
  const vs=it.verts;
  if(vs.length){
    const s=vs[0]; const [ssx,ssy]=toScreen(s.x,s.y); const bx=svgBox();
    if(Math.hypot(e.clientX-bx.left-ssx, e.clientY-bx.top-ssy) <= SNAP_PX)
      return {x:s.x, y:s.y, weld:s.weld, viz:null, close:true, free:false};
  }
  const free = !!(e.ctrlKey || e.metaKey);
  const q = (!vs.length || free) ? snapDrawPoint(e, raw) : snapDrawPointOnAxis(e, raw, vs[vs.length-1]);
  q.close=false; q.free=free && vs.length>0;
  return q;
}

/* Validate + complete the freeform loop. Any rejection discards the shape
   and leaves the tool (per ARCHITECTURE.md: reject, don't silently fix). */
function finishPoly(it){
  let vs=it.verts.map(v=>({x:v.x, y:v.y, weld:v.weld}));
  let err=null;
  for(let i=0;i<vs.length && !err;i++) for(let j=i+1;j<vs.length;j++){
    if(Math.hypot(vs[i].x-vs[j].x, vs[i].y-vs[j].y)<MIN_SEG){ err="two corners are on top of each other"; break; }
  }
  if(!err && loopSelfIntersects(vs)) err="the outline crosses itself";
  if(!err && Math.abs(signedAreaXY(vs))<1e-6) err="the shape has no area";
  if(err){ exitDrawTool(); render(); setReadout("Freeform · rejected", err+" — shape discarded"); return; }
  if(signedAreaXY(vs)<0) vs.reverse();   // normalize winding (see signedAreaXY)
  createDrawnRoom(vs);
}

/* Map a completed vertex onto the level, through the same weld rules a
   released corner drag uses: reuse an existing (unlocked) corner within
   MERGE_TOL, else split an (unlocked) wall it lies on (T-junction via
   insertPointOnWall), else mint a fresh point. Resolved against CURRENT
   geometry at completion time, so earlier vertices' wall splits are seen by
   later ones. */
function resolveDrawnVertex(f, v){
  if(v.weld){
    const locked=lockedPointIds(f);
    let best=null, bd=MERGE_TOL;
    for(const p of f.points){
      if(locked.has(p.id)) continue;
      const d=Math.hypot(p.x-v.x, p.y-v.y); if(d<=bd){ bd=d; best=p; }
    }
    if(best) return best.id;
    for(const w of f.walls){
      if(locked.has(w.a) && locked.has(w.b)) continue;
      const A=ptOf(f,w.a), B=ptOf(f,w.b);
      const pr=projectPointSeg(v.x,v.y,A.x,A.y,B.x,B.y);
      if(pr.t>0 && pr.t<1 && Math.hypot(pr.x-v.x, pr.y-v.y)<=MERGE_TOL){
        const mid=insertPointOnWall(f, w.a, w.b, v.x, v.y);
        if(mid) return mid;
      }
    }
  }
  const p={id:"pt"+(_pid++), x:snapInch(v.x), y:snapInch(v.y)};
  f.points.push(p); f._pt.set(p.id,p);
  return p.id;
}

/* Shared completion for both tools: one undoable commit that mints/welds the
   points and the room (same id-minting + reindex pattern as addRoom()),
   selects it, and puts its name field into edit mode. */
function createDrawnRoom(verts){
  const f=activeLevel();
  exitDrawTool();
  commit(()=>{
    const ids=verts.map(v=>resolveDrawnVertex(f,v));
    const rid="room"+(_pid++);
    f.rooms.push({id:rid, name:"New Room", kind:"room", loop:ids});
    f._pt=new Map(f.points.map(p=>[p.id,p]));
    deriveWalls(f);
    sel={type:"room", id:rid};
  });
  focusRoomName();
}
