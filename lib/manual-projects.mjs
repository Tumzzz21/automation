// Manual video projects use the workspace store, without the AI Story schema or server.
export const VIDEO_MODES=new Set(['text-to-video','frame-to-video','ingredients-to-video']);
export function isManual(p){return p?.kind==='manual'&&p?.manual?.version===1;}
export async function snapshotInput(item,settings,selectedImages){
  const references=[];
  for(const image of selectedImages){
    if(!/^data:image\/[a-z0-9.+-]+;base64,/i.test(image.dataUrl||''))throw Error('Cannot save the reference image '+image.name+'. Upload it again.');
    const [header,data]=image.dataUrl.split(','),bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0)),blob=new Blob([bytes],{type:header.slice(5).split(';')[0]});
    const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
    references.push({name:image.name,blob,sha256:Array.from(hash,v=>v.toString(16).padStart(2,'0')).join('')});
  }
  return {settings:structuredClone(settings),text:String(item.generationText||item.text||''),sourceText:String(item.sourceText??item.text??''),references,duration:Number(item.generationDuration||parseInt(item.videoMode,10)||settings.flowDurationSeconds)||8};
}
function applyInput(p,id,input){
  const media={...p.media},assets=[...p.project.assets],references=input.references.map(image=>{
    let asset=assets.find(a=>a.name===image.name&&media[a.id]?.sha256===image.sha256);
    if(!asset){asset={id:'asset_'+String(assets.length+1).padStart(3,'0'),name:image.name,imagePrompt:''};assets.push(asset);media[asset.id]=image;}
    return asset.id;
  });
  if(p.manual.settings.mode==='frame-to-video'&&references.length)media[id]=media[references[0]];
  const scenes=p.project.scenes.map(s=>s.id===id?{...s,videoPrompt:input.text,durationSeconds:input.duration,references}:s);
  return {...p,media,project:{...p.project,assets,scenes,durationSeconds:scenes.reduce((n,s)=>n+s.durationSeconds,0)}};
}
export function createProject(items,settings,inputs,{id='manual-'+crypto.randomUUID(),now=Date.now()}={}){
  if(!VIDEO_MODES.has(settings.mode)||!['flow','gemini','grok'].includes(settings.platform))throw Error('Manual projects require a supported video mode.');
  if(!items.length||items.some(i=>i.builderProjectId))throw Error('Choose a manual video queue.');
  const scenes=items.map((item,i)=>({id:'scene_'+String(i+1).padStart(3,'0'),videoPrompt:inputs[i].text,speech:'',caption:'',imagePrompt:'',durationSeconds:inputs[i].duration,references:[]}));
  let p={id,kind:'manual',origin:'manual',createdAt:now,state:'video_ready',imagesReviewed:true,videoDoneIds:[],media:{},setup:{niche:'manual',exportProfile:'Manual video',imageMode:'Manual images',partNumber:1,partsTotal:1,sceneDuration:String(inputs[0].duration),sceneCount:String(scenes.length)},project:{title:'Manual · '+new Date(now).toLocaleString(),assets:[],scenes},manual:{version:1,settings:structuredClone(settings),inputs:{},queueState:'ready',scenes:{}}};
  for(let i=0;i<scenes.length;i++)p=applyInput(p,scenes[i].id,inputs[i]);
  return p;
}
export function commitInput(p,id,input){
  if(!isManual(p)||!p.project.scenes.some(s=>s.id===id))throw Error('This manual scene no longer exists.');
  return applyInput(p,id,input);
}
export function reconcile(p,items,clips,version){
  const valid=new Set(clips.filter(c=>c.blob?.size&&c.sourceVersion===version(p,c.sceneId)).map(c=>c.sceneId));
  const states={...p.manual.scenes};for(const item of items)if(item.manualProjectId===p.id&&item.manualSceneId)states[item.manualSceneId]={status:item.status,detail:String(item.detail||'').slice(0,1000),outputName:item.outputName||'',captured:valid.has(item.manualSceneId)};
  const complete=p.project.scenes.every(s=>valid.has(s.id));
  return {...p,state:complete?'videos_finished':'video_ready',videoDoneIds:[...valid],manual:{...p.manual,scenes:states,queueState:complete?'complete':'needs_attention'}};
}
export function restoredEntries(p,ids){
  if(!isManual(p))throw Error('This is not a manual project.');
  if(ids&&(!ids.length||ids.some(id=>!p.project.scenes.some(s=>s.id===id))))throw Error('Choose a valid manual scene.');
  return p.project.scenes.filter(s=>!ids||ids.includes(s.id)).map(s=>{
    const input=p.manual.inputs[s.id];
    return {text:input?.text||s.videoPrompt,imageName:'',manualProjectId:p.id,manualSceneId:s.id,referenceNames:input?input.references.map(r=>r.name):s.references.map(id=>p.media[id].name),videoMode:String(input?.duration||s.durationSeconds)};
  });
}
