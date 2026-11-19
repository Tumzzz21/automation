// Motion Studio (owner 2026-11-12): a source video of up to 3 minutes is split into whole-second pieces, each piece
// is made in Flow (Omni 1.2 Flash, Ingredients: the piece as the motion reference + the character image), one after
// another in one Flow project, and the generated pieces are joined back into one video with the original sound.
// Everything except the Flow generation runs locally in this page.
import {motionDestination,inspectMotionDestination} from './project-flow.mjs';
import {STUDIO_VERSION,studioSettings,validateStudio,piecePrompt,flowProjectUrl} from './core.mjs';
import {read,save} from './store.mjs';
import {runMotion,callMotionPage} from './auto-run.mjs';
import {engineHost} from './engine-host.mjs';
import {serverBase,loadTemplates,templateFile,renderTemplates} from './templates.mjs';
import {planSegments,cutSegment,lastFrame,mergeTakes,hasSound,MAX_SOURCE_SECONDS} from './segments.mjs';
import {createFlowWatch} from './flow-watch.mjs';

const $=id=>document.getElementById(id);
const LATEST='motionStudioLatest',MAX_FILE=200*1024*1024;
const SUBMITTED=['dispatching','submitted','collecting','needs_review'];
const fresh=()=>({version:STUDIO_VERSION,id:crypto.randomUUID(),title:'Motion project',settings:studioSettings(),pieces:[]});
let project=fresh(),running=false,paused=false,splitting=false,activeHost=null,activeDebug=null,activeWatch=null,controller=null;
const urls=new Map();

// ---------- small helpers ----------
const status=text=>{$('status').textContent=text||'';$('upgradePro')?.remove();};
// The day's free try is used (owner 2026-11-12): say so and offer Upgrade to Pro right here.
function limitReached(r){
  status(r.message||'Motion Studio is not available on this account.');
  if(!r.limit)return;
  const b=document.createElement('button');b.id='upgradePro';b.type='button';b.className='upgrade-pro';b.textContent='✦ Upgrade to Pro for unlimited use';
  b.onclick=async()=>{b.disabled=true;try{await engineHost().upgrade();}catch(e){status(e.message);}finally{b.disabled=false;}};
  $('status').after(b);
}
const clock=s=>{s=Math.max(0,Math.round(s));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
const tag=i=>'f'+String(i+1).padStart(4,'0');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const safeName=s=>String(s||'motion').replace(/[^a-zA-Z0-9_-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,70)||'motion';
const ext=file=>file?.type==='image/jpeg'?'.jpg':file?.type==='image/webp'?'.webp':'.png';
function show(id,blob){if(urls.has(id))URL.revokeObjectURL(urls.get(id));if(!blob){urls.delete(id);$(id).removeAttribute('src');return;}const url=URL.createObjectURL(blob);urls.set(id,url);$(id).src=url;}
function progress(text,done,total){$('runBar').hidden=!text;$('runText').textContent=text||'';$('runFill').style.width=total?Math.round(done/total*100)+'%':'0%';}
async function persist(media=[]){project.updatedAt=Date.now();await save(project,media);try{localStorage.setItem(LATEST,project.id);}catch{}}
const media=async key=>{const blob=key&&await read('media',key);if(!blob)throw Error('A saved file is missing on this browser. Add the source video again.');return blob;};

async function videoInfo(file){
  const url=URL.createObjectURL(file),video=document.createElement('video');
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>done(Error('The video could not be read. Try an MP4.')),15000);
    function done(error,value){clearTimeout(timer);video.removeAttribute('src');video.load();URL.revokeObjectURL(url);error?reject(error):resolve(value);}
    video.onloadedmetadata=()=>Number.isFinite(video.duration)&&video.duration>0?done(null,{duration:video.duration,width:video.videoWidth,height:video.videoHeight}):done(Error('The video has no length.'));
    video.onerror=()=>done(Error('This browser cannot read that video. Try an MP4 (H.264).'));
    video.preload='metadata';video.muted=true;video.src=url;
  });
}

