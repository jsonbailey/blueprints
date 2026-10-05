"use strict";

/* ---------- coordinate transforms ---------- */
function toScreen(x,y){ return [view.ox + x*view.scale, view.oy + y*view.scale]; }
function toWorld(sx,sy){ return [(sx-view.ox)/view.scale, (sy-view.oy)/view.scale]; }

/* ---------- rendering ---------- */
const SVG_NS = "http://www.w3.org/2000/svg";
const svg = document.getElementById("plan");
function el(name, attrs){ const e=document.createElementNS(SVG_NS,name); for(const k in attrs) e.setAttribute(k, attrs[k]); return e; }
function fillFor(kind){
  if(kind==="garage") return "url(#hatch)";
  if(kind==="outdoor") return "url(#hatchSoft)";
  if(kind==="hall") return "rgba(62,124,168,0.07)";
  return "rgba(38,38,42,0.035)";
}

function render(){
  const W = svg.clientWidth, H = svg.clientHeight;
  while(svg.firstChild) svg.removeChild(svg.firstChild);

  // defs: hatch patterns for unconditioned space
  const defs = el("defs",{});
  defs.innerHTML =
    '<pattern id="hatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
    + '<rect width="9" height="9" fill="rgba(38,38,42,0.02)"/><line x1="0" y1="0" x2="0" y2="9" stroke="rgba(38,38,42,0.16)" stroke-width="1"/></pattern>'
    + '<pattern id="hatchSoft" width="11" height="11" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
    + '<line x1="0" y1="0" x2="0" y2="11" stroke="rgba(62,124,168,0.18)" stroke-width="1"/></pattern>';
  svg.appendChild(defs);

  if(opts.grid) drawGrid(W,H);

  renderLevelPanel();
  renderWallDefaults();

  // shadow (every other visible level) underneath
  if(opts.shadow) otherLevels().forEach(l=>drawLevel(l, {shadow:true}));
  // active level
  drawLevel(activeLevel(), {shadow:false});

  if(snapViz){
    const W=svg.clientWidth, H=svg.clientHeight; const g=el("g",{});
    if(snapViz.edge){ const A=ptOf(activeLevel(),snapViz.edge.a), B=ptOf(activeLevel(),snapViz.edge.b);
      if(A&&B){ const [ax,ay]=toScreen(A.x,A.y),[bx,by]=toScreen(B.x,B.y);
        g.appendChild(el("line",{x1:ax,y1:ay,x2:bx,y2:by,stroke:"var(--markup)","stroke-width":4,opacity:0.5,"stroke-linecap":"round"})); } }
    if(snapViz.gx!=null){ const [sx]=toScreen(snapViz.gx,0); g.appendChild(el("line",{x1:sx,y1:0,x2:sx,y2:H,stroke:"var(--markup)","stroke-width":1,"stroke-dasharray":"3 4",opacity:0.75})); }
    if(snapViz.gy!=null){ const [,sy]=toScreen(0,snapViz.gy); g.appendChild(el("line",{x1:0,y1:sy,x2:W,y2:sy,stroke:"var(--markup)","stroke-width":1,"stroke-dasharray":"3 4",opacity:0.75})); }
    if(snapViz.targetId){ const tp=ptOf(activeLevel(),snapViz.targetId); if(tp){ const [sx,sy]=toScreen(tp.x,tp.y); g.appendChild(el("circle",{cx:sx,cy:sy,r:11,fill:"none",stroke:"var(--markup)","stroke-width":2})); } }
    svg.appendChild(g);
  }

  // in-progress interaction preview (room-drawing tools) — js/tools.js
  if(interaction && interactionHandlers[interaction.kind].overlay){
    svg.appendChild(interactionHandlers[interaction.kind].overlay(interaction));
  }

  updateScaleReadout();
}

