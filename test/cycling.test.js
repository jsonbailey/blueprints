"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./harness");

/* Click-to-cycle through overlapping walls / corner points (js/tools.js
   cycleTarget, js/model.js wallsNear/pointsNear).

   A "click" here is what the browser does for a real press on a wall band
   or corner handle: call startDragWall/startDragPoint with the id of the
   element it hit (always the TOPMOST painted one at that pixel — the DOM
   doesn't change paint order on selection), then end the interaction as
   pointerup would. View is pinned to scale 20 px/ft, origin 0, so world
   (x,y) ft is client (20x, 20y) px (the stub svg's box sits at 0,0). */

const SETUP = `
  view.scale=20; view.ox=0; view.oy=0;
  const P = (id,x,y)=>({id,x,y});
  function install(f){ indexLevel(f); data.levels=[f]; data.activeLevelId=f.id; history.length=0; sel={type:null,id:null}; cycleLast=null; return f; }
  /* A (0..10) and B (10..20) side by side, sharing the wall at x=10 */
  function setupShared(){
    const f = makeLevel("T", []);
    f.points = [P("a1",0,0),P("a2",10,0),P("a3",10,10),P("a4",0,10),
                P("b2",20,0),P("b3",20,10)];
    f.rooms = [{id:"rA",name:"A",kind:"room",loop:["a1","a2","a3","a4"]},
               {id:"rB",name:"B",kind:"room",loop:["a2","b2","b3","a3"]}];
    return install(f);
  }
  const W = (f,a,b) => wallById(f, wallIdForKey(wallKey(a,b)));
  function ev(x,y){ return { clientX:x*20, clientY:y*20, stopPropagation(){}, pointerId:1, button:0 }; }
  function click(kind, nativeId, x, y){
    const e=ev(x,y);
    (kind==="wall" ? startDragWall : startDragPoint)(e, nativeId);
    if(interaction) interactionHandlers[interaction.kind].end(interaction, e);
    return sel.type===kind ? sel.id : null;
  }
  /* what the browser would hit: the LAST-painted handle/band for this id set */
  function paintOrder(attr){
    const out=[]; (function walk(n){ (n.children||[]).forEach(c=>{ if(c.dataset && c.dataset[attr]) out.push(c.dataset[attr]); walk(c); }); })(svg);
    return out;
  }
`;
const vmRun = (run, body) => run(new Function(SETUP + body));

test("wallsNear / pointsNear: topmost-first order matches render()'s paint order", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupShared();
    detachRoom(f, f.rooms[1]);                       // B's copy of the shared wall gets fresh ids
    render();
    const walls = wallsNear(f, 10, 5, 0.1).map(w=>w.id);
    const order = paintOrder("wall").filter(id=>walls.includes(id));
    const pts = pointsNear(f, 10, 0).map(p=>p.id);
    const porder = paintOrder("point").filter(id=>pts.includes(id));
    return { walls, order, pts, porder, fwalls: f.walls.map(w=>w.id) };
  `);
  assert.equal(r.walls.length, 2, "two coincident walls at x=10 after detach");
  assert.deepEqual(r.walls, r.order.slice().reverse(), "first candidate = last painted (topmost)");
  assert.equal(r.walls[0], r.fwalls.filter(id=>r.walls.includes(id)).pop(), "topmost = later in f.walls");
  assert.equal(r.pts.length, 2);
  assert.deepEqual(r.pts, r.porder.slice().reverse(), "point candidates topmost first too");
});

test("two coincident walls: click selects topmost, second click the one underneath, third wraps", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupShared();
    detachRoom(f, f.rooms[1]);
    const [top, under] = wallsNear(f, 10, 5, 0.1).map(w=>w.id);
    const seq = [1,2,3,4].map(()=>click("wall", top, 10, 5));   // the browser always hits the top band
    return { top, under, seq };
  `);
  assert.notEqual(r.top, r.under);
  assert.deepEqual(r.seq, [r.top, r.under, r.top, r.under]);
});