// ---------- settings ----------
function readSettings(){
  project.settings=studioSettings({pieceSeconds:Number($('pieceSeconds').value),ratio:$('ratio').value,resolution:$('resolution').value,download:$('download').value,continuity:$('continuity').checked,originalAudio:$('originalAudio').checked,autoDownload:$('autoDownload').checked,prompt:$('prompt').value});
  project.title=$('title').value.trim()||'Motion project';
}
function writeSettings(){
  const s=studioSettings(project.settings);
  $('pieceSeconds').value=String(s.pieceSeconds);$('ratio').value=s.ratio;$('resolution').value=s.resolution;$('download').value=s.download;$('downloadField').hidden=s.resolution!=='360p';
  $('continuity').checked=s.continuity;$('originalAudio').checked=s.originalAudio;$('autoDownload').checked=s.autoDownload;
  $('prompt').value=s.prompt;$('promptCount').textContent=s.prompt.length+' / 1000';$('title').value=project.title;
}
// Omni 1.2 Flash: about 3 credits a second, double for the seconds above 10 (owner 2026-11-07).
// 360p is about a third of the 720p credits (owner 2026-11-07). Checked: 13 s at 720p = 48 credits in Flow.
const pieceCredits=seconds=>{const c=3*Math.min(seconds,10)+6*Math.max(0,seconds-10);return project.settings.resolution==='360p'?Math.ceil(c/3):c;};
function summary(){
  // A piece already sent to Flow is only collected (no credits); the rest are made.
  const todo=project.pieces.filter(p=>p.state!=='done'),collect=todo.filter(p=>SUBMITTED.includes(p.run?.phase)),make=todo.filter(p=>!collect.includes(p));
  return {todo,collect,make,seconds:make.reduce((n,p)=>n+p.seconds,0),credits:make.reduce((n,p)=>n+pieceCredits(p.seconds),0)};
}
function refreshHints(){
  const ready=!!project.source&&project.pieces.length&&project.pieces.every(p=>p.clip);
  const {todo,make,credits}=summary();
  $('readyChip').textContent=!project.source?'Add a video':!project.character?'Add a character':!ready?'Splitting…':project.final&&!todo.length?'Finished':todo.length+' piece'+(todo.length===1?'':'s')+' to make';
  $('costHint').textContent=!project.source?'Add a video and a character.':!project.character?'Add the character the video should show.':!ready?'Splitting the video into pieces…':todo.length&&!make.length?'Flow already made the rest. Generate collects it (no credits) and joins the video.':todo.length?`${make.length} Flow video${make.length===1?'':'s'}, about ${credits} credits (Omni 1.2 Flash, ${project.settings.resolution}). Pieces are made one after another.`:project.final?'All pieces are made. Join again or download the final video.':'All pieces are made. Join them to finish.';
  $('generate').textContent=project.pieces.some(p=>p.state==='done')&&todo.length?'✦ Continue':todo.length||!project.pieces.length?'✦ Generate':'⧉ Join pieces';
  $('generate').disabled=running||splitting;
  $('joinAgain').disabled=running||!project.pieces.length||project.pieces.some(p=>p.state!=='done');
  $('downloadFinal').disabled=running||!project.final;
  $('playBoth').disabled=!project.final;
  $('tabCompare').disabled=!project.final;
}