function drawGrid(W,H){
  const g = el("g",{});
  const [wx0,wy0] = toWorld(0,0), [wx1,wy1] = toWorld(W,H);
  const start = Math.floor(wx0), end = Math.ceil(wx1);
  const startY = Math.floor(wy0), endY = Math.ceil(wy1);
  const showMinor = view.scale >= 7;
  for(let x=start;x<=end;x++){
    if(!showMinor && x%5!==0) continue;
    const [sx] = toScreen(x,0);
    g.appendChild(el("line",{x1:sx,y1:0,x2:sx,y2:H,stroke:(x%5===0?"var(--paper-line-major)":"var(--paper-line)"),"stroke-width":1}));
  }
  for(let y=startY;y<=endY;y++){
    if(!showMinor && y%5!==0) continue;
    const [,sy] = toScreen(0,y);
    g.appendChild(el("line",{x1:0,y1:sy,x2:W,y2:sy,stroke:(y%5===0?"var(--paper-line-major)":"var(--paper-line)"),"stroke-width":1}));
  }
  svg.appendChild(g);
}

function drawLevel(f, {shadow}){
  const gRooms = el("g",{}), gWalls = el("g",{}), gDims = el("g",{}), gLabels = el("g",{}), gHandles = el("g",{}), gBadge = el("g",{});
  const lockedSet = shadow ? new Set() : lockedPointIds(f);

  // room fills
  f.rooms.forEach(r=>{
    const pts = r.loop.map(id=>{const p=ptOf(f,id); const [sx,sy]=toScreen(p.x,p.y); return sx+","+sy;}).join(" ");
    const roomSel = !shadow && sel.type==="room" && sel.id===r.id;
    const locked = !shadow && r.locked;
    gRooms.appendChild(el("polygon",{points:pts,
      fill: shadow ? "rgba(62,124,168,0.05)" : (roomSel ? "rgba(206,59,35,0.10)" : (locked ? "rgba(110,106,99,0.10)" : fillFor(r.kind))),
      stroke: roomSel ? "var(--markup)" : (locked ? "var(--graphite-soft)" : "none"),
      "stroke-width": (roomSel||locked) ? 1.5 : 0,
      "stroke-dasharray": roomSel ? "4 4" : (locked ? "2 3" : "none")}));
  });

  // Interior-offset geometry per room (active level only): drives the
  // mitered-corner clip below and the per-side dimension labels.
  const interiors = new Map();
  const clipPolyCache = new Map();   // roomId → screen-space path data, or "" if unusable
  function interiorOf(r){ if(!interiors.has(r.id)) interiors.set(r.id, roomInterior(f,r)); return interiors.get(r.id); }
  function interiorClipPath(r){
    if(clipPolyCache.has(r.id)) return clipPolyCache.get(r.id);
    const g=interiorOf(r);
    // only a clean, non-inverted interior is safe to cut the bands with
    const ok = g.poly.length>=3 && g.area>1e-6 && !loopSelfIntersects(g.poly);
    const d = ok ? "M"+g.poly.map(p=>toScreen(p.x,p.y).join(" ")).join(" L")+" Z" : "";
    clipPolyCache.set(r.id, d); return d;
  }
  const gClipDefs = el("defs",{});
  if(!shadow) gWalls.appendChild(gClipDefs);

  // walls — drawn as a band effThickness() wide (real scale), with a minimum
  // on-screen width so very thin walls stay visible/clickable. Square caps
  // fill rectilinear corners/T-junctions. On the active level each band is
  // then clipped (evenodd: whole canvas minus the interior-offset polygons
  // of every room meeting either of its endpoints), so whatever a square
  // cap pokes past a room's interior face at a non-90° corner is cut away
  // and the interior corner reads as a clean miter. Only rooms touching the
  // wall's endpoints are used, so a wall of an unrelated room that merely
  // overlaps another room (pre-cut) is never hidden. (Exterior corners are
  // still square-capped: an acute exterior corner can show a small notch.)
  // An open (no-wall) edge gets a thin dashed line + a wider invisible hit
  // target on the active level, and isn't drawn at all in the shadow view.
  f.walls.forEach((w,wi)=>{
    const a=ptOf(f,w.a), b=ptOf(f,w.b);
    const [ax,ay]=toScreen(a.x,a.y),[bx,by]=toScreen(b.x,b.y);
    const isSel = !shadow && sel.type==="wall" && sel.id===w.id;
    const open = isOpenWall(f,w);
    if(shadow && open) return;
    const sw = open ? 0 : Math.max(shadow ? 1.5 : (isSel ? 4 : 2.6), effThickness(f,w)*view.scale);
    let line, hit;
    if(open){
      line = el("g",{});
      line.appendChild(el("line",{x1:ax,y1:ay,x2:bx,y2:by,
        stroke: isSel ? "var(--markup)" : "var(--graphite-soft)",
        "stroke-width": isSel ? 2 : 1.2, "stroke-dasharray":"6 5", "pointer-events":"none"}));
      hit = el("line",{x1:ax,y1:ay,x2:bx,y2:by, stroke:"transparent", "stroke-width":10});
      line.appendChild(hit);
    } else {
      line = hit = el("line",{x1:ax,y1:ay,x2:bx,y2:by,
        stroke: shadow ? "var(--blueprint)" : (isSel ? "var(--markup)" : "var(--graphite)"),
        "stroke-width": sw,
        "stroke-linecap": shadow ? "round" : "square",
        // shadow keeps its dotted look at any width: dots one band wide
        "stroke-dasharray": shadow ? `${Math.max(1,sw*0.2)} ${Math.max(5,sw*1.8)}` : "none",
        opacity: shadow ? 0.55 : 1});
      // Only when the band is at real scale: if the minimum on-screen width
      // kicked in (zoomed out / thin wall) the overlap is a pixel or two, and
      // clipping to the true faces would undo that minimum.
      if(!shadow && sw <= effThickness(f,w)*view.scale + 0.01){
        const rs = new Set([...roomsAt(f,w.a), ...roomsAt(f,w.b)]);
        const holes = [...rs].map(interiorClipPath).filter(Boolean);
        if(holes.length){
          const id = `wclip-${wi}`, BIG = 1e6;   // only the active level clips → unique
          const cp = el("clipPath",{id, clipPathUnits:"userSpaceOnUse"});
          cp.appendChild(el("path",{"clip-rule":"evenodd",
            d:`M${-BIG} ${-BIG} H${BIG} V${BIG} H${-BIG} Z `+holes.join(" ")}));
          gClipDefs.appendChild(cp);
          line.setAttribute("clip-path",`url(#${id})`);
        }
      }
    }
    if(!shadow){
      const horiz = Math.abs(b.x-a.x) >= Math.abs(b.y-a.y);
      hit.style.cursor = horiz ? "ns-resize" : "ew-resize";
      hit.dataset.wall=w.id;
      hit.addEventListener("pointerdown",(e)=>startDragWall(e,w.id));
    }
    gWalls.appendChild(line);

    // dimension labels (active level only). opts.lengthMode="inside" (the
    // default/current shipped behavior): one per room that runs along this
    // wall (an exterior wall has 1, a shared wall 2), each showing THAT
    // room's interior clear length — the distance between its own interior
    // corners on this edge — and sitting inside that room, just clear of
    // the drawn band, so neighbours' labels never collide on the shared
    // line. opts.lengthMode="centerline": revert to one label per WALL at
    // the raw centerline length (the pre-interior-geometry behavior),
    // positioned at the wall's midpoint, offset perpendicular by a fixed
    // screen distance clear of the drawn band — there's no per-room
    // geometry to read in this mode, deliberately.
    if(!shadow && opts.dims){
      const ang = Math.atan2(by-ay,bx-ax)*180/Math.PI;
      const flip = (ang>90||ang<-90);
      if(opts.lengthMode==="centerline"){
        const clen = Math.hypot(b.x-a.x,b.y-a.y);
        if(clen>0.4){
          const dlen=Math.hypot(bx-ax,by-ay)||1, nx=-(by-ay)/dlen, ny=(bx-ax)/dlen;   // screen-space perpendicular unit vector
          const off = 11 + sw/2;
          const lx=(ax+bx)/2+nx*off, ly=(ay+by)/2+ny*off;
          const t = el("text",{x:lx,y:ly, fill: isSel?"var(--markup)":"var(--graphite-soft)",
            "font-family":"var(--mono)","font-size":11,"text-anchor":"middle","dominant-baseline":"central",
            transform:`rotate(${flip?ang+180:ang} ${lx} ${ly})`,
            "paint-order":"stroke","stroke":"var(--paper)","stroke-width":3});
          t.textContent = fmtFt(clen);
          gDims.appendChild(t);
        }
      } else {
        wallSides(f, w, interiors).forEach(({side})=>{
          if(!side || side.len<=0.4) return;
          const mid = {x:(side.a.x+side.b.x)/2, y:(side.a.y+side.b.y)/2};   // on the interior face
          const [fx,fy] = toScreen(mid.x,mid.y);
          // screen and world share orientation (uniform positive scale), so the
          // world inward normal is the screen one; push from the face out to
          // 11px past the drawn band's edge (band can be wider than real scale)
          const off = 11 + Math.max(0, sw/2 - side.half*view.scale);
          const lx = fx+side.n.x*off, ly = fy+side.n.y*off;
          const t = el("text",{x:lx,y:ly, fill: isSel?"var(--markup)":"var(--graphite-soft)",
            "font-family":"var(--mono)","font-size":11,"text-anchor":"middle","dominant-baseline":"central",
            transform:`rotate(${flip?ang+180:ang} ${lx} ${ly})`,
            "paint-order":"stroke","stroke":"var(--paper)","stroke-width":3});
          t.textContent = fmtFt(side.len);
          gDims.appendChild(t);
        });
      }
    }

    // end badges on the selected wall: which corner is ① / ② and which moves
    if(isSel){
      const mk=(x,y,label,moves)=>{
        gBadge.appendChild(el("circle",{cx:x,cy:y,r:8.5,fill:moves?"var(--markup)":"var(--graphite)",stroke:"#fff","stroke-width":1.5}));
        const t=el("text",{x:x,y:y+0.5,"text-anchor":"middle","dominant-baseline":"central","font-family":"var(--mono)","font-size":10,"font-weight":700,fill:"#fff"});
        t.textContent=label; gBadge.appendChild(t);
      };
      mk(ax,ay,"1",movingEnd==="a");   // end ① = wall.a
      mk(bx,by,"2",movingEnd==="b");   // end ② = wall.b
    }
  });

  // room labels
  if(opts.labels){
    f.rooms.forEach(r=>{
      const c = centroid(f,r.loop); const [cx,cy]=toScreen(c.x,c.y);
      const name = el("text",{x:cx,y:cy, "text-anchor":"middle",
        "font-family":"var(--ui)","font-size":11,"font-weight":600,"letter-spacing":"0.04em",
        fill: shadow ? "rgba(62,124,168,0.6)" : "var(--graphite)",
        "paint-order":"stroke","stroke":"var(--paper)","stroke-width":shadow?2:3});
      name.textContent = r.name.toUpperCase();
      if(!shadow){
        name.style.cursor="move";
        name.addEventListener("pointerdown",(e)=>startDragRoom(e,r.id));
        name.addEventListener("dblclick",(e)=>{ e.stopPropagation(); startRoomNameOverlay(r,cx,cy); });
      }
      gLabels.appendChild(name);
      if(!shadow){
        const area = interiorArea(f,r);   // inside the walls' interior faces, not centerline
        const sub = el("text",{x:cx,y:cy+13,"text-anchor":"middle",
          "font-family":"var(--mono)","font-size":10,fill:"var(--graphite-soft)",
          "paint-order":"stroke","stroke":"var(--paper)","stroke-width":3});
        sub.textContent = Math.round(area)+" sf";
        sub.style.cursor="move"; sub.addEventListener("pointerdown",(e)=>startDragRoom(e,r.id));
        gLabels.appendChild(sub);
        if(r.locked){
          const lk=el("text",{x:cx,y:cy+25,"text-anchor":"middle","font-family":"var(--ui)","font-size":9,
            "letter-spacing":"0.14em",fill:"var(--graphite-soft)","paint-order":"stroke","stroke":"var(--paper)","stroke-width":3});
          lk.textContent="LOCKED";
          gLabels.appendChild(lk);
        }
      }
    });
  }

  // corner handles (active level only)
  if(!shadow){
    f.points.forEach(p=>{
      const [sx,sy]=toScreen(p.x,p.y);
      const isSel = sel.type==="point" && sel.id===p.id;
      const locked = lockedSet.has(p.id);
      const shared = pointDegree(f,p.id) >= 3;   // a junction shared across walls/rooms
      let c;
      if(locked){
        c = el("rect",{x:sx-4.5,y:sy-4.5,width:9,height:9,
          fill:isSel?"var(--markup)":"var(--graphite-soft)",stroke:"#fff","stroke-width":1.5});
        c.style.cursor="not-allowed";
      } else {
        c = el("circle",{cx:sx,cy:sy,r:isSel?6:(shared?5.5:5),
          fill:isSel?"var(--markup)":(shared?"var(--graphite)":"#fff"),
          stroke:isSel?"var(--markup)":"var(--graphite)","stroke-width":2});
        c.style.cursor="grab";
      }
      c.dataset.point=p.id;
      c.addEventListener("pointerdown",(e)=>startDragPoint(e,p.id));
      gHandles.appendChild(c);
    });
  }

  // wall openings (active level only — the shadow view stays plain walls)
  const gOpenings = el("g",{});
  if(!shadow) drawOpenings(f, gOpenings, interiors);

  // placed objects, free and wall-anchored (ARCHITECTURE.md item 5 — active
  // level only; see drawObjects below for why the shadow view skips them)
  const gObjects = el("g",{});
  if(!shadow) drawObjects(f, gObjects);

  svg.appendChild(gRooms); svg.appendChild(gWalls); svg.appendChild(gOpenings); svg.appendChild(gObjects);
  svg.appendChild(gDims); svg.appendChild(gLabels); svg.appendChild(gHandles); svg.appendChild(gBadge);
}

