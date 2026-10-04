"use strict";

/* ---------- persisted schema + migrations ----------
   Every persisted plan (saved .json, undo snapshots, the Reset baseline)
   carries `schemaVersion`. To change the persisted shape: append a migration
   function to `migrations` and bump CURRENT_SCHEMA_VERSION — never change the
   shape silently. migrations[i] upgrades a raw object from version i to i+1
   and must be pure (no globals, no id minting); it may leave level ids /
   names / `visible` unset, since loadData() fills those in afterwards. */
const CURRENT_SCHEMA_VERSION = 1;
/* Per-level field list, shared by stripIdx (save/undo serialization) and
   loadData (deserialization) so the two can't drift apart — a field added to
   only one of them would silently vanish from save/undo/autosave on round
   trip. `id`/`name`/`visible` get special handling in loadData (regenerated
   when missing/duplicate/invalid); everything else in the list is treated as
   opaque per-level data that defaults to `[]` when absent. Future per-level
   fields (e.g. `objects`, `wallProps`, `defaultThickness`) should be added
   here once; if a future field isn't array-shaped (e.g. `wallProps` as a
   dict, `defaultThickness` as a number), give it its own default in
   loadData rather than forcing it through the `[]` convention below. */
const LEVEL_META_FIELDS = ["id","name","visible"];
const LEVEL_DATA_FIELDS = ["points","walls","rooms"];
const LEVEL_FIELDS = [...LEVEL_META_FIELDS, ...LEVEL_DATA_FIELDS];
const migrations = [
  /* 0 → 1: pre-versioning files used two fixed floors {main, basement}.
     They become two levels "Main" and "Basement" (both visible), Main active.
     Ids are left unset for loadData() to mint. */
  function fromLegacyMainBasement(raw){
    if(Array.isArray(raw.levels)) return {...raw};   // unversioned but already level-shaped
    if(!raw.main || !raw.basement) throw new Error("not a saved plan: no levels or main/basement floors");
    const {main, basement, ...rest} = raw;
    return {...rest,
      levels:[ {...main, name:"Main", visible:true}, {...basement, name:"Basement", visible:true} ],
      activeLevelId:null};
  },
];
/* Upgrade a raw parsed plan object of any known version to the current
   schema. Generic dispatcher — standalone so other persistence paths can
   reuse it. Does not mutate `raw`. Throws if the object isn't a plan or was
   written by a newer version of the app. */
function migrateData(raw){
  if(!raw || typeof raw!=="object" || Array.isArray(raw)) throw new Error("not a saved plan");
  let v = raw.schemaVersion==null ? 0 : raw.schemaVersion;
  if(!Number.isInteger(v) || v<0) throw new Error("invalid schemaVersion");
  if(v > CURRENT_SCHEMA_VERSION){
    const err=new Error("schemaVersion "+v+" is newer than this app supports ("+CURRENT_SCHEMA_VERSION+")");
    err.tooNew=true; throw err;
  }
  let obj = raw;
  while(v < CURRENT_SCHEMA_VERSION){ obj = migrations[v](obj); v++; }
  obj = {...obj, schemaVersion:CURRENT_SCHEMA_VERSION};
  if(!Array.isArray(obj.levels)) throw new Error("not a saved plan: missing levels");
  return obj;
}

/* Plain-JSON form of the plan (no _pt index), at the current schema version —
   used for save, undo snapshots and the Reset baseline. */
function stripIdx(d){
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    activeLevelId: d.activeLevelId,
    levels: d.levels.map(l=>{
      const out={};
      LEVEL_FIELDS.forEach(k=>{ out[k]=l[k]; });
      return out;
    }),
  };
}

/* Pure deserializer: turn a parsed plan object of any supported schema
   version (migrated first via migrateData) into a brand new {levels,
   activeLevelId} state object, WITHOUT reading or assigning the global
   `data` — callers decide whether/when to commit the result to `data`
   (`data = loadData(raw)`). Never mutates `raw`. Normalizes along the way:
   missing/duplicate level ids are minted fresh, missing names become
   "Level N", missing `visible` defaults to true, and an unknown
   activeLevelId falls back to the first level. Throws if the object isn't a
   plan (callers should leave their own state untouched on throw). */
function loadData(raw){
  const obj = migrateData(raw);
  const src = obj.levels.filter(l=>l && typeof l==="object");
  let activeId = obj.activeLevelId;
  syncIds({levels:src});               // bump _pid/_lid above everything in the file first
  const seen=new Set();
  const levels = src.map((l,i)=>{
    const id = (typeof l.id==="string" && l.id && !seen.has(l.id)) ? l.id : "lvl"+(_lid++);
    seen.add(id);
    const name = (typeof l.name==="string" && l.name.trim()) ? l.name : "Level "+(i+1);
    const out = {id, name, visible: l.visible!==false};
    LEVEL_DATA_FIELDS.forEach(k=>{
      const v = l[k];
      out[k] = Array.isArray(v) ? v.map(item=>Array.isArray(item.loop) ? {...item, loop:[...item.loop]} : {...item}) : [];
    });
    return indexLevel(out);
  });
  if(!levels.length) levels.push(makeLevel("Level 1", []));
  if(!levels.some(l=>l.id===activeId)) activeId = levels[0].id;
  const result = {levels, activeLevelId:activeId};
  syncIds(result);
  return result;
}

function freshData(){
  const lvl = makeLevel("Level 1", SEED_RECTS);
  const d = { levels:[lvl], activeLevelId:lvl.id };
  syncIds(d);
  return d;
}