// ---------- timeline ----------
const STATE_TEXT={waiting:'Waiting',preparing:'Preparing',uploading:'Uploading',filling:'Writing prompt',dispatching:'Sending',submitted:'Generating',generating:'Generating',collecting:'Downloading',done:'Done',error:'Failed',paused:'Paused'};
function stateOf(p){if(p.state==='done'||p.state==='error')return p.state;const phase=p.run?.phase||'';if(!phase)return 'waiting';if(phase.startsWith('uploading'))return 'uploading';if(phase==='filling prompt')return 'filling';return STATE_TEXT[phase]?phase:'generating';}
function cell(p,kind){
  const el=document.createElement('button');el.type='button';el.className='piece '+kind;el.style.flexGrow=String(p.end-p.start);
  el.dataset.index=p.index;
  const top=document.createElement('strong'),sub=document.createElement('small');top.textContent=tag(p.index);
  if(kind==='source'){sub.textContent=clock(p.start)+'–'+clock(p.end)+(p.clip?'':' · cutting');el.classList.toggle('pending',!p.clip);el.title='Play this part of the source';el.onclick=()=>{const v=$('sourceVideo');setView('source');v.currentTime=p.start;v.play().catch(()=>{});};}
  if(kind==='audio'){const on=project.settings.originalAudio;sub.textContent=on?'♪ original':'muted';el.classList.toggle('muted',!on);el.disabled=true;}
  if(kind==='flow'){
    const st=stateOf(p);el.dataset.state=st;sub.textContent=(running&&st==='waiting'&&project.pieces.find(x=>x.state!=='done')===p?'Next':STATE_TEXT[st]||st)+(p.state==='done'?' · '+p.seconds+'s':'');
    if(p.error){el.title=p.error;}
    if(p.state==='done'){el.title='Watch this generated piece';el.onclick=async()=>{try{show('resultVideo',await media(p.take.key));$('resultScreen').hidden=false;setView('compare',true);}catch(e){status(e.message);}};}
    if(!running&&(p.state==='done'||p.state==='error')){const redo=document.createElement('span');redo.className='redo';redo.textContent='↻';redo.title='Make this piece again in Flow';redo.setAttribute('role','button');redo.tabIndex=0;const go=e=>{e.stopPropagation();redoPiece(p.index);};redo.onclick=go;redo.onkeydown=e=>{if(e.key==='Enter'||e.key===' ')go(e);};el.append(redo);}
  }
  el.prepend(top,sub);return el;
}
function renderTimeline(){
  for(const [row,kind] of [['rowSource','source'],['rowAudio','audio'],['rowFlow','flow']])$(row).replaceChildren(...project.pieces.map(p=>cell(p,kind)));
  const n=project.pieces.length,done=project.pieces.filter(p=>p.state==='done').length;
  $('piecesMeta').textContent=!project.source?'Split the source video to make the pieces':splitting?'Splitting…':`${n} piece${n===1?'':'s'} · ${done}/${n} made · ${clock(project.source.duration)} total`;
  refreshHints();
}
function renderSource(blob){
  const has=!!project.source;
  $('sourceDrop').hidden=has;$('sourceScreen').hidden=!has;
  const meta=has?`${project.source.name} · ${clock(project.source.duration)} · ${project.source.width}×${project.source.height}`:'No video selected';
  $('sourceMeta').textContent=meta;
  if(has&&blob){const key=project.source.key;hasSound(blob).then(on=>{if(on!=null&&project.source?.key===key)$('sourceMeta').textContent=meta+(on?' · 🔊 sound':' · no sound');});}
  $('sourceVideo').muted=false;   // Play both mutes it (owner 2026-11-12: a template's sound was not heard)
  if(blob)show('sourceVideo',blob);else if(!has)show('sourceVideo',null);
}
function renderCharacter(blob){
  const c=project.character;$('clearCharacter').hidden=!c;$('characterIcon').hidden=!!c;$('characterThumb').hidden=!c;
  $('characterMeta').textContent=c?(c.libraryName||c.originalName||c.name):'Drop an image or choose from saved characters';
  if(c&&blob){if(urls.has('thumb'))URL.revokeObjectURL(urls.get('thumb'));const u=URL.createObjectURL(blob);urls.set('thumb',u);$('characterThumb').src=u;}
  $('backgroundMeta').textContent=project.background?(project.background.originalName||project.background.name):"Leave empty to keep the video's place";
}
function setView(view,force){if(view==='compare'&&!force&&!project.final)return;$('screens').dataset.view=view;$('tabSource').setAttribute('aria-selected',String(view==='source'));$('tabCompare').setAttribute('aria-selected',String(view==='compare'));$('tabTemplates').setAttribute('aria-selected',String(view==='templates'));
  const tpl=view==='templates';$('templates').hidden=!tpl;$('resultScreen').hidden=view!=='compare';$('sourceScreen').hidden=tpl||!project.source;$('sourceDrop').hidden=tpl||!!project.source;
  // Templates get the Pieces panel's room too (owner 2026-11-12); Pieces come back with Source or Compare.
  document.querySelector('.timeline').hidden=tpl;}
// Templates (owner 2026-11-12): ready motion clips of our own, from our server. The download icon makes one the source video.
// The list is read again every time the tab opens (owner 2026-11-12: a window opened before the templates got their
// sound kept the old list and reused the old silent copy); the grid already shown stays until the new list is in.
let templateList=null,templatesLoading=false;
async function openTemplates(){
  setView('templates');
  if(templatesLoading)return;templatesLoading=true;
  const root=$('templates');if(!templateList)root.replaceChildren(Object.assign(document.createElement('p'),{className:'tpl-empty',textContent:'Loading templates…'}));
  try{
    const base=await serverBase(),list=await loadTemplates({base});
    if(templateList&&JSON.stringify(list)===JSON.stringify(templateList))return;
    templateList=list;
    renderTemplates(root,templateList,{base,busy:()=>running||splitting,onUse:async(t,onProgress)=>{
      status(`Downloading template “${t.title}”…`);
      try{const file=await templateFile(t,{base,onProgress});status('');await importSource(file);if(project.source?.name===file.name)setView('source');}
      catch(e){status(e.message);}
    }});
  }catch(e){if(templateList)return;root.replaceChildren(Object.assign(document.createElement('p'),{className:'tpl-empty',textContent:'Templates could not load. Check your internet, then open this tab again.'}));}
  finally{templatesLoading=false;}
}
$('tabTemplates').onclick=()=>openTemplates();
$('tabSource').onclick=()=>{$('sourceVideo').muted=false;setView('source');};
$('tabCompare').onclick=async()=>{try{if(project.final)show('resultVideo',await media(project.final.key));setView('compare');}catch(e){status(e.message);}};