/* Wall openings (ARCHITECTURE.md item 4): for each opening, knock a gap out
   of the wall band between two jamb ticks, then let the catalog entry draw
   its symbol (js/catalog.js) in a local frame centered on the opening.
   - Position/width come from displayedOpening(): clamped to the wall's
     CURRENT length, so a shortened wall never draws an opening past its end,
     while the stored offset stays untouched (lengthen it back and the
     opening reappears where it was).
   - The "across" axis points to the swing side (openingSwingNormal: the
     reference room's interior-face inward normal from roomInterior, flipped
     for "out"). World and screen share orientation (uniform positive scale,
     no flip), so world unit vectors are used directly on screen.
   - hand: hinge on the right/left of someone standing on the swing side
     facing the wall. Their right-hand direction is (n.y, -n.x) for swing
     normal n (y-down: facing up, i.e. n=(0,1), gives (1,0) = screen right).
   - Open walls: openings are hidden (kept in the data), per item 3.
   Each glyph gets a transparent hit target that selects it and starts the
   `opening` drag (js/tools.js). */
function drawOpenings(f, g, interiors){
  if(!f.wallProps) return;
  f.walls.forEach(w=>{
    const key=wallKeyOf(w), list=openingsAt(f,key);
    if(!list.length || isOpenWall(f,w)) return;
    const fr=wallFrame(f,key); if(!fr || fr.len<1e-6) return;
    const t=Math.max(2.6, effThickness(f,w)*view.scale);   // same band width the wall pass drew
    const u=fr.dir;
    list.forEach(o=>{
      const d=displayedOpening(o, fr.len); if(d.width<=1e-6) return;
      const def=openingTypeDef(o.type);
      const isSel = sel.type==="opening" && sel.id===o.id;
      const n=openingSwingNormal(f, key, o, interiors);
      const cw=alongToWorld(fr, d.along), C=toScreen(cw.x, cw.y);
      const P=(s,m)=>[C[0]+u.x*s+n.x*m, C[1]+u.y*s+n.y*m];
      const wpx=d.width*view.scale;
      const ru = (n.y*u.x - n.x*u.y) >= 0 ? 1 : -1;            // s-sign of the viewer's right hand
      const hs = o.hand==="right" ? ru : -ru;
      const color = isSel ? "var(--markup)" : "var(--graphite)";
      const og=el("g",{});
      const gap=[P(-wpx/2,0), P(wpx/2,0)];
      og.appendChild(el("line",{x1:gap[0][0],y1:gap[0][1],x2:gap[1][0],y2:gap[1][1],
        stroke:"var(--paper)","stroke-width":t+1,"stroke-linecap":"butt","pointer-events":"none"}));
      [-1,1].forEach(sg=>{ const a=P(sg*wpx/2,-t/2), b=P(sg*wpx/2,t/2);
        og.appendChild(el("line",{x1:a[0],y1:a[1],x2:b[0],y2:b[1],stroke:color,"stroke-width":1.5})); });
      if(def) def.draw(og, {P, w:wpx, t, hs, color, o});
      const m=Math.max(t/2, 6);
      const hit=el("polygon",{points:[P(-wpx/2,-m),P(wpx/2,-m),P(wpx/2,m),P(-wpx/2,m)].map(p=>p.join(",")).join(" "),
        fill:"transparent", stroke:isSel?"var(--markup)":"none","stroke-width":1,"stroke-dasharray":"3 3"});
      hit.style.cursor = Math.abs(u.x)>=Math.abs(u.y) ? "ew-resize" : "ns-resize";
      hit.dataset.opening=o.id;
      hit.addEventListener("pointerdown",(e)=>startDragOpening(e, key, o.id));
      og.appendChild(hit);
      g.appendChild(og);
    });
  });
}

