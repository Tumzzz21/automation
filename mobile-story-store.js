// Same IndexedDB stores/schema as Builder and Story Workspace; no panel is required.
const mobileStoryDBs=new Map();
function mobileDatabase(name,stores) {
  if(!mobileStoryDBs.has(name))mobileStoryDBs.set(name,new Promise((resolve,reject)=>{
    const r=indexedDB.open(name,1);r.onupgradeneeded=()=>{for(const [store,keyPath] of stores)if(!r.result.objectStoreNames.contains(store))r.result.createObjectStore(store,{keyPath});};
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>{mobileStoryDBs.delete(name);reject(r.error);};
  }));return mobileStoryDBs.get(name);
}
async function mobileProject(id,mutate=null) {
  const db=await mobileDatabase('flow-faceless-projects',[['projects','id']]);
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('projects',mutate?'readwrite':'readonly'),store=tx.objectStore('projects'),r=store.get(id);let value;
    r.onsuccess=()=>{try{value=r.result;if(!value?.project)throw Error('AI Story project no longer exists');if(mutate){mutate(value);store.put(value);}}catch(e){reject(e);tx.abort();}};
    tx.oncomplete=()=>resolve(value);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Project save cancelled'));
  });
}
function mobileSceneVersion(p,id) {
  const s=p.project.scenes.find(s=>s.id===id);if(!s)return '';
  return JSON.stringify([s.videoPrompt||'',s.speech||'',p.media?.[id]?.sha256||'',(s.references||[]).map(ref=>[ref,p.media?.[ref]?.sha256||''])]);
}
function mobileStoryVersion(p,item) {
  if(item.kind==='video')return mobileSceneVersion(p,item.sceneId);
  const x=[...p.project.assets,...p.project.scenes].find(x=>x.id===item.imageId);
  return x?JSON.stringify([x.imagePrompt,(x.references||[]).map(id=>[id,p.media?.[id]?.sha256||''])]):'';
}
async function mobileStoryClips(id) {
  const db=await mobileDatabase('flow-story-workspace',[['clips','key'],['edits','id']]);
  return new Promise((resolve,reject)=>{const tx=db.transaction('clips','readonly'),r=tx.objectStore('clips').getAll();tx.oncomplete=()=>resolve(r.result.filter(c=>c.projectId===id));tx.onerror=()=>reject(tx.error);});
}
function mobileImageType(bytes) {
  const b=new Uint8Array(bytes);
  if(b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)return {type:'image/jpeg',ext:'jpg'};
  if(b[0]===137&&b[1]===80&&b[2]===78&&b[3]===71)return {type:'image/png',ext:'png'};
  if(String.fromCharCode(...b.slice(0,4))==='RIFF'&&String.fromCharCode(...b.slice(8,12))==='WEBP')return {type:'image/webp',ext:'webp'};
  throw Error('Generated image has an invalid file signature');
}
function mobileMP4(bytes) {const b=new Uint8Array(bytes);return b.length>=100*1024&&String.fromCharCode(...b.slice(4,8))==='ftyp';}
async function mobileSaveStoryImage(item,bytes) {
  const {type,ext}=mobileImageType(bytes),blob=new Blob([bytes],{type});
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
  await mobileProject(item.projectId,p=>{
    if(mobileStoryVersion(p,item)!==item.sourceVersion)throw Error('Image prompt or references changed; generated image retained in Flow');
    p.media||={};p.media[item.imageId]={blob,name:`p${String(p.setup.partNumber||1).padStart(2,'0')}_${item.imageId}.${ext}`,sha256:hash};
    if(item.imageId.startsWith('asset_')){p.videoDoneIds=[];p.staleSceneIds=[...new Set([...(p.staleSceneIds||[]),...p.project.scenes.filter(s=>(s.references||[]).includes(item.imageId)&&p.media[s.id]).map(s=>s.id)])];}
    else {p.videoDoneIds=(p.videoDoneIds||[]).filter(id=>id!==item.imageId);p.staleSceneIds=(p.staleSceneIds||[]).filter(id=>id!==item.imageId);}
    p.redoIds=(p.redoIds||[]).filter(id=>id!==item.imageId);p.imagesReviewed=false;p.state='prompts_ready';
  });
  return {blob,ext};
}
async function mobileSaveStoryClip(item,bytes) {
  if(!mobileMP4(bytes))throw Error('Workspace capture is not a valid MP4');
  const p=await mobileProject(item.projectId);
  if(mobileStoryVersion(p,item)!==item.sourceVersion)throw Error('Scene changed while its video was generating; downloaded file retained');
  const blob=new Blob([bytes],{type:'video/mp4'}),existing=await mobileStoryClips(p.id),key=p.id+':'+item.sceneId;
  if(blob.size>150*1024*1024||existing.filter(c=>c.key!==key).reduce((n,c)=>n+c.blob.size,blob.size)>1024*1024*1024)throw Error('Story Workspace media size limit reached');
  const db=await mobileDatabase('flow-story-workspace',[['clips','key'],['edits','id']]);
  await new Promise((resolve,reject)=>{const tx=db.transaction('clips','readwrite');tx.objectStore('clips').put({key,projectId:p.id,sceneId:item.sceneId,blob,name:item.filename,updatedAt:Date.now(),sourceVersion:item.sourceVersion});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
  await mobileProject(p.id,current=>{if(mobileStoryVersion(current,item)!==item.sourceVersion)throw Error('Scene changed; clip saved as an older version');current.videoDoneIds=[...new Set([...(current.videoDoneIds||[]),item.sceneId])];if(current.downloadedClipVersions)delete current.downloadedClipVersions[item.sceneId];});
  const channel=new BroadcastChannel('flow-story-workspace');channel.postMessage({projectId:p.id});channel.close();
}
async function mobileMarkDownloadedClip(item) {
  if(!item.diskSaved||!item.projectId||!item.sceneId)throw Error('No confirmed downloaded scene to preserve.');
  await mobileProject(item.projectId,p=>{
    p.downloadedClipVersions||={};p.downloadedClipVersions[item.sceneId]={sourceVersion:item.sourceVersion,name:item.outputName||item.filename,downloadId:item.downloadId,savedAt:Date.now()};
  });
}
async function mobileBlobData(blob,name) {
  const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return {name,type:blob.type,dataUrl:`data:${blob.type};base64,${btoa(binary)}`};
}
async function mobileStoryPlan(job) {
  const p=await mobileProject(job.storyId);const B=globalThis.FacelessBuilder;
  B.validateProject(p.project,p.setup);
  if(p.libraryCastReview)throw Error('Review the saved character references before Auto');
  const targets=B.generationTargets(p.target,job.settings);
  if(targets.videoPlatform!=='flow')throw Error('This mobile worker requires Flow video generation');
  if(p.setup.exportProfile==='Recurring assets + video')throw Error('Mobile Story pilot currently needs Scene image + video; Ingredients routing is not enabled');
  if(p.setup.imageMode==='Prompts only')throw Error('This story is set to prompts only');
  if(p.sceneImageMode==='sheets')throw Error('Select one image per scene for the mobile worker pilot');
  // Wide 16:9 stories (owner 2026-11-11): same rewording and landscape setting as the panel queue (story-shape.js).
  const wide=!!globalThis.StoryShape?.isLandscape(p),shaped=text=>globalThis.StoryShape?globalThis.StoryShape.text(p,text):String(text);
  if(p.aspect==='16:9'&&!globalThis.StoryShape)throw Error('Wide 16:9 stories need the standard story queue on this build');
  if(p.pronunciations?.trim())throw Error('Custom pronunciations need standard story queue; worker support pending');
  const valid=x=>p.media?.[x.id]?.blob?.size>0&&/^[a-f0-9]{64}$/.test(p.media[x.id].sha256||'')&&!(p.redoIds||[]).includes(x.id);
  const asset=p.project.assets.find(x=>!valid(x));
  const scene=!asset?p.project.scenes.find(x=>!valid(x)||(p.staleSceneIds||[]).includes(x.id)):null;
  const image=asset||scene;
  if(image&&targets.imagePlatform!=='flow')throw Error('Finish and save all reference and scene images in the selected image engine before starting Flow videos');
  if(image) {
    if(Number(p.setup.niche)===56&&image.id==='asset_001')throw Error('Upload the original product reference before Auto');
    const references=await Promise.all((image.references||[]).map(async id=>{const m=p.media?.[id];if(!m?.blob)throw Error('Missing reference '+id);return mobileBlobData(m.blob,mobileFlowName(m));}));
    const item={id:`story:${image.id}`,projectId:p.id,imageId:image.id,kind:'image',mode:references.length?'image-to-image':'text-to-image',text:shaped(image.imagePrompt),images:references,filename:`p${String(p.setup.partNumber||1).padStart(2,'0')}_${image.id}.jpg`,aspectRatio:wide?'landscape':asset&&/character reference sheet/i.test(image.imagePrompt)?'square':'portrait',phase:'pending'};
    item.sourceVersion=mobileStoryVersion(p,item);return item;
  }
  await mobileProject(p.id,current=>{current.imagesReviewed=true;current.state='images_reviewed';});
  if(p.setup.exportProfile==='Image prompts only')return null;
  const plan=B.videoPlan(p.project,p.media,true,'flow',targets.model);
  const clips=await mobileStoryClips(p.id),saved=new Set(clips.filter(c=>c.blob?.size&&c.sourceVersion===mobileSceneVersion(p,c.sceneId)).map(c=>c.sceneId));
  for(const [id,record] of Object.entries(p.downloadedClipVersions||{}))if(record.sourceVersion===mobileSceneVersion(p,id))saved.add(id);
  // Explicit disk-only recovery must not regenerate a video just because its Workspace fetch failed.
  for(const item of job.items||[])if(item.kind==='video'&&item.phase==='done'&&item.diskSaved&&item.workspaceSkipped&&item.sourceVersion===mobileSceneVersion(p,item.sceneId))saved.add(item.sceneId);
  const entry=plan.entries.find(e=>!saved.has(e.sceneId));
  if(!entry){await mobileProject(p.id,current=>{current.videoDoneIds=[...saved];current.state='videos_finished';});return null;}
  const m=p.media[entry.sceneId];
  const item={id:`story:video:${entry.sceneId}`,projectId:p.id,sceneId:entry.sceneId,kind:'video',mode:'frame-to-video',text:shaped(entry.text),...(wide?{aspectRatio:'landscape'}:{}),image:await mobileBlobData(m.blob,mobileFlowName(m)),filename:`p${String(p.setup.partNumber||1).padStart(2,'0')}_${entry.sceneId}.mp4`,duration:Number(entry.durationSeconds||p.setup.sceneDuration),phase:'pending'};
  item.sourceVersion=mobileStoryVersion(p,item);return item;
}
// Every story names its frames p01_scene_001.jpg, so a Flow project used for several stories holds many pictures with the
// same name (user report 2026-11-04: busy project, wrong or no start frame). Flow gets the name plus the first 8 characters
// of the picture's own sha256: the same picture keeps its name, a different picture never shares it.
function mobileFlowName(m) {
  const tag=String(m?.sha256||'').slice(0,8);
  return /^[a-f0-9]{8}$/.test(tag)?String(m.name).replace(/(\.[a-z0-9]+)?$/i,'_'+tag+'$1'):m.name;
}