// ---------- import + split ----------
async function importSource(file){
  if(running||splitting)return;
  try{
    if(!file.type.startsWith('video/'))throw Error('Choose a video file (MP4, MOV or WebM).');
    if(file.size<=0||file.size>MAX_FILE)throw Error('Choose a video under 200 MB.');
    const info=await videoInfo(file);
    if(info.duration>MAX_SOURCE_SECONDS+.05)throw Error('This video is '+clock(info.duration)+' long. Use a video of up to 3 minutes (trim it first).');
    if(project.pieces.some(p=>p.state==='done')&&!confirm('Replace the video? The pieces already made for the old video are removed.'))return;
    const item={key:crypto.randomUUID(),name:file.name,type:file.type,size:file.size,duration:info.duration,width:info.width,height:info.height};
    readSettings();
    if(!project.pieces.length||!project.pieces.some(p=>p.state==='done'))project.settings.ratio=info.width>info.height?'landscape':'portrait';
    project.source=item;project.pieces=[];delete project.final;
    await persist([[item.key,file]]);writeSettings();renderSource(file);setView('source');renderTimeline();
    await split();
  }catch(e){status(e.message);}finally{$('source').value='';}
}
async function split(){
  if(!project.source||splitting)return;
  splitting=true;renderTimeline();
  try{
    const src=await media(project.source.key),plan=planSegments(project.source.duration,project.settings.pieceSeconds);
    project.pieces=plan.map(p=>({...p,state:'waiting'}));delete project.final;renderTimeline();
    for(const p of project.pieces){
      progress(`Splitting ${p.index+1}/${plan.length}`,p.index,plan.length);
      const clip=await cutSegment(src,p.start,p.end);
      p.clip={key:crypto.randomUUID(),size:clip.size};
      await persist([[p.clip.key,clip]]);renderTimeline();
    }
    progress('');status(`Split into ${plan.length} piece${plan.length===1?'':'s'} of up to ${project.settings.pieceSeconds} seconds. Add your character, then Generate.`);
  }catch(e){progress('');status('Splitting stopped: '+e.message);}
  finally{splitting=false;renderTimeline();}
}
$('source').addEventListener('change',()=>{const f=$('source').files[0];if(f)importSource(f);});
$('replaceSource').onclick=()=>$('source').click();
for(const zone of [$('sourceDrop'),$('screens')]){zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('over');});zone.addEventListener('dragleave',()=>zone.classList.remove('over'));zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('over');const f=[...e.dataTransfer.files].find(f=>f.type.startsWith('video/'));if(f)importSource(f);});}

// ---------- references ----------
async function setImage(role,file,extra={}){
  if(running)return;
  try{
    if(!file.type.startsWith('image/'))throw Error('Choose a PNG, JPG or WebP image.');
    if(file.size<=0||file.size>40*1024*1024)throw Error('Choose an image under 40 MB.');
    const bitmap=await createImageBitmap(file);bitmap.close();
    // Flow sees a plain file name; the prompt names the same file (character.png / background.png).
    const item={key:crypto.randomUUID(),name:role+ext(file),originalName:extra.libraryName||file.name||role,type:file.type,size:file.size,...extra};
    project[role]=item;await persist([[item.key,file]]);renderCharacter(role==='character'?file:null);refreshHints();
    status(role==='character'?'Character ready.':'Background ready.');
  }catch(e){status(e.message);}
}
$('character').addEventListener('change',()=>{const f=$('character').files[0];$('character').value='';if(f)setImage('character',f);});
$('background').addEventListener('change',()=>{const f=$('background').files[0];$('background').value='';if(f)setImage('background',f);});
$('characterDrop').addEventListener('dragover',e=>e.preventDefault());
$('characterDrop').addEventListener('drop',e=>{e.preventDefault();const f=[...e.dataTransfer.files].find(f=>f.type.startsWith('image/'));if(f)setImage('character',f);});
$('clearCharacter').onclick=async()=>{if(running)return;delete project.character;$('characterThumb').removeAttribute('src');await persist();renderCharacter();refreshHints();};
$('library').onclick=async()=>{
  try{
    const {listCharacters}=await import('../lib/character-library.mjs');const items=await listCharacters();
    const dialog=document.createElement('dialog'),heading=document.createElement('h2'),list=document.createElement('div'),cleanup=[];
    heading.textContent='Choose your character';list.className='saved-list';
    for(const record of items){const blob=record.image?.blob;if(!blob)continue;const pick=document.createElement('button'),image=document.createElement('img'),text=document.createElement('span'),url=URL.createObjectURL(blob);cleanup.push(url);image.src=url;image.alt='';text.textContent=record.name;pick.type='button';pick.append(image,text);pick.onclick=async()=>{dialog.close();await setImage('character',blob,{libraryName:record.name});};list.append(pick);}
    if(!list.children.length){const empty=document.createElement('p');empty.textContent='No saved characters yet. Upload an image here, or add one in AI Story → Characters.';list.append(empty);}
    const close=document.createElement('button');close.className='ghost';close.textContent='Close';close.onclick=()=>dialog.close();
    dialog.append(heading,list,close);dialog.addEventListener('close',()=>{cleanup.forEach(u=>URL.revokeObjectURL(u));dialog.remove();},{once:true});document.body.append(dialog);dialog.showModal();
  }catch(e){status(e.message);}
};

