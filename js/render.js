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

  renderLevelTabs();

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

  // walls
  f.walls.forEach(w=>{
    const a=ptOf(f,w.a), b=ptOf(f,w.b);
    const [ax,ay]=toScreen(a.x,a.y),[bx,by]=toScreen(b.x,b.y);
    const isSel = !shadow && sel.type==="wall" && sel.id===w.id;
    const line = el("line",{x1:ax,y1:ay,x2:bx,y2:by,
      stroke: shadow ? "var(--blueprint)" : (isSel ? "var(--markup)" : "var(--graphite)"),
      "stroke-width": shadow ? 1.5 : (isSel ? 4 : 2.6),
      "stroke-linecap":"round",
      "stroke-dasharray": shadow ? "1 5" : "none",
      opacity: shadow ? 0.55 : 1});
    if(!shadow){
      const horiz = Math.abs(b.x-a.x) >= Math.abs(b.y-a.y);
      line.style.cursor = horiz ? "ns-resize" : "ew-resize";
      line.dataset.wall=w.id;
      line.addEventListener("pointerdown",(e)=>startDragWall(e,w.id));
    }
    gWalls.appendChild(line);

    // dimension label (active level only), pulled INSIDE the room so it never
    // sits on the shared line / overlaps the neighbouring room
    if(!shadow && opts.dims){
      const len = Math.hypot(b.x-a.x,b.y-a.y);
      if(len>0.4){
        const mx=(ax+bx)/2, my=(ay+by)/2;
        const ang = Math.atan2(by-ay,bx-ax)*180/Math.PI;
        const flip = (ang>90||ang<-90);
        let lx=mx, ly=my-6;
        const rr = w.room!=null ? f.rooms.find(r=>r.id===w.room) : null;
        if(rr){
          const c=centroid(f,rr.loop); const [csx,csy]=toScreen(c.x,c.y);
          let vx=csx-mx, vy=csy-my; const vl=Math.hypot(vx,vy)||1; vx/=vl; vy/=vl;
          lx=mx+vx*11; ly=my+vy*11;
        }
        const t = el("text",{x:lx,y:ly, fill: isSel?"var(--markup)":"var(--graphite-soft)",
          "font-family":"var(--mono)","font-size":11,"text-anchor":"middle","dominant-baseline":"central",
          transform:`rotate(${flip?ang+180:ang} ${lx} ${ly})`,
          "paint-order":"stroke","stroke":"var(--paper)","stroke-width":3});
        t.textContent = fmtFt(len);
        gDims.appendChild(t);
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
      if(!shadow){ name.style.cursor="move"; name.addEventListener("pointerdown",(e)=>startDragRoom(e,r.id)); }
      gLabels.appendChild(name);
      if(!shadow){
        const area = polyArea(f,r.loop);
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

  svg.appendChild(gRooms); svg.appendChild(gWalls);
  svg.appendChild(gDims); svg.appendChild(gLabels); svg.appendChild(gHandles); svg.appendChild(gBadge);
}

function updateScaleReadout(){
  // scale as 1/4" = 1'-0" style approximation based on px/ft (assume 96dpi)
  document.getElementById("scaleReadout").textContent = view.scale.toFixed(1)+" px/ft";
}
