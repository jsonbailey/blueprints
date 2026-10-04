"use strict";

/* =========================================================================
   Placeable-type catalog (ARCHITECTURE.md, "js/catalog.js"). Item 4: wall
   opening types (OPENING_TYPES). Item 5 (free-placement half): room
   fixtures/furniture (FIXTURE_TYPES, below).

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

/* ---------- fixtures & furniture (ARCHITECTURE.md item 5 — this half of the
   item is FREE placement only; wall-anchored placement is a separate, later
   task) ----------
   {type, label, w, d, draw(g,k)} per entry. `w`/`d` here are only a
   reasonable STARTING box for a newly placed instance (addObject, js/
   model.js) — level.objects stores its own per-instance w/d, which the user
   can resize afterward, so these numbers aren't load-bearing beyond "a
   sensible size to drop in and resize." Car/truck are the two ARCHITECTURE.md
   actually specifies (~6'x15', ~6.5'x20'); the rest are reasonable real-world
   starting dimensions.

   draw(g, k) appends the plan symbol to SVG group `g`, in the object's own
   LOCAL frame — unlike OPENING_TYPES above, this is NOT wall-relative (free
   objects aren't on a wall at all):
     k.P(lx, ld) → [x, y] screen point for a local offset of `lx` feet along
               the object's width axis and `ld` feet along its depth axis,
               measured from the object's center (so the object's own box
               runs lx in [-w/2, w/2], ld in [-d/2, d/2]). js/render.js's
               objectLocalToScreen() already folds in the object's current
               rotation, mirror and world position, so draw() never needs to
               think about those — same division of labor as OPENING_TYPES'
               k.P.
     k.w, k.d  the object's CURRENT (resized) width/depth, feet.
     k.color   stroke color (selection-aware).
   Every entry draws its own box outline (via _fbox) plus a small identifying
   detail — kept simple per ARCHITECTURE.md ("a labeled rectangle outline is
   a perfectly fine baseline for most types"); the selection highlight and
   the type-name label are drawn once, generically, by js/render.js. */
function _fbox(g, k, attrs){
  const {P,w,d} = k;
  const pts=[P(-w/2,-d/2),P(w/2,-d/2),P(w/2,d/2),P(-w/2,d/2)];
  g.appendChild(el("polygon",{points:pts.map(p=>p.join(",")).join(" "), fill:"none", "stroke-linejoin":"round", ...attrs}));
}