// ---------- settings changes ----------
for(const id of ['download','ratio','resolution','continuity','originalAudio','autoDownload','title'])$(id).addEventListener('change',()=>{readSettings();persist().catch(e=>status(e.message));renderTimeline();});
$('resolution').addEventListener('change',()=>{$('downloadField').hidden=$('resolution').value!=='360p';});
$('prompt').addEventListener('input',()=>{$('promptCount').textContent=$('prompt').value.length+' / 1000';});
$('prompt').addEventListener('change',()=>{readSettings();persist().catch(e=>status(e.message));});
$('pieceSeconds').addEventListener('change',async()=>{
  if(running||splitting){writeSettings();return;}
  if(project.pieces.some(p=>p.state==='done')&&!confirm('Change the piece length? The pieces already made are removed and the video is split again.')){writeSettings();return;}
  readSettings();await persist();if(project.source)await split();else renderTimeline();
});
$('newProject').onclick=async()=>{if(running)return;if(project.source&&!confirm('Start a new motion project? This one stays saved on this browser.'))return;project=fresh();await persist();location.reload();};

// ---------- Flow project ----------
async function refreshFlow(){
  if(!globalThis.chrome?.tabs){status('Open Motion Studio from the OxFlow extension (AI Story → Motion Control) to connect Flow.');return;}
  const tabs=await chrome.tabs.query({url:'https://flow.google.com/*'});
  $('flow').replaceChildren(new Option('New Flow project · automatic','new'));
  for(const tab of tabs){try{flowProjectUrl(tab.url);$('flow').add(new Option('Open tab · '+(tab.title||tab.url).slice(0,60),String(tab.id)));}catch{}}
  if(project.flowMode==='existing'&&[...$('flow').options].some(o=>o.value===String(project.flowTabId)))$('flow').value=String(project.flowTabId);
}
$('flow').onchange=async()=>{try{if($('flow').value==='new'){project.flowMode='new';delete project.flowTabId;delete project.flowUrl;}else{const tab=await chrome.tabs.get(Number($('flow').value));project.flowMode='existing';project.flowTabId=tab.id;project.flowUrl=flowProjectUrl(tab.url);}await persist();}catch(e){status(e.message);}};
$('flow').addEventListener('focus',()=>{if(!running)refreshFlow().catch(()=>{});});

// ---------- generate ----------
function lockControls(busy){
  for(const el of document.querySelectorAll('aside input,aside select,aside textarea,aside button,#replaceSource,#newProject,#source'))if(el.id!=='pause')el.disabled=busy||['model','refMode'].includes(el.id);
  $('pause').hidden=!busy;$('pause').disabled=false;refreshHints();
}
$('pause').onclick=()=>{paused=true;controller?.abort();$('pause').disabled=true;status('Pausing after the current step. A piece already sent to Flow keeps generating there; Continue collects it without sending it again.');};

