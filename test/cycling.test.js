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

test("repeat press that becomes a DRAG drags the already-selected wall, without cycling", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupShared();
    detachRoom(f, f.rooms[1]);
    const [top, under] = wallsNear(f, 10, 5, 0.1).map(w=>w.id);
    const xs = id => { const w=wallById(f,id); return [ptOf(f,w.a).x, ptOf(f,w.b).x]; };
    const first = click("wall", top, 10, 5);         // selects the top wall
    startDragWall(ev(10,5), top);                     // repeat press at the same spot...
    const selAtPress = sel.id, armed = interaction.id, pending = interaction.pendingCycleId;
    interactionHandlers.wall.move(interaction, ev(12,5));   // ...that moves 40px: a real drag
    interactionHandlers.wall.end(interaction, ev(12,5));
    return { top, under, first, selAtPress, armed, pending, after: sel.id, topXs: xs(top), underXs: xs(under) };
  `);
  assert.equal(r.first, r.top);
  assert.equal(r.selAtPress, r.top, "the press itself does not reselect");
  assert.equal(r.armed, r.top, "the drag is armed on the selected wall");
  assert.equal(r.pending, r.under, "the advance is only pending");
  assert.equal(r.after, r.top, "after the drag the same wall is still selected");
  assert.deepEqual(r.topXs, [12, 12], "the selected wall is what moved");
  assert.deepEqual(r.underXs, [10, 10], "the wall underneath stayed put");
});

test("repeat press released WITHOUT moving (a plain click) advances the cycle", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupShared();
    detachRoom(f, f.rooms[1]);
    const [top, under] = wallsNear(f, 10, 5, 0.1).map(w=>w.id);
    click("wall", top, 10, 5);
    startDragWall(ev(10,5), top);
    const during = sel.id;                            // still the top wall while held
    interactionHandlers.wall.move(interaction, { clientX: 201, clientY: 100 });   // jitter under DRAG_PX
    interactionHandlers.wall.end(interaction, ev(10,5));
    const w=wallById(f,top);
    return { top, under, during, after: sel.id, topX: ptOf(f,w.a).x };
  `);
  assert.equal(r.during, r.top);
  assert.equal(r.after, r.under, "click released → next one underneath");
  assert.equal(r.topX, 10, "nothing moved");
});

test("corner: a repeat press that drags moves the selected point; a plain click advances", () => {
  const { run } = loadApp();
  const r = vmRun(run, `
    const f = setupShared();
    opts.snapConnect = false;                         // keep the drop where it lands (no re-weld)
    detachCorner(f, "a2");
    const [top, under] = pointsNear(f, 10, 0).map(p=>p.id);
    click("point", top, 10, 0);
    startDragPoint(ev(10,0), top);
    const armed = interaction.id;
    interactionHandlers.point.move(interaction, ev(11,1));
    interactionHandlers.point.end(interaction, ev(11,1));
    const dragged = { sel: sel.id, top: {x:ptOf(f,top).x, y:ptOf(f,top).y}, under: {x:ptOf(f,under).x, y:ptOf(f,under).y} };
    // now the two are apart; put the top one back and click twice
    ptOf(f,top).x=10; ptOf(f,top).y=0; cycleLast=null; sel={type:null,id:null};
    const clicks = [click("point", top, 10, 0), click("point", top, 10, 0)];
    return { top, under, armed, dragged, clicks };
  `);
  assert.equal(r.armed, r.top);
  assert.equal(r.dragged.sel, r.top);
  assert.deepEqual(r.dragged.top, { x: 11, y: 1 }, "the selected point moved");
  assert.deepEqual(r.dragged.under, { x: 10, y: 0 }, "the one underneath did not");
  assert.deepEqual(r.clicks, [r.top, r.under]);
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

/* ---------------- owning-room highlight for a selected wall ---------------- */

const ROOM_STYLES = `
  function roomStyles(){
    render();
    const out={}; (function walk(n){ (n.children||[]).forEach(c=>{
      if(c.tagName==="POLYGON" && c.dataset && c.dataset.room) out[c.dataset.room]={
        fill:c.getAttribute("fill"), stroke:c.getAttribute("stroke"), dash:c.getAttribute("stroke-dasharray"), cls:c.getAttribute("class") };
      walk(c); }); })(svg);
    return out;
  }
`;

test("selected wall highlights its owning room(s), distinctly from a direct room selection", () => {
  const { run } = loadApp();
  const r = vmRun(run, ROOM_STYLES + `
    const f = setupShared();
    sel={type:"wall", id:W(f,"a2","a3").id};      const shared = roomStyles();
    sel={type:"wall", id:W(f,"a1","a2").id};      const exterior = roomStyles();
    sel={type:"room", id:"rA"};                   const roomSel = roomStyles();
    sel={type:null, id:null};                     const none = roomStyles();
    return { shared, exterior, roomSel, none };
  `);
  assert.equal(r.shared.rA.cls, "wall-owner"); assert.equal(r.shared.rB.cls, "wall-owner", "shared wall: both rooms");
  assert.equal(r.exterior.rA.cls, "wall-owner"); assert.equal(r.exterior.rB.cls, null, "exterior wall: only its room");
  assert.equal(r.exterior.rB.fill, r.none.rB.fill, "non-owner unchanged");
  assert.notEqual(r.exterior.rA.fill, r.none.rA.fill, "owner gets a tint");
  // distinct from a direct room selection: different fill, no dashed markup outline
  assert.notEqual(r.exterior.rA.fill, r.roomSel.rA.fill);
  assert.equal(r.roomSel.rA.stroke, "var(--markup)"); assert.equal(r.roomSel.rA.dash, "4 4");
  assert.equal(r.exterior.rA.stroke, "none"); assert.equal(r.exterior.rA.dash, "none");
  assert.equal(r.roomSel.rA.cls, null, "a directly selected room is not marked as a wall owner");
});