const FIXTURE_TYPES = [
  { type:"cabinets", label:"Cabinets", w:2, d:2,
    /* a run of base/upper cabinets: box + a corner diagonal (door symbol) */
    draw(g,k){ _fbox(g,k,{stroke:k.color,"stroke-width":1.5});
      _ln(g, k.P(-k.w/2,-k.d/2), k.P(k.w/2,k.d/2), {stroke:k.color,"stroke-width":1}); } },

  { type:"sink", label:"Sink", w:2, d:2,
    /* box + an inset basin outline */
    draw(g,k){ const m=Math.min(k.w,k.d)*0.22;
      _fbox(g,k,{stroke:k.color,"stroke-width":1.5});
      const pts=[k.P(-k.w/2+m,-k.d/2+m),k.P(k.w/2-m,-k.d/2+m),k.P(k.w/2-m,k.d/2-m),k.P(-k.w/2+m,k.d/2-m)];
      g.appendChild(el("polygon",{points:pts.map(p=>p.join(",")).join(" "),fill:"none",stroke:k.color,"stroke-width":1})); } },

  { type:"stove", label:"Stove", w:2.5, d:2.5,
    /* box + a 2x2 grid of burners */
    draw(g,k){ _fbox(g,k,{stroke:k.color,"stroke-width":1.5});
      [-1,1].forEach(sx=>[-1,1].forEach(sy=>{
        const cx=sx*k.w*0.22, cy=sy*k.d*0.22, r=Math.min(k.w,k.d)*0.12;
        const pts=[k.P(cx-r,cy-r),k.P(cx+r,cy-r),k.P(cx+r,cy+r),k.P(cx-r,cy+r)];
        g.appendChild(el("polygon",{points:pts.map(p=>p.join(",")).join(" "),fill:"none",stroke:k.color,"stroke-width":1}));
      })); } },

  { type:"toilet", label:"Toilet", w:1.5, d:2.5,
    /* box + a tank line near the back + a bowl outline toward the front */
    draw(g,k){ _fbox(g,k,{stroke:k.color,"stroke-width":1.5});
      const tankY = -k.d/2 + k.d*0.22;
      _ln(g, k.P(-k.w/2,tankY), k.P(k.w/2,tankY), {stroke:k.color,"stroke-width":1});
      const pts=[k.P(-k.w*0.32,tankY),k.P(k.w*0.32,tankY),k.P(k.w*0.4,k.d/2-k.d*0.1),k.P(-k.w*0.4,k.d/2-k.d*0.1)];
      g.appendChild(el("polygon",{points:pts.map(p=>p.join(",")).join(" "),fill:"none",stroke:k.color,"stroke-width":1})); } },

  { type:"shower", label:"Shower", w:3, d:3,
    /* box + a diagonal cross (standard shower-stall drain symbol) */
    draw(g,k){ _fbox(g,k,{stroke:k.color,"stroke-width":1.5});
      _ln(g, k.P(-k.w/2,-k.d/2), k.P(k.w/2,k.d/2), {stroke:k.color,"stroke-width":1});
      _ln(g, k.P(k.w/2,-k.d/2), k.P(-k.w/2,k.d/2), {stroke:k.color,"stroke-width":1}); } },

  { type:"tub", label:"Tub", w:2.5, d:5,
    /* box + an inset basin outline */
    draw(g,k){ const m=Math.min(k.w,k.d)*0.14;
      _fbox(g,k,{stroke:k.color,"stroke-width":1.5});
      const pts=[k.P(-k.w/2+m,-k.d/2+m),k.P(k.w/2-m,-k.d/2+m),k.P(k.w/2-m,k.d/2-m),k.P(-k.w/2+m,k.d/2-m)];
      g.appendChild(el("polygon",{points:pts.map(p=>p.join(",")).join(" "),fill:"none",stroke:k.color,"stroke-width":1})); } },

  { type:"table", label:"Table", w:3, d:5,
    /* plain box — a labeled rectangle is enough here */
    draw(g,k){ _fbox(g,k,{stroke:k.color,"stroke-width":1.5}); } },

  { type:"stairs", label:"Stairs", w:3.5, d:10,
    /* box + tread lines across the run + a dashed direction line */
    draw(g,k){ _fbox(g,k,{stroke:k.color,"stroke-width":1.5});
      const n=Math.max(3,Math.round(k.d/1));
      for(let i=1;i<n;i++){ const y=-k.d/2+k.d*i/n; _ln(g, k.P(-k.w/2,y), k.P(k.w/2,y), {stroke:k.color,"stroke-width":1}); }
      _ln(g, k.P(0,-k.d/2+k.d*0.1), k.P(0,k.d/2-k.d*0.1), {stroke:k.color,"stroke-width":1,"stroke-dasharray":"2 3"}); } },

  { type:"car", label:"Car", w:6, d:15,
    /* box + windshield/rear-window lines */
    draw(g,k){ _fbox(g,k,{stroke:k.color,"stroke-width":1.5});
      _ln(g, k.P(-k.w/2,-k.d*0.22), k.P(k.w/2,-k.d*0.22), {stroke:k.color,"stroke-width":1});
      _ln(g, k.P(-k.w/2,k.d*0.3), k.P(k.w/2,k.d*0.3), {stroke:k.color,"stroke-width":1}); } },

  { type:"truck", label:"Truck", w:6.5, d:20,
    /* box + a cab partition line */
    draw(g,k){ _fbox(g,k,{stroke:k.color,"stroke-width":1.5});
      _ln(g, k.P(-k.w/2,-k.d*0.32), k.P(k.w/2,-k.d*0.32), {stroke:k.color,"stroke-width":1}); } },
];

function fixtureTypeDef(type){ return FIXTURE_TYPES.find(t=>t.type===type) || null; }
function fixtureLabel(type){ const d=fixtureTypeDef(type); return d ? d.label : String(type); }