$('generate').onclick=async()=>{
  if(running||splitting)return;
  readSettings();
  try{validateStudio(project);if(!project.pieces.length||project.pieces.some(p=>!p.clip))throw Error('The video is still being split. Wait a moment.');}catch(e){status(e.message);return;}
  const {todo,collect,make,seconds,credits}=summary();
  if(todo.length){
    const fetch=collect.length?`Collect ${collect.map(p=>tag(p.index)).join(', ')} that Flow already made (no credits)${make.length?'. Then m':'.'}`:'M';
    $('confirmText').textContent=!make.length?fetch+` The pieces are then joined here${project.settings.originalAudio?' with the original sound':''}.`:fetch+`ake ${make.length} piece${make.length===1?'':'s'} (${Math.round(seconds)} s) in Google Flow with Omni 1.2 Flash, ${project.settings.ratio==='landscape'?'16:9':'9:16'}, ${project.settings.resolution}. About ${credits} Flow credits. Each piece is sent once; the pieces are then joined here${project.settings.originalAudio?' with the original sound':''}.`;
    $('confirmGo').textContent=make.length?'▶ Generate '+make.length+' piece'+(make.length===1?'':'s'):'▶ Collect';
    $('confirmDialog').showModal();
    const go=await new Promise(r=>{$('confirmGo').onclick=()=>{$('confirmDialog').close();r(true);};$('confirmCancel').onclick=()=>{$('confirmDialog').close();r(false);};$('confirmDialog').oncancel=()=>r(false);});
    if(!go)return;
    await generate();
  }else await join();
};

async function generate(){
  if(!globalThis.chrome?.debugger||!chrome.runtime.getManifest().permissions?.includes('debugger')){status('Open Motion Studio from the OxFlow extension (AI Story → Motion Control). It needs the extension to drive Flow.');return;}
  // Asked inside the click, before anything else waits.
  if(!await chrome.permissions.request({origins:['https://flow.google.com/*']})){status('Allow Flow site access to generate.');return;}
  await navigator.locks.request('motion-lab-run',{ifAvailable:true},async lock=>{
    if(!lock){status('Another Motion Studio window is running. Wait for it to finish.');return;}
    running=true;paused=false;lockControls(true);renderTimeline();
    let host=null,debugTarget=null,tab=null;
    try{
      host=engineHost();host.acquire(project.id);activeHost=host;
      // 1 free try a day for Free and Discord Free Pro, counted per source video on the server: Continue, redo and
      // collect for the same video are free; a new video in the same project is a new try.
      const allow=await host.allowRun?.(project.source?.key||project.id);
      if(allow&&!allow.ok){limitReached(allow);return;}
      const pending=project.pieces.find(p=>SUBMITTED.includes(p.run?.phase));
      status('Opening your Flow project…');progress('Opening Flow',0,1);
      if(pending){try{tab=await chrome.tabs.get(pending.run.tabId);}catch{throw Error(`The Flow tab where ${tag(pending.index)} was sent is closed. Open that Flow project, find the video, or use ↻ on the piece to make it again.`);}}
      else tab=await motionDestination(project,{tabs:chrome.tabs,inspect:inspectMotionDestination,click:(id,at)=>host.flowClick(id,at.x,at.y),save:()=>persist(),sleep,check:()=>{if(paused)throw Error('Paused.');}});
      await chrome.tabs.update(tab.id,{active:true}).catch(()=>{});
      await chrome.debugger.attach({tabId:tab.id},'1.3').catch(e=>{if(!/already attached/i.test(e.message))throw e;});
      debugTarget={tabId:tab.id};activeDebug=debugTarget;await sleep(400);
      // Listen-only: Flow's own replies name our video and its link (flow-watch.mjs). Without it Motion reads the page.
      activeWatch=createFlowWatch({tabId:tab.id});if(!await activeWatch.start())activeWatch=null;
      const total=project.pieces.length;
      for(const piece of project.pieces){
        if(piece.state==='done')continue;
        if(paused)throw Error('Paused.');
        await makePiece(piece,tab,host,total);
        tab=await chrome.tabs.get(tab.id);
      }
      progress('');
      await activeWatch?.stop();activeWatch=null;
      if(debugTarget){await chrome.debugger.detach(debugTarget).catch(()=>{});debugTarget=null;activeDebug=null;}
      host.release(project.id);host=null;activeHost=null;
      await join(true);
    }catch(e){
      progress('');
      status(/^Paused/.test(e.message)?'Paused. Click Continue to go on; finished pieces are kept.':e.message);
    }finally{
      await activeWatch?.stop().catch(()=>{});activeWatch=null;
      if(debugTarget)await chrome.debugger.detach(debugTarget).catch(()=>{});
      host?.release(project.id);activeHost=null;activeDebug=null;running=false;paused=false;lockControls(false);renderTimeline();
    }
  });
}