/* ---------- placed objects (ARCHITECTURE.md item 5) ----------
   Free and wall-anchored objects draw identically, through
   objectLocalToScreen: an anchored object's x/y/rot are the cache
   resolveObjects (js/model.js) keeps up to date, so nothing here re-derives
   its pose.
   Not drawn in the shadow view (not required by ARCHITECTURE.md, and keeps
   the shadow view to the same "pure wall geometry, no detail" treatment
   corner handles/openings already get there). */

/* Build the object's own local→screen point function from its current
   x/y/rot/mirror, so js/catalog.js's draw(g,k) never has to think about
   those: k.P(lx, ld) takes a local offset in feet (lx along the object's
   width axis, ld along its depth axis, both measured from its center) and
   returns a screen point. Mirror flips the local width axis BEFORE rotation
   (so "mirror" always means "flip the object's own left/right", independent
   of its current turn), then the object rotates by `rot` degrees and
   translates to (x, y) — world and screen share orientation (uniform
   positive scale, no flip), so this feeds straight into toScreen() like any
   other world point. */
function objectLocalToScreen(o){
  const rad=(o.rot||0)*Math.PI/180, cos=Math.cos(rad), sin=Math.sin(rad), mir=o.mirror?-1:1;
  return (lx, ld)=>{
    const mx=lx*mir;
    const wx=o.x + mx*cos - ld*sin;
    const wy=o.y + mx*sin + ld*cos;
    return toScreen(wx, wy);
  };
}

