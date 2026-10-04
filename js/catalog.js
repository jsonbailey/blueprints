"use strict";

/* =========================================================================
   Placeable-type catalog (ARCHITECTURE.md, "js/catalog.js"). Item 4: wall
   opening types. Item 5 will add room fixtures alongside.

   Adding an opening type = adding one entry here; placement, re-keying,
   the inspector and rendering all read this table rather than switching on
   type names:
     type          stored in wallProps[key].openings[i].type
     label         UI name
     defaultWidth  feet; a new opening's width (the user can resize it)
     fields        which optional per-opening fields apply: "swing" (in/out +
                   the reference `room`) and/or "hand" (left/right)
     draw(g, k)    appends the plan symbol to SVG group `g`. `k` is a small
                   local frame built by render.js's drawOpenings:
                     k.P(s, m) → [x, y] screen point, s px ALONG the wall
                               from the opening's center (+ toward the
                               wall's hi end), m px ACROSS it (+ toward the
                               swing side for doors / the reference room)
                     k.w       opening width, px     k.t  wall band width, px
                     k.hs      +1/-1: which end (s sign) the hinge is on
                     k.color   stroke color          k.o  the opening data
                   The wall gap itself (band knocked out between the jambs)
                   and the jamb ticks are drawn by render.js for every type.

   Loaded after model.js (addOpening validates types through
   openingTypeDef at call time) and before render.js / inspector.js.
   ========================================================================= */

function _ln(g, a, b, attrs){
  g.appendChild(el("line", {x1:a[0], y1:a[1], x2:b[0], y2:b[1], "stroke-linecap":"butt", ...attrs}));
}

const OPENING_TYPES = [
  { type:"door", label:"Door", defaultWidth:3, fields:["swing","hand"],
    /* standard swing symbol: leaf drawn open 90° from the hinge on the swing
       face, plus a quarter-circle arc from the leaf tip to the strike jamb */
    draw(g, k){
      const {P, w, t, hs, color} = k, h=hs*w/2, face=t/2;
      _ln(g, P(h, face), P(h, face+w), {stroke:color, "stroke-width":2});
      const pts=[];
      for(let i=0;i<=16;i++){ const th=i/16*Math.PI/2; pts.push(P(h - hs*w*Math.sin(th), face + w*Math.cos(th)).join(",")); }
      g.appendChild(el("polyline", {points:pts.join(" "), fill:"none", stroke:color, "stroke-width":1, "stroke-dasharray":"3 2"}));
    } },
  { type:"window", label:"Window", defaultWidth:3, fields:[],
    /* frame lines on both faces + a glass line on the centerline */
    draw(g, k){
      const {P, w, t, color} = k;
      [-t/2, 0, t/2].forEach((m,i)=>_ln(g, P(-w/2, m), P(w/2, m), {stroke:color, "stroke-width": i===1 ? 1.6 : 1}));
    } },
  { type:"sliding", label:"Sliding door", defaultWidth:6, fields:["hand"],
    /* two overlapping panels on offset tracks; `hand` picks which is in front */
    draw(g, k){
      const {P, w, t, hs, color} = k, off=Math.max(1.5, t/5), lap=w*0.06;
      _ln(g, P(-w/2, -off*hs), P(lap, -off*hs), {stroke:color, "stroke-width":2});
      _ln(g, P(-lap, off*hs), P(w/2, off*hs), {stroke:color, "stroke-width":2});
    } },
  { type:"garage", label:"Garage door", defaultWidth:9, fields:[],
    /* overhead door: dashed head line on both faces + segment ticks across */
    draw(g, k){
      const {P, w, t, color} = k;
      [-t/2, t/2].forEach(m=>_ln(g, P(-w/2, m), P(w/2, m), {stroke:color, "stroke-width":1, "stroke-dasharray":"5 3"}));
      const n=Math.max(2, Math.round(w/14));
      for(let i=1;i<n;i++){ const s=-w/2+w*i/n; _ln(g, P(s, -t/2), P(s, t/2), {stroke:color, "stroke-width":1}); }
    } },
];

function openingTypeDef(type){ return OPENING_TYPES.find(t=>t.type===type) || null; }
function openingLabel(type){ const d=openingTypeDef(type); return d ? d.label : String(type); }