async function makePiece(piece,tab,host,total){
  const n=piece.index+1,label=`${tag(piece.index)} (${n}/${total})`,s=project.settings;
  const recover=SUBMITTED.includes(piece.run?.phase);
  // A piece stopped before it was sent starts over (the Flow box is cleared first); a sent piece is only collected.
  if(!recover&&piece.run)delete piece.run;
  piece.state='working';delete piece.error;renderTimeline();
  const prev=project.pieces[piece.index-1],continuity=s.continuity&&piece.index>0&&prev?.take;
  const job={id:project.id,
    source:{key:piece.clip.key,name:`piece-${n}.mp4`,type:'video/mp4',size:piece.clip.size,duration:piece.seconds},
    character:project.character,...project.background?{background:project.background}:{},run:piece.run};
  if(continuity&&!recover){
    let frame=piece.continuity&&await read('media',piece.continuity.key);
    if(!frame||piece.continuity.from!==prev.take.key){status(`${label}: reading the last frame of the previous piece…`);frame=await lastFrame(await media(prev.take.key));piece.continuity={key:crypto.randomUUID(),size:frame.size,from:prev.take.key};await persist([[piece.continuity.key,frame]]);}
    job.continuity={key:piece.continuity.key,name:'previous-frame.png',type:'image/png',size:piece.continuity.size};
  }
  const prompt=piecePrompt(project,piece,{continuity:!!job.continuity});
  try{
    const output=await runMotion({project:job,tab,prompt,recover,duration:piece.seconds,
      readMedia:key=>read('media',key),
      checkpoint:async run=>{piece.run=run;await persist();renderTimeline();},
      progress:text=>{status(`${label}: ${text}`);progress(`${label} · ${text}`,piece.index,total);},
      stopped:()=>paused,
      // Flow asks the member to agree to its upload terms: show them the Flow tab; they answer it themselves.
      onConsent:async()=>{await chrome.tabs.update(tab.id,{active:true}).catch(()=>{});if(tab.windowId!=null)await chrome.windows?.update(tab.windowId,{focused:true}).catch(()=>{});},
      watch:activeWatch,preferMenu:s.resolution==='360p'&&s.download==='720p',
      fetchSigned:async url=>{const r=await fetch(url,{credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(120000)});if(!r.ok)throw Error('HTTP '+r.status);if(/text\/html|json/i.test(r.headers.get('content-type')||''))throw Error('not a video');return r.arrayBuffer();},
      downloadResult:({posters,video})=>host.downloadResult(tab.id,{posters,video,name:safeName(project.title)+'-'+tag(piece.index),generation:s.resolution,download:s.download==='720p'?'720p':s.resolution}),
      settings:seconds=>host.flowSettings(tab.id,{aspectRatio:s.ratio,durationSeconds:seconds,model:'Omni 1.2 Flash',videoResolution:s.resolution}),
      callPage:args=>callMotionPage(tab.id,args,(...a)=>host.pointer(...a),(id,secs)=>host.setLength(id,secs),(id,x,y)=>host.hover(id,x,y),(id,t)=>host.typeText(id,t)),
      // Real clicks, Chrome's file picker and real typing (owner 2026-11-12, "unusual activity"); an older panel without
      // them keeps the page way.
      ...typeof host.uploadFile==='function'?{uploadReal:f=>host.uploadFile(tab.id,f),uploadDone:()=>host.uploadDone(tab.id)}:{},
      realTyping:typeof host.typeText==='function'});
    const blob=output.blob;
    piece.take={key:crypto.randomUUID(),size:blob.size,type:blob.type};piece.state='done';piece.run={...output.run,phase:'completed'};
    await persist([[piece.take.key,blob]]);
    await output.finish().catch(()=>{});
    renderTimeline();status(`${label} is done.`);
  }catch(e){
    // Paused before sending: the piece just waits. Anything else is shown on the piece.
    if(/^Paused/.test(e.message)){piece.state='waiting';if(!SUBMITTED.includes(piece.run?.phase))delete piece.run;}
    else{piece.state='error';piece.error=e.message;}
    await persist().catch(()=>{});renderTimeline();
    throw /^Paused/.test(e.message)?e:Error(`${label}: ${e.message}`);
  }
}

async function redoPiece(index){
  if(running)return;
  const p=project.pieces[index];if(!p)return;
  if(p.state==='error'&&SUBMITTED.includes(p.run?.phase)&&!confirm(`${tag(index)} was already sent to Flow, and Flow may have made it (look in the Flow project). Make it again? This sends one more video (about ${pieceCredits(p.seconds)} credits) when you click Generate.`))return;
  if(p.state==='done'&&!confirm(`Make ${tag(index)} again in Flow? This sends one more video (about ${pieceCredits(p.seconds)} credits) when you click Generate.`))return;
  p.state='waiting';delete p.run;delete p.error;delete p.take;delete project.final;
  for(const later of project.pieces.slice(index+1))delete later.continuity;
  await persist();renderTimeline();status(`${tag(index)} will be made again. Click Continue.`);
}