/* Selectable, draggable plan symbol for each object (js/catalog.js's
   FIXTURE_TYPES draws the symbol itself; this adds the type-name label and
   wires selection/drag). A transparent hit polygon covering the object's
   full w×d box is appended LAST — same trick drawOpenings uses for its hit
   target — so it sits on top for pointer purposes (clicking anywhere in the
   box, not just on a drawn line, starts the drag) without visually hiding
   the symbol painted underneath it. */
function drawObjects(f, g){
  (f.objects||[]).forEach(o=>{
    const def=fixtureTypeDef(o.type); if(!def) return;
    const isSel = sel.type==="object" && sel.id===o.id;
    const color = isSel ? "var(--markup)" : "var(--graphite)";
    const P=objectLocalToScreen(o);
    const og=el("g",{});
    def.draw(og, {P, w:o.w, d:o.d, color});
    const [cx,cy]=toScreen(o.x,o.y);
    const label=el("text",{x:cx, y:cy+Math.max(14,(o.d*view.scale)/2+11), "text-anchor":"middle",
      "font-family":"var(--ui)","font-size":10, fill:color,
      "paint-order":"stroke","stroke":"var(--paper)","stroke-width":3,"pointer-events":"none"});
    label.textContent = def.label;
    og.appendChild(label);
    const corners=[P(-o.w/2,-o.d/2),P(o.w/2,-o.d/2),P(o.w/2,o.d/2),P(-o.w/2,o.d/2)];
    const hit=el("polygon",{points:corners.map(p=>p.join(",")).join(" "),
      fill:"transparent", stroke:isSel?"var(--markup)":"none","stroke-width":1.5,"stroke-dasharray":isSel?"4 4":"none"});
    // anchored + selected: a dashed gap dimension from the wall's interior
    // face to the anchored edge's midpoint (x/y/rot are already resolved —
    // markDirty/drags ran resolveObjects — so this only reads the cache)
    if(isSel && o.anchor){
      const face=anchorFace(f, o.roomId, o.anchor.wall);
      if(face && face.side){
        const u=ANCHOR_EDGES[o.anchor.edge], h=anchorEdgeHalf(o, o.anchor.edge);
        const [ex,ey]=P(u.x*h, u.y*h);                       // anchored edge midpoint (local → screen)
        const n=face.side.n, s=o.anchor.gap*view.scale;     // world and screen share orientation
        const fx=ex-n.x*s, fy=ey-n.y*s;                      // its foot on the interior face
        og.appendChild(el("line",{x1:fx,y1:fy,x2:ex,y2:ey,stroke:"var(--markup)","stroke-width":1.2,"stroke-dasharray":"3 3","pointer-events":"none"}));
        og.appendChild(el("circle",{cx:fx,cy:fy,r:2.5,fill:"var(--markup)","pointer-events":"none"}));
        const t=el("text",{x:(fx+ex)/2+n.y*10, y:(fy+ey)/2-n.x*10, "text-anchor":"middle","dominant-baseline":"central",
          "font-family":"var(--mono)","font-size":10, fill:"var(--markup)",
          "paint-order":"stroke","stroke":"var(--paper)","stroke-width":3,"pointer-events":"none"});
        t.textContent = fmtInches(o.anchor.gap);
        og.appendChild(t);
      }
    }
    hit.style.cursor="move";
    hit.dataset.object=o.id;
    hit.addEventListener("pointerdown",(e)=>startDragObject(e,o.id));
    og.appendChild(hit);
    g.appendChild(og);
  });
}

