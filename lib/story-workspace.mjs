import {captionSettings,audioSettings,MAX_MUSIC_BYTES} from './story-overlays.mjs';
import {trimRange} from './story-trim.mjs';
import {publishDraft,MAX_COVER_BYTES} from './publish-kit.mjs';
import {narrationSettings,MAX_NARRATION_BYTES} from './story-narration.mjs';
// Local editing records are separate from Builder's project and generation state.
export const MAX_CLIP_BYTES=150*1024*1024, MAX_TOTAL_BYTES=1024*1024*1024;
export function projectTitle(p){
  const part=Number(p.setup?.partNumber||1);
  return String(p.project?.title||'Untitled story').replace(new RegExp('\\s*(?:[Â·â€”â€“-]\\s*Part\\s+'+part+'|\\(Part\\s+'+part+'\\))\\s*$','i'),'').trim()||'Untitled story';
}
export function sceneOrder(scenes, saved=[]){
  const valid=new Set(scenes.map(s=>s.id));
  return [...new Set([...saved.filter(id=>valid.has(id)),...scenes.map(s=>s.id)])];
}
export function moveScene(order,id,delta){
  const next=[...order],from=next.indexOf(id),to=from+delta;
  if(from>=0&&to>=0&&to<next.length)[next[from],next[to]]=[next[to],next[from]];
  return next;
}
export function matchingScene(name,project){
  // Chrome numbers repeat downloads ("p01_scene_004 (24).mp4"); that suffix still means the same scene (owner 2026-10-28).
  const base=String(name).split(/[\\/]/).pop().toLowerCase().replace(/ \(\d+\)(?=\.mp4$)/,'');
  const part=String(project.setup?.partNumber||1).padStart(2,'0');
  return project.project.scenes.find(s=>base===`p${part}_${s.id}.mp4`.toLowerCase())?.id||null;
}
export function validateClip(blob){
  if(!(blob instanceof Blob)||!blob.size)throw Error('Choose a video file.');
  if(blob.size>MAX_CLIP_BYTES)throw Error('This clip exceeds the 150 MB local limit. Choose a smaller video.');
}
export function sceneVersion(project,id){
  const s=project.project.scenes.find(s=>s.id===id);
  if(!s)return '';
  return JSON.stringify([s.videoPrompt||'',s.speech||'',project.media?.[id]?.sha256||'',(s.references||[]).map(ref=>[ref,project.media?.[ref]?.sha256||''])]);
}
let database;
function db(){return database ||= new Promise((resolve,reject)=>{
  const r=indexedDB.open('flow-story-workspace',1);
  r.onupgradeneeded=()=>{r.result.createObjectStore('clips',{keyPath:'key'});r.result.createObjectStore('edits',{keyPath:'id'});};
  r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
});}
async function run(store,mode,fn){const d=await db();return new Promise((resolve,reject)=>{
  const tx=d.transaction(store,mode),r=fn(tx.objectStore(store));
  tx.oncomplete=()=>resolve(r?.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Local save cancelled.'));
});}
export async function projects(){
  const d=await new Promise((resolve,reject)=>{const r=indexedDB.open('flow-faceless-projects',1);r.onupgradeneeded=()=>r.result.createObjectStore('projects',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try{return await new Promise((resolve,reject)=>{const tx=d.transaction('projects','readonly'),r=tx.objectStore('projects').getAll();tx.oncomplete=()=>resolve(r.result.filter(p=>p.project?.scenes));tx.onerror=()=>reject(tx.error);});}finally{d.close();}
}
export async function clips(projectId){return (await run('clips','readonly',s=>s.getAll())).filter(c=>c.projectId===projectId);}
export async function putClip(projectId,sceneId,blob,name){
  validateClip(blob);
  // Verify this key against the current project before saving any captured or imported media.
  const p=(await projects()).find(p=>p.id===projectId);
  if(!p?.project.scenes.some(s=>s.id===sceneId))throw Error('This scene no longer exists.');
  const key=projectId+':'+sceneId,existing=await clips(projectId);
  if(existing.filter(c=>c.key!==key).reduce((n,c)=>n+c.blob.size,blob.size)>MAX_TOTAL_BYTES)throw Error('This project exceeds the 1 GB local clip limit.');
  await run('clips','readwrite',s=>s.put({key,projectId,sceneId,blob,name:String(name||sceneId+'.mp4'),updatedAt:Date.now(),sourceVersion:sceneVersion(p,sceneId)}));
  const channel=new BroadcastChannel('flow-story-workspace');channel.postMessage({projectId});channel.close();
}
export async function edit(projectId){return await run('edits','readonly',s=>s.get(projectId))||{id:projectId,order:[]};}
export async function saveOrder(projectId,order){return patchEdit(projectId,{order:[...order]});}
// Finish settings (lib/story-finish.mjs): subtitles, titles, export quality.
export async function saveFinish(projectId,finish){return patchEdit(projectId,{finish});}
export async function savePublish(projectId,draft){return patchEdit(projectId,{publish:publishDraft(draft)});}
export async function requestCover(projectId,requestId){return patchEdit(projectId,{coverRequestId:requestId});}
export async function saveGeneratedCover(projectId,requestId,blob,poster={}){
  if(!(blob instanceof Blob)||!blob.size||blob.size>MAX_COVER_BYTES||!/^image\//.test(blob.type))throw Error('Cover must be an image under 20 MB.');
  const d=await db();await new Promise((resolve,reject)=>{
    const tx=d.transaction('edits','readwrite'),s=tx.objectStore('edits'),r=s.get(projectId);let error;
    r.onsuccess=()=>{if(r.result?.coverRequestId!==requestId){error=Error('This cover request is no longer current.');tx.abort();return;}s.put({...r.result,cover:{blob,requestId,updatedAt:Date.now(),headline:String(poster.headline||'').slice(0,90),position:poster.position==='top'?'top':'bottom'}});};
    tx.oncomplete=resolve;tx.onerror=()=>reject(error||tx.error);tx.onabort=()=>reject(error||tx.error||Error('Cover could not be saved.'));
  });
  const channel=new BroadcastChannel('flow-story-workspace');channel.postMessage({projectId});channel.close();
}
async function patchEdit(projectId,patch){
  const d=await db();await new Promise((resolve,reject)=>{
    const tx=d.transaction('edits','readwrite'),store=tx.objectStore('edits'),request=store.get(projectId);
    request.onsuccess=()=>store.put({...request.result,id:projectId,...patch});
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Story settings could not be saved.'));
  });
  const channel=new BroadcastChannel('flow-story-workspace');channel.postMessage({projectId});channel.close();
}
export async function saveAudio(projectId,audio){const levels=audioSettings(audio);if(audio.music&&(!(audio.music instanceof Blob)||audio.music.size>MAX_MUSIC_BYTES))throw Error('Choose an audio file under 30 MB.');return patchEdit(projectId,{audio:{...levels,music:audio.music||null,name:String(audio.name||''),libraryId:audio.music?String(audio.libraryId||''):'',updatedAt:Date.now()}});}
export async function removeProject(projectId){
  for(const c of await clips(projectId))await run('clips','readwrite',s=>s.delete(c.key));
  await run('edits','readwrite',s=>s.delete(projectId));
  await removeNarration(projectId).catch(()=>{});
}
// ---------- Narration (AI narration plan, owner 2026-10-31) ----------
// Its own database, not a version upgrade of flow-story-workspace: an older extension (after a revert) still opens the
// workspace as before and simply never sees this one. 'records' holds the settings and take metadata; 'audio' holds
// each take's bytes once, so timing edits never rewrite audio.
let narrationDb;
function ndb(){return narrationDb ||= new Promise((resolve,reject)=>{
  const r=indexedDB.open('flow-story-narration',1);
  r.onupgradeneeded=()=>{r.result.createObjectStore('records',{keyPath:'projectId'});r.result.createObjectStore('audio',{keyPath:'takeId'}).createIndex('projectId','projectId');};
  r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
});}
async function nrun(stores,mode,fn){const d=await ndb();return new Promise((resolve,reject)=>{
  const tx=d.transaction(stores,mode),out=fn(tx);
  tx.oncomplete=()=>resolve(out?.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Narration could not be saved.'));
});}
const notifyNarration=projectId=>{const channel=new BroadcastChannel('flow-story-workspace');channel.postMessage({projectId});channel.close();};
export async function narration(projectId){const r=await nrun('records','readonly',tx=>tx.objectStore('records').get(projectId));if(!r)return null;const {projectId:_,...rest}=r;return rest;}
export async function saveNarration(projectId,record){
  const clean=narrationSettings(record);
  await nrun('records','readwrite',tx=>tx.objectStore('records').put({projectId,...clean}));notifyNarration(projectId);return clean;
}
export async function narrationAudio(takeId){return (await nrun('audio','readonly',tx=>tx.objectStore('audio').get(takeId)))?.blob||null;}
// Adds a take (metadata + bytes) in one transaction. The previous takes stay until the user removes them.
export async function addNarrationTake(projectId,record,take,blob){
  if(!(blob instanceof Blob)||!blob.size||blob.size>MAX_NARRATION_BYTES)throw Error('Choose a narration file under 30 MB.');
  const clean=narrationSettings({...record,takes:[...(record.takes||[]),take]});
  await nrun(['records','audio'],'readwrite',tx=>{tx.objectStore('audio').put({takeId:take.id,projectId,blob});tx.objectStore('records').put({projectId,...clean});});
  notifyNarration(projectId);return clean;
}
export async function removeNarrationTake(projectId,record,takeId){
  const clean=narrationSettings({...record,takes:record.takes.filter(t=>t.id!==takeId),selectedTakeId:record.selectedTakeId===takeId?'':record.selectedTakeId,timing:record.timing?.takeId===takeId?null:record.timing});
  await nrun(['records','audio'],'readwrite',tx=>{tx.objectStore('audio').delete(takeId);tx.objectStore('records').put({projectId,...clean});});
  notifyNarration(projectId);return clean;
}
// Backup (lib/project-backup.mjs): each story's record with its selected take only.
export async function backupNarrations(){
  const all=await nrun('records','readonly',tx=>tx.objectStore('records').getAll()),out=[];
  for(const r of all||[]){const take=r.takes?.find(t=>t.id===r.selectedTakeId);const blob=take&&await narrationAudio(take.id);if(!blob)continue;const {projectId,...rest}=r;out.push({projectId,blob,record:{...rest,takes:[take],timing:rest.timing?.takeId===take.id?rest.timing:null}});}
  return out;
}
export async function narrationIds(){return (await nrun('records','readonly',tx=>tx.objectStore('records').getAllKeys()))||[];}
export async function restoreNarration(projectId,record,take,blob){
  if(await narration(projectId))return false;
  await addNarrationTake(projectId,{...record,takes:[]},take,blob);return true;
}
export async function removeNarration(projectId){
  await nrun(['records','audio'],'readwrite',tx=>{
    tx.objectStore('records').delete(projectId);const req=tx.objectStore('audio').index('projectId').openCursor(IDBKeyRange.only(projectId));
    req.onsuccess=()=>{const c=req.result;if(c){c.delete();c.continue();}};
  });
}

export async function saveTrim(projectId,sceneId,expectedVersion,trim,duration,caption){
  const range=trimRange(duration,trim),text=caption===undefined?undefined:captionSettings(caption),d=await db(),key=projectId+':'+sceneId;
  await new Promise((resolve,reject)=>{
    const tx=d.transaction('clips','readwrite'),store=tx.objectStore('clips'),request=store.get(key);let error;
    request.onsuccess=()=>{
      const clip=request.result;
      if(!clip||clip.updatedAt!==expectedVersion){error=Error('This clip changed. Reopen Trim for the new video.');tx.abort();return;}
      store.put({...clip,trim:trim?{start:range.start,end:range.end}:null,...(text===undefined?{}:{caption:text})});
    };
    tx.oncomplete=resolve;tx.onerror=()=>reject(error||tx.error);tx.onabort=()=>reject(error||tx.error||Error('Trim could not be saved.'));
  });
  const channel=new BroadcastChannel('flow-story-workspace');channel.postMessage({projectId});channel.close();
}