// ---------- join + download ----------
async function join(auto=false){
  if(!project.pieces.length||project.pieces.some(p=>p.state!=='done'||!p.take)){status('Make every piece first.');return;}
  const wasRunning=running;running=true;lockControls(true);controller=new AbortController();
  try{
    const total=project.pieces.length;progress('Merging video',0,1);status('Joining the pieces…');
    const takes=[];for(const p of project.pieces)takes.push({blob:await media(p.take.key),seconds:p.end-p.start});
    let audio=project.settings.originalAudio?await media(project.source.key):null,note='';
    let blob;
    try{blob=await mergeTakes(takes,{audio,signal:controller.signal,onProgress:n=>progress(`Merging video ${n}%`,n,100)});}
    catch(e){if(!audio||!/no sound|No sound/.test(e.message))throw e;note=' The source has no sound, so the generated sound was kept.';blob=await mergeTakes(takes,{signal:controller.signal,onProgress:n=>progress(`Merging video ${n}%`,n,100)});}
    const name=`${safeName(project.title)}-motion.mp4`;
    project.final={key:crypto.randomUUID(),name,size:blob.size,type:'video/mp4',pieces:total,originalAudio:!!audio&&!note,at:Date.now()};
    await persist([[project.final.key,blob]]);
    show('resultVideo',blob);setView('compare');progress('');
    status(`Final video ready: ${total} piece${total===1?'':'s'} joined${project.final.originalAudio?' with the original sound':''}.${note}`);
    if(project.settings.autoDownload)await download(blob,name);
  }catch(e){progress('');status(e.name==='AbortError'?'Joining paused. Click Join again.':'Joining failed: '+e.message);}
  finally{controller=null;running=wasRunning;if(!wasRunning)lockControls(false);renderTimeline();}
}
async function download(blob,name){
  const url=URL.createObjectURL(blob);
  try{
    if(globalThis.chrome?.downloads){await chrome.downloads.download({url,filename:`OxFlow Motion/${name}`,saveAs:false});status($('status').textContent+' Saved to Downloads/OxFlow Motion.');}
    else{const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();}
  }catch(e){status('The final video is saved here; the download could not start: '+e.message);}
  finally{setTimeout(()=>URL.revokeObjectURL(url),120000);}
}
$('joinAgain').onclick=()=>join(false);
$('downloadFinal').onclick=async()=>{try{if(!project.final)throw Error('No final video yet.');await download(await media(project.final.key),project.final.name);}catch(e){status(e.message);}};
$('playBoth').onclick=async()=>{try{if(!project.final)return;setView('compare');const a=$('sourceVideo'),b=$('resultVideo');if(!b.getAttribute('src'))show('resultVideo',await media(project.final.key));for(const v of [a,b]){v.pause();v.currentTime=0;}a.muted=true;b.muted=false;await Promise.all([a.play(),b.play()]);}catch(e){status(e.message);}};

// ---------- restore ----------
window.addEventListener('pagehide',()=>{paused=true;controller?.abort();activeHost?.release(project.id);if(activeDebug)chrome.debugger.detach(activeDebug).catch(()=>{});});
async function restore(){
  let id=null;try{id=localStorage.getItem(LATEST);}catch{}
  const saved=id&&await read('projects',id);
  if(saved?.version===STUDIO_VERSION)project={...fresh(),...saved,settings:studioSettings(saved.settings)};
  // A piece that was interrupted while it was being prepared starts over; a sent one is collected on Continue.
  for(const p of project.pieces)if(p.state==='working')p.state='waiting';
  writeSettings();
  if(project.source){const blob=await read('media',project.source.key);if(blob)renderSource(blob);else{status('The saved video is missing on this browser. Add it again.');project.source=null;project.pieces=[];}}
  else renderSource();
  if(project.character){const blob=await read('media',project.character.key);if(blob)renderCharacter(blob);else{delete project.character;renderCharacter();}}else renderCharacter();
  if(project.final){const blob=await read('media',project.final.key);if(blob){show('resultVideo',blob);setView('compare');}else delete project.final;}
  renderTimeline();
  if(project.source&&project.pieces.some(p=>!p.clip))await split();
  else if(project.pieces.some(p=>SUBMITTED.includes(p.run?.phase)))status('A piece was sent to Flow before this window closed. Click Continue to collect it (it is not sent again).');
  else if(!project.source)status('Add a source video (up to 3 minutes) and your character. Flow makes it in pieces and Motion Studio joins them.');
}
await restore().catch(e=>status(e.message));
await refreshFlow().catch(()=>{});
// For tests and the browser console: the current project (read-only copy).
globalThis.__motionStudio={get project(){return structuredClone(project);},join:()=>join(false),split};