/* On-canvas double-click-to-rename for a room's plan label (ARCHITECTURE.md
   item 2.5). SVG <text> has no contenteditable, so this builds a small HTML
   overlay — a contenteditable <div> absolutely positioned at the label's
   current screen coordinates (the same cx/cy toScreen() just computed for
   the <text> itself) — and hands it to the same startRenameRoom
   (js/inspector.js) the Inspector panel's room-name display uses, so both
   entry points share identical commit/undo/Enter/Escape behavior instead of
   each reimplementing it.

   The overlay is appended to `.stage` (the svg's own parent, which the svg
   exactly fills, so the svg's screen coordinates double as `.stage`-relative
   CSS coordinates) as a SIBLING of the svg, not a child of it — so it
   survives every render() call untouched: drawLevel only ever clears and
   rebuilds the svg's own children, never touches `.stage` itself. That's
   what lets the overlay stay open (and keep focus) across a re-render
   triggered by unrelated activity while editing.

   Pan/zoom are simply disabled for the overlay's lifetime (js/app.js checks
   _editingRoomId) rather than re-positioning it live through a pan/zoom. */
function startRoomNameOverlay(r, cx, cy){
  if(drawToolActive() || _editingLevelId || _editingRoomId) return;
  const stage = svg.parentNode;
  const ov = document.createElement("div");
  ov.className = "room-name-overlay";
  ov.textContent = r.name;
  ov.style.left = cx+"px";
  ov.style.top = cy+"px";
  stage.appendChild(ov);
  startRenameRoom(r, ov, { onFinish(){ ov.remove(); } });
}

function updateScaleReadout(){
  // scale as 1/4" = 1'-0" style approximation based on px/ft (assume 96dpi)
  document.getElementById("scaleReadout").textContent = view.scale.toFixed(1)+" px/ft";
}