test("cycling also arms the drag on the resolved wall, not the pressed element", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupShared();
    detachRoom(f, f.rooms[1]);
    const [top, under] = wallsNear(f, 10, 5, 0.1).map(w=>w.id);
    click("wall", top, 10, 5);
    startDragWall(ev(10,5), top);                   // second press, held
    const armed = interaction && interaction.id;
    interactionHandlers.wall.end(interaction);
    return { under, armed };
  `);
  assert.equal(r.armed, r.under);
});

test("a single wall: repeated clicks keep it selected (no drift, no error)", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupShared();
    const id = W(f,"a1","a2").id;                    // A's top wall, y=0
    const cands = wallsNear(f, 5, 0, w=>wallHitTol(f,w)).map(w=>w.id);
    return { id, cands, seq: [1,2,3,4,5].map(()=>click("wall", id, 5, 0)) };
  `);
  assert.deepEqual(r.cands, [r.id]);
  assert.deepEqual(r.seq, [r.id, r.id, r.id, r.id, r.id]);
});

test("near a corner, a repeat press does not jump to the perpendicular neighbour", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupShared();
    const id = W(f,"a1","a2").id;                    // press 10px from corner a1 along the top wall
    return { id, seq: [1,2,3].map(()=>click("wall", id, 0.5, 0)) };
  `);
  assert.deepEqual(r.seq, [r.id, r.id, r.id]);
});

test("first press uses the element the browser hit, even if it isn't first in the list", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupShared();
    detachRoom(f, f.rooms[1]);
    const [top, under] = wallsNear(f, 10, 5, 0.1).map(w=>w.id);
    return { under, first: click("wall", under, 10, 5), second: click("wall", under, 10, 5), top };
  `);
  assert.equal(r.first, r.under);
  assert.equal(r.second, r.top, "then wraps around to the top");
});

test("two distinct unwelded points at one spot cycle; a welded corner has one candidate", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupShared();
    // a2 is WELDED: one point id shared by A and B
    const welded = pointsNear(f, 10, 0).map(p=>p.id);
    const weldedSeq = [1,2,3].map(()=>click("point", "a2", 10, 0));
    detachCorner(f, "a2");                            // B gets its own point at (10,0)
    const ids = pointsNear(f, 10, 0).map(p=>p.id);
    sel={type:null,id:null}; cycleLast=null;
    const seq = [1,2,3].map(()=>click("point", ids[0], 10, 0));
    return { welded, weldedSeq, ids, seq };
  `);
  assert.deepEqual(r.welded, ["a2"], "welded corner: exactly one candidate");
  assert.deepEqual(r.weldedSeq, ["a2", "a2", "a2"]);
  assert.equal(r.ids.length, 2);
  assert.deepEqual(r.seq, [r.ids[0], r.ids[1], r.ids[0]]);
});

test("clicking a different wall in between resets the cycle to the top", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupShared();
    detachRoom(f, f.rooms[1]);
    const [top, under] = wallsNear(f, 10, 5, 0.1).map(w=>w.id);
    const a = click("wall", top, 10, 5);
    const b = click("wall", top, 10, 5);             // now on the one underneath
    const other = W(f,"a1","a4").id;                 // A's left wall, x=0
    const c = click("wall", other, 0, 5);
    const d = click("wall", top, 10, 5);             // back: starts over at the top
    return { top, under, other, a, b, c, d };
  `);
  assert.deepEqual([r.a, r.b, r.c, r.d], [r.top, r.under, r.other, r.top]);
});

test("a pan (clears the selection) in between also resets the cycle", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupShared();
    detachRoom(f, f.rooms[1]);
    const [top, under] = wallsNear(f, 10, 5, 0.1).map(w=>w.id);
    click("wall", top, 10, 5);
    clearSel();
    return { top, after: click("wall", top, 10, 5) };
  `);
  assert.equal(r.after, r.top);
});
