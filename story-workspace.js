import {createPublishKit} from './lib/publish-kit-ui.mjs';
import {setupMobileWorkspace,mobileWorkspaceWindow} from './lib/mobile-workspace.mjs';
import * as S from './lib/story-workspace.mjs';
import {inspectClip,inspectMusic,renderStory} from './lib/story-render.mjs';
import {drawCaption,captionSettings,audioSettings,musicFade} from './lib/story-overlays.mjs';
import {trimRange} from './lib/story-trim.mjs';
import {soundBounds,deadAirTrim} from './lib/story-silence.mjs';
import * as F from './lib/story-finish.mjs';
import {analyzeVoice} from './lib/story-render.mjs';
import {createTilePlayback} from './lib/story-tile-playback.mjs';
import {subtitleText} from './lib/story-dialogue.mjs';
import {saveToStoryFolder,exportBaseName} from './lib/story-folder.mjs';
import {suggestedPost} from './lib/publish-kit.mjs';
import {createNarration} from './lib/story-narration-ui.mjs';
import {createNarrationGenerator,serverClient} from './lib/story-narration-generate.mjs';
import {createByokGenerator,proAccount} from './lib/narration-byok.mjs';
import {narrationFits} from './lib/story-narration.mjs';
const $=id=>document.getElementById(id),node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const mobileWorkspace=setupMobileWorkspace(document,navigator);
const params=new URLSearchParams(location.search);let projectId=params.get('project')||'',project,records=[],order=[],localClips=[],selected='',tiles=new Map(),exporter=null,revision='',loading=false,importing=false,trimming=false,cuttingAir=false,trimSession=null,editingAudio=false,mix={},audioDraft=null,musicURL=null,musicBlob=null,musicPlayer=new Audio(),musicInspection=0;
musicPlayer.id='storyMusic';musicPlayer.hidden=true;document.body.append(musicPlayer);
let ownerWindow=params.has('ownerWindow')?Number(params.get('ownerWindow')):null,regeneration=null,regenStarting=false,regenPollBusy=false;
let publishKit=null,narration=null;
const canRegenerate=!!globalThis.chrome?.runtime?.id;
function notice(text='',bad=false){$('notice').textContent=text;$('notice').classList.toggle('error',bad);}
function action(label,fn){const b=node('button',label);b.type='button';b.onclick=()=>Promise.resolve().then(fn).catch(e=>notice(e.message,true));return b;}
function clip(id){return localClips.find(c=>c.sceneId===id&&c.sourceVersion===S.sceneVersion(project,id));}
function busy(){return !!exporter||importing||regenStarting||!!regeneration||trimming||cuttingAir||editingAudio||editingFinish||!!publishKit?.isOpen()||!!narration?.isOpen();}
function updateControls(){$('openPublish').disabled=!project||busy();const complete=!!order.length&&order.every(id=>clip(id));$('previewAll').disabled=!complete||busy();$('export').disabled=!complete||busy();$('import').disabled=!project||busy();$('resetOrder').disabled=!project||busy();$('projects').disabled=busy();if(busy())closeProjectPicker();$('refresh').disabled=busy();$('openAudio').disabled=!project||busy();$('openFinish').disabled=!project||!order.some(id=>clip(id))||busy();$('cutDeadAir').disabled=!project||!order.some(id=>clip(id))||busy();for(const b of document.querySelectorAll('.scene-actions button')){b.disabled=busy()||b.dataset.boundary==='true'||(b.classList.contains('regenerate')&&!canRegenerate);if(b.classList.contains('regenerate'))b.textContent=regeneration?.sceneId===b.dataset.scene?'↻ Regenerating…':'↻ Regenerate';}for(const [id,tile] of tiles){const pill=tile.card.querySelector('.pill'),active=regeneration?.sceneId===id;pill.textContent=active?'Generating…':tile.hasClip?'Ready':'Clip missing';pill.className='pill '+(active?'processing':tile.hasClip?'ready':'missing');}}
async function panelRequest(type,sceneId){
  if(!canRegenerate)throw Error('Regeneration is available in the extension workspace. Open it from your AI Story project.');
  if(!Number.isInteger(ownerWindow)){
    if(mobileWorkspace)ownerWindow=await mobileWorkspaceWindow(chrome);
    else{
      const contexts=await chrome.runtime.getContexts?.({contextTypes:['SIDE_PANEL']})||[];
      if(contexts.length!==1)throw Error('Open the workspace from your AI Story project in the side panel first.');
      ownerWindow=contexts[0].windowId;
    }
  }
  try{const result=await chrome.runtime.sendMessage({type,ownerWindowId:ownerWindow,projectId,...(sceneId&&typeof sceneId==='object'?sceneId:{sceneId})});if(!result)throw Error('No panel response.');if(!result.ok)throw Error(result.error||'Regeneration could not start.');return result;}
  catch(e){if(/receiving end|connection|message port|No panel response/i.test(e.message))throw Error('Keep the original 0xFlow side panel open, then try again.');throw e;}
}
async function regenerate(id){
  if(busy())return;regenStarting=true;stop();updateControls();notice('Starting video regeneration. Your current clip is kept until a new clip is saved.');
  try{await panelRequest('story-regenerate',id);regeneration={sceneId:id};notice('Regenerating '+id+' in the side panel. Your other clips are kept.');}
  catch(e){notice(e.message,true);}finally{regenStarting=false;updateControls();}
}
async function pollRegeneration(){
  if(!canRegenerate||!project||regenStarting||regenPollBusy)return;regenPollBusy=true;
  try{
    const status=await panelRequest('story-regenerate-status');
    if(['starting','running'].includes(status.state)){regeneration={sceneId:status.sceneId};notice('Regenerating '+status.sceneId+(status.detail?' · '+status.detail:'. Keep the side panel open.'));}
    else if(regeneration){regeneration=null;notice(status.state==='done'?(status.captured?'New video saved. Your scene has been updated.':'Video generated, but the workspace copy was unavailable. Import the downloaded MP4 to replace the previous clip.'):status.state==='failed'?'Regeneration did not finish. Your previous clip is kept. Check Control to retry.':'Generation is stopped or waiting. Check Control before trying again.',status.state!=='done');await load(true);}
  }catch(e){if(regeneration){regeneration=null;notice(e.message+' Your saved clips are kept.',true);}}
  finally{regenPollBusy=false;updateControls();}
}
const playback=createTilePlayback({getOrder:()=>order,getRange:id=>clip(id)?.trim||null,onSelect:(id,sequential,playing=true)=>{
  selected=id;syncMusic(id,playing);for(const [key,tile] of tiles)tile.card.classList.toggle('selected',key===id);
  $('playing').textContent=id?(playing?'Playing':'Paused')+' · Scene '+(order.indexOf(id)+1):'Select a tile to play';
  if(id&&sequential&&playing)tiles.get(id)?.card.scrollIntoView({block:'nearest',behavior:'instant'});
},onFinished:()=>{musicPlayer.pause();narration?.pause();$('playing').textContent='Playback complete';notice('Full story playback finished.');},onError:(id,e)=>{musicPlayer.pause();narration?.pause();notice(id+': '+e.message,true);}});
function stop(){playback.stop();musicPlayer.pause();narration?.pause();$('playing').textContent=selected?'Paused · Scene '+(order.indexOf(selected)+1):'Select a tile to play';}
function removeTile(id){const tile=tiles.get(id);if(!tile)return;playback.remove(id);tile.video?.removeAttribute('src');tile.card.remove();for(const u of tile.urls)URL.revokeObjectURL(u);tiles.delete(id);}
function createTile(id,scene,c,images,version){
  const card=node('article',undefined,'scene'),cover=node('div',undefined,'scene-cover'),tile={card,video:null,urls:[],version,hasClip:!!c};card.dataset.id=id;
  const tileURL=blob=>{const u=URL.createObjectURL(blob);tile.urls.push(u);return u;};
  const heading=node('div',undefined,'scene-heading');heading.append(node('strong','','scene-number'),node('span',c?'Ready':'Clip missing','pill '+(c?'ready':'missing')));card.append(heading);
  if(c){
    const video=node('video');video.controls=true;video.playsInline=true;video.preload='metadata';video.src=tileURL(c.blob);video.setAttribute('aria-label','Play video '+id);
    if(project.kind!=='manual'&&images[id]?.blob)video.poster=tileURL(images[id].blob);tile.video=video;cover.append(video);video.addEventListener('timeupdate',()=>{if(selected===id)syncMusic(id,!video.paused);});playback.add(id,video);
  }else if(images[id]?.blob){const img=node('img');img.src=tileURL(images[id].blob);img.alt=id+' start frame';cover.append(img,node('span','Add or generate a video','missing-hint'));}
  else cover.append(node('span','Waiting for a scene image or video','empty'));
  const copy=node('div',undefined,'scene-copy'),meta=node('div',undefined,'scene-title');meta.append(node('small',id),node('small',scene.durationSeconds?scene.durationSeconds+'s':'','scene-duration'));copy.append(meta);
  // Manual clips preview their actual footage; missing clips still show the saved input image.
  // Stories without scene images also use a frame of the clip itself.
  if(tile.video)tile.video.onloadedmetadata=()=>{updateTileTrim(id,tile);const v=tile.video;if(!v.poster&&v.paused&&v.currentTime===0){v.preload='auto';try{const start=trimRange(v.duration,c?.trim).start;v.currentTime=Math.min(start+0.05,Math.max(0,v.duration-0.05));v.addEventListener('play',()=>{if(Math.abs(v.currentTime-start-0.05)<0.03)v.currentTime=start;},{once:true});}catch{}}};
  const dialogue=node('details',undefined,'scene-dialogue');dialogue.append(node('summary','Dialogue / narration'),Object.assign(node('p',subtitleText(project,scene)||'No dialogue text found. Add a caption in Trim.'),{className:'scene-source-text'}));copy.append(dialogue);
  const controls=node('div',undefined,'scene-actions'),file=node('input');file.type='file';file.accept='video/*,.mp4,.webm,.mov';file.hidden=true;
  file.onchange=()=>importOne(id,file.files[0]).catch(e=>notice(e.message,true));controls.append(action(c?'Replace clip':'＋ Add clip',()=>file.click()),file);
  for(const [label,delta] of [['←',-1],['→',1]]){const b=action(label,()=>reorder(id,delta));b.dataset.delta=String(delta);b.setAttribute('aria-label',(delta<0?'Move earlier: ':'Move later: ')+id);controls.append(b);}
  const regenerateButton=action('↻ Regenerate',()=>regenerate(id));regenerateButton.className='regenerate';regenerateButton.dataset.scene=id;regenerateButton.setAttribute('aria-label','Regenerate video: '+id);regenerateButton.title=canRegenerate?'Uses your selected video engine and its generation credits. Only this scene is regenerated; its trim and caption reset when the new video is saved.':'Available when this workspace is opened from the extension.';if(mobileWorkspace)controls.prepend(regenerateButton);else controls.append(regenerateButton);
  if(c&&!mobileWorkspace){const trimButton=action('✂ Trim',()=>openTrim(id));trimButton.className='trim-button';trimButton.setAttribute('aria-label','Trim video: '+id);controls.prepend(trimButton);}
  copy.append(controls);card.append(cover,copy);return tile;
}
function updateTileTrim(id,tile){
  if(!tile.video||!Number.isFinite(tile.video.duration))return;
  const c=clip(id),r=trimRange(tile.video.duration,c?.trim);tile.video.volume=audioSettings(mix).originalVolume;tile.video.setAttribute('aria-description',c?.caption?.enabled?c.caption.text:'');
  tile.card.querySelector('.scene-duration').textContent=r.duration.toFixed(1)+'s'+(c?.trim?' · trimmed':'');
  const b=tile.card.querySelector('.trim-button');if(b)b.textContent=c?.trim?'✂ Edit trim':'✂ Trim';
}
async function openTrim(id){
  if(busy())return;const c=clip(id);if(!c)return;stop();trimming=true;updateControls();
  try{
    const metadata=await inspectClip(c.blob),r=trimRange(metadata.duration,c.trim);
    trimSession={id,version:c.updatedAt,duration:metadata.duration,url:URL.createObjectURL(c.blob)};
    $('trimTitle').textContent='Trim · Scene '+(order.indexOf(id)+1);$('trimVideo').src=trimSession.url;
    $('captionEnabled').checked=!!c.caption?.enabled;$('captionText').value=c.caption?.text??subtitleText(project,project.project.scenes.find(s=>s.id===id));$('captionText').value=$('captionText').value.slice(0,240);$('captionStyle').value=c.caption?.style||'clean';updateCaptionPreview();
    $('trimStart').value=String(r.start);$('trimEnd').value=String(r.end);
    for(const key of ['trimStart','trimEnd','trimStartRange','trimEndRange'])$(key).max=String(metadata.duration);
    syncTrim();$('trimDialog').showModal();
  }catch(e){closeTrim();throw e;}
}
function captionDraft(){return captionSettings({enabled:$('captionEnabled').checked,text:$('captionText').value,style:$('captionStyle').value});}
// Wide 16:9 stories (owner 2026-11-10): previews and the export use a 16:9 frame; vertical stays 720x1280.
function frameSize(){return project?.aspect==='16:9'?[1280,720]:[720,1280];}
function applyShape(){const [w,h]=frameSize();for(const id of ['captionPreview','finishCanvas']){const c=$(id);if(c&&(c.width!==w||c.height!==h)){c.width=w;c.height=h;}}document.body.classList.toggle('wide-story',w>h);}
function updateCaptionPreview(){const [w,h]=frameSize(),ctx=$('captionPreview').getContext('2d');ctx.clearRect(0,0,w,h);drawCaption(ctx,w,h,captionDraft());}
for(const key of ['captionEnabled','captionText','captionStyle'])$(key).oninput=updateCaptionPreview;
function trimDraft(){return trimRange(trimSession.duration,{start:$('trimStart').value,end:$('trimEnd').value});}
function syncTrim(){
  try{const r=trimDraft();$('trimStartRange').value=String(r.start);$('trimEndRange').value=String(r.end);$('trimInfo').textContent=r.duration.toFixed(2)+'s kept · '+r.start.toFixed(2)+'s → '+r.end.toFixed(2)+'s';$('saveTrim').disabled=false;$('previewTrim').disabled=false;return r;}
  catch(e){$('trimInfo').textContent=e.message;$('saveTrim').disabled=true;$('previewTrim').disabled=true;return null;}
}
function closeTrim(){
  $('trimVideo').pause();$('trimVideo').removeAttribute('src');$('trimVideo').load();
  if(trimSession)URL.revokeObjectURL(trimSession.url);trimSession=null;trimming=false;$('trimDialog').close();updateControls();
}
for(const key of ['trimStart','trimEnd'])$(key).oninput=()=>{ $('trimVideo').pause();syncTrim(); };
for(const [slider,input] of [['trimStartRange','trimStart'],['trimEndRange','trimEnd']])$(slider).oninput=()=>{$('trimVideo').pause();$(input).value=$(slider).value;syncTrim();};
$('trimVideo').onloadedmetadata=()=>{if(trimSession)$('trimVideo').currentTime=Number($('trimStart').value);};
$('trimVideo').onplay=()=>{const r=syncTrim();if(!r){$('trimVideo').pause();return;}if($('trimVideo').currentTime<r.start||$('trimVideo').currentTime>=r.end)$('trimVideo').currentTime=r.start;};
$('trimVideo').ontimeupdate=()=>{if(trimSession&&!$('trimVideo').paused&&$('trimVideo').currentTime>=Number($('trimEnd').value))$('trimVideo').pause();};
$('markTrimStart').onclick=()=>{$('trimStart').value=$('trimVideo').currentTime.toFixed(2);$('trimVideo').pause();syncTrim();};
$('markTrimEnd').onclick=()=>{$('trimEnd').value=$('trimVideo').currentTime.toFixed(2);$('trimVideo').pause();syncTrim();};
$('previewTrim').onclick=async()=>{const r=syncTrim();if(!r)return;$('trimVideo').currentTime=r.start;try{await $('trimVideo').play();}catch(e){$('trimInfo').textContent=e.message;}};
$('resetTrim').onclick=()=>{$('trimVideo').pause();$('trimStart').value='0';$('trimEnd').value=String(trimSession.duration);$('trimVideo').currentTime=0;syncTrim();};
$('saveTrim').onclick=async()=>{
  const r=syncTrim();if(!r)return;$('saveTrim').disabled=true;
  try{const full=r.start===0&&Math.abs(r.end-trimSession.duration)<.001;await S.saveTrim(projectId,trimSession.id,trimSession.version,full?null:r,trimSession.duration,captionDraft());closeTrim();await load(true);notice('Scene changes saved. Playback and export use your edits; the original video is kept.');}
  catch(e){$('trimInfo').textContent=e.message;$('saveTrim').disabled=false;}
};
// Owner test 2026-11-05: silence at the start and end of the clips made a 41 s scene 60 s long. Trims only clips the user has
// not trimmed; each trim is saved like a manual one (✂ Edit trim to adjust, Reset to full clip to undo).
async function clipSound(blob){const buf=await new OfflineAudioContext(1,1,48000).decodeAudioData(await blob.arrayBuffer());return soundBounds(Array.from({length:buf.numberOfChannels},(_,i)=>buf.getChannelData(i)),buf.sampleRate);}
$('cutDeadAir').onclick=async()=>{
  if(busy())return;stop();cuttingAir=true;updateControls();notice('Looking for silence at the start and end of each scene…');let scenes=0,seconds=0,kept=0;
  try{
    for(const id of order){const c=clip(id);if(!c)continue;if(c.trim){kept++;continue;}
      let t=null,duration=0;try{duration=(await inspectClip(c.blob)).duration;t=deadAirTrim(duration,await clipSound(c.blob));}catch{}
      if(!t)continue;await S.saveTrim(projectId,id,c.updatedAt,t,duration);scenes++;seconds+=duration-(t.end-t.start);}
    await load(true);
    notice(scenes?'Cut '+seconds.toFixed(1)+' s of silence from '+scenes+' scene'+(scenes>1?'s':'')+'. Use ✂ Edit trim to adjust a scene, or Reset to full clip to undo.':'No silence long enough to cut.'+(kept?' Scenes you trimmed yourself were left as they are.':''));
  }catch(e){notice(e.message,true);}finally{cuttingAir=false;updateControls();}
};
$('closeTrim').onclick=closeTrim;$('trimDialog').oncancel=e=>{e.preventDefault();closeTrim();};
async function reorder(id,delta){stop();order=S.moveScene(order,id,delta);await S.saveOrder(projectId,order);render();}
async function importOne(id,file){
  if(!file||busy())return;importing=true;stop();updateControls();
  try{S.validateClip(file);await inspectClip(file);await S.putClip(projectId,id,file,file.name);notice('Clip saved for '+id+'.');revision='';await load(true);}finally{importing=false;updateControls();}
}
function render(){
  for(const id of [...tiles.keys()])if(!order.includes(id))removeTile(id);
  if(!project){$('summary').textContent='Create an AI Story project first, then open it here.';for(const id of ['referenceCount','sceneCount','videoCount'])$(id).textContent=({referenceCount:'Character References',sceneCount:'Scenes',videoCount:'Video'})[id]+' · 0';updateControls();return;}
  const assets=project.project.assets||[],images=project.media||{};
  $('referenceCount').textContent='Character References · '+assets.filter(a=>images[a.id]?.blob).length+'/'+assets.length;
  $('sceneCount').textContent='Scenes · '+project.project.scenes.filter(s=>images[s.id]?.blob).length+'/'+project.project.scenes.length;
  $('videoCount').textContent='Video · '+order.filter(id=>clip(id)).length+'/'+order.length;
  $('summary').textContent=order.length+' scenes · '+order.filter(id=>clip(id)).length+' clips ready · '+(order.length-order.filter(id=>clip(id)).length)+' missing';
  for(const [index,id] of order.entries()){
    const scene=project.project.scenes.find(s=>s.id===id),c=clip(id);
    const version=JSON.stringify([projectId,c?.updatedAt||0,c?.sourceVersion||'',images[id]?.sha256||images[id]?.blob?.size||0,scene.speech,scene.caption]);
    let tile=tiles.get(id);if(tile&&tile.version!==version){removeTile(id);tile=null;}
    if(!tile){tile=createTile(id,scene,c,images,version);tiles.set(id,tile);}
    {const n=tile.card.querySelector('.scene-number');n.textContent='#'+(index+1);n.title='Scene '+(index+1);n.setAttribute('aria-label','Scene '+(index+1));}updateTileTrim(id,tile);
    for(const b of tile.card.querySelectorAll('[data-delta]'))b.dataset.boundary=String(index+Number(b.dataset.delta)<0||index+Number(b.dataset.delta)>=order.length);
    const position=$('scenes').children[index];if(position!==tile.card)$('scenes').insertBefore(tile.card,position||null);
  }
  updateControls();for(const [id,tile] of tiles)tile.card.classList.toggle('selected',id===selected);
}

async function load(force=false){
  if(loading||exporter||trimming||editingAudio||publishKit?.isOpen()||narration?.isOpen())return;loading=true;
  try{
    records=await S.projects();records.sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    if(!records.some(p=>p.id===projectId))projectId=records[0]?.id||'';
    project=records.find(p=>p.id===projectId);
    renderProjectPicker();
    if(!project){stop();localClips=[];order=[];selected='';for(const id of [...tiles.keys()])removeTile(id);render();return;}
    applyShape();
    const edits=await S.edit(projectId);order=S.sceneOrder(project.project.scenes,edits.order);localClips=await S.clips(projectId);mix=edits.audio||{};configureMusic();savedFinish=edits.finish?F.finishSettings(edits.finish):null;$('qualityLabel').textContent=currentFinish().quality+'p MP4';
    const next=JSON.stringify([projectId,order,audioSettings(mix),mix.name,mix.updatedAt,!!mix.music,localClips.map(c=>[c.key,c.updatedAt,c.trim,c.caption]),Object.entries(project.media||{}).map(([id,m])=>[id,m.sha256||m.blob?.size]),project.project.scenes.map(s=>s.speech)]);
    if(force||revision!==next){revision=next;render();}
    await narration?.refresh(projectId);configureMusic();
  }catch(e){notice(e.message,true);}finally{loading=false;}
}
let pickerRevision='';
function closeProjectPicker(focus=false){$('projectMenu').hidden=true;$('projects').setAttribute('aria-expanded','false');if(focus)$('projects').focus();}
function renderProjectOptions(){
  const query=$('projectSearch').value.trim().toLocaleLowerCase();
  const rows=records.filter(p=>(S.projectTitle(p)+' Part '+(p.setup?.partNumber||1)).toLocaleLowerCase().includes(query)).map(p=>{
    const row=action('',async()=>{if(busy())return;closeProjectPicker(true);stop();projectId=p.id;selected='';await load(true);});row.className='project-option';row.setAttribute('aria-pressed',String(p.id===projectId));
    const icon=node('span',String(S.projectTitle(p)).slice(0,1).toUpperCase(),'project-mark');icon.setAttribute('aria-hidden','true');
    const copy=node('span',undefined,'project-option-copy');copy.append(Object.assign(node('strong',S.projectTitle(p)),{className:'project-source-title'}),node('small','Part '+(p.setup?.partNumber||1)+'  ·  '+p.project.scenes.length+' scenes'+(p.state==='videos_finished'?'  ·  Complete':'')));
    const check=node('span',p.id===projectId?'✓':'','project-check');check.setAttribute('aria-hidden','true');row.append(icon,copy,check);return row;
  });
  $('projectOptions').replaceChildren(...(rows.length?rows:[node('p',records.length?'No matching projects.':'Create an AI Story project to begin.','project-empty')]));
}
function renderProjectPicker(){
  {const title=$('projects').querySelector('.project-trigger-title');title.toggleAttribute('data-no-i18n',Boolean(project));title.textContent=project?S.projectTitle(project):'Choose a story';}
  $('projectPart').textContent='Part '+(project?.setup?.partNumber||1);$('projectPart').hidden=!project;
  $('projectTotal').textContent=records.length+' projects';
  const next=JSON.stringify([projectId,records.map(p=>[p.id,p.project.title,p.setup?.partNumber,p.project.scenes.length,p.state])]);
  if(next!==pickerRevision){pickerRevision=next;renderProjectOptions();}
}
$('projects').onclick=()=>{if(busy())return;const open=$('projectMenu').hidden;$('projectMenu').hidden=!open;$('projects').setAttribute('aria-expanded',String(open));if(open){$('projectSearch').value='';renderProjectOptions();$('projectSearch').focus();}};
$('projectSearch').oninput=renderProjectOptions;
$('projectPicker').addEventListener('keydown',e=>{
  if(e.key==='Escape'&&!$('projectMenu').hidden){e.preventDefault();closeProjectPicker(true);return;}
  if(e.target===$('projects')&&['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();if($('projectMenu').hidden)$('projects').click();}
  if($('projectMenu').hidden)return;
  const rows=[...$('projectOptions').querySelectorAll('button')],at=rows.indexOf(document.activeElement);
  if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();rows[at<0?(e.key==='ArrowDown'?0:rows.length-1):(at+(e.key==='ArrowDown'?1:-1)+rows.length)%rows.length]?.focus();}
  else if(at>=0&&['Home','End'].includes(e.key)){e.preventDefault();rows[e.key==='Home'?0:rows.length-1]?.focus();}
});
document.addEventListener('click',e=>{if(!$('projectPicker').contains(e.target))closeProjectPicker();});
$('projectPicker').addEventListener('focusout',e=>{if(!$('projectPicker').contains(e.relatedTarget))closeProjectPicker();});
$('refresh').onclick=()=>load(true);
$('resetOrder').onclick=async()=>{if(!project||busy())return;stop();order=project.project.scenes.map(s=>s.id);await S.saveOrder(projectId,order);render();};
$('import').onclick=()=>$('files').click();
$('files').onchange=async()=>{
  if(!project||busy())return;const files=Array.from($('files').files);$('files').value='';importing=true;stop();updateControls();let count=0,unmatched=0;const errors=[];
  try{const assigned=new Set();for(const f of files){const id=S.matchingScene(f.name,project);if(!id||assigned.has(id)){unmatched++;continue;}assigned.add(id);try{S.validateClip(f);await inspectClip(f);await S.putClip(projectId,id,f,f.name);count++;}catch(e){errors.push(f.name+': '+e.message);}}
    notice(count+' clips imported.'+(unmatched?' '+unmatched+' unmatched/duplicate files: use Add clip on the matching scene.':'')+(errors.length?'\n'+errors.join('\n'):''),!!errors.length);await load(true);
  }finally{importing=false;updateControls();}
};
function timeline(){return order.map(id=>{const duration=tiles.get(id)?.video?.duration||project.project.scenes.find(s=>s.id===id)?.durationSeconds||0;return {id,...trimRange(duration,clip(id)?.trim)};});}
function configureMusic(){
  const original=narration?.state().active?narration.originalVolume():audioSettings(mix).originalVolume;
  for(const tile of tiles.values())if(tile.video)tile.video.volume=original;
  // IndexedDB can clone Blob wrappers on refresh. Preserve a playing soundtrack unless project/music changes.
  const signature=projectId+':'+(mix.name||'')+':'+(mix.music?.size||0)+':'+(mix.music?.type||'')+':'+(mix.updatedAt||0);
  if(musicBlob===signature)return;musicBlob=signature;musicPlayer.pause();musicPlayer.removeAttribute('src');
  if(musicURL)URL.revokeObjectURL(musicURL);musicURL=null;
  if(mix.music){musicURL=URL.createObjectURL(mix.music);musicPlayer.src=musicURL;musicPlayer.loop=true;}
}
// Story time of the selected tile's playhead (music and narration follow it).
function storyTimeAt(id){const video=tiles.get(id)?.video,spans=timeline(),at=spans.findIndex(s=>s.id===id);if(!video||at<0)return null;return {time:spans.slice(0,at).reduce((n,s)=>n+s.duration,0)+Math.max(0,video.currentTime-spans[at].start),total:spans.reduce((n,s)=>n+s.duration,0)};}
function syncMusic(id,playing){
  narration?.sync(id?storyTimeAt(id)?.time??null:null,playing&&!!id);
  if(!playing||!id||!mix.music){musicPlayer.pause();return;}
  const clock=storyTimeAt(id);if(!clock)return;const {time,total}=clock;
  musicPlayer.volume=audioSettings(mix).musicVolume*musicFade(time,total);
  if(Number.isFinite(musicPlayer.duration)&&musicPlayer.duration>0){const offset=time%musicPlayer.duration;if(Math.abs(musicPlayer.currentTime-offset)>.25)musicPlayer.currentTime=offset;}
  if(musicPlayer.paused)musicPlayer.play().catch(()=>{});
}
function updateAudioDraft(){
  const levels=audioSettings(audioDraft||{});$('originalVolume').value=String(levels.originalVolume*100);$('musicVolume').value=String(levels.musicVolume*100);$('originalLevel').textContent=$('originalVolume').value+'%';$('musicLevel').textContent=$('musicVolume').value+'%';
  $('musicName').textContent=audioDraft?.name||'No music added';$('duckMusic').checked=levels.duck;$('removeMusic').disabled=!audioDraft?.music;
  $('musicPreview').pause();if($('musicPreview').dataset.url)URL.revokeObjectURL($('musicPreview').dataset.url);$('musicPreview').removeAttribute('src');delete $('musicPreview').dataset.url;
  if(audioDraft?.music){const u=URL.createObjectURL(audioDraft.music);$('musicPreview').src=u;$('musicPreview').dataset.url=u;}$('musicPreview').hidden=!audioDraft?.music;$('musicPreview').volume=levels.musicVolume;
}
function closeAudio(){musicInspection++;libraryPreview.pause(); $('musicPreview').pause();if($('musicPreview').dataset.url)URL.revokeObjectURL($('musicPreview').dataset.url);delete $('musicPreview').dataset.url;$('musicPreview').removeAttribute('src');audioDraft=null;editingAudio=false;$('audioDialog').close();updateControls(); }
$('openAudio').onclick=()=>{if(busy()||!project)return;stop();$('saveAudio').disabled=false;editingAudio=true;audioDraft={...mix};updateControls();updateAudioDraft();renderLibrary();$('audioInfo').textContent='';$('musicFile').value='';$('audioDialog').showModal();};
$('musicFile').onchange=async()=>{const file=$('musicFile').files[0],inspection=++musicInspection;if(!file)return;$('saveAudio').disabled=true;try{await inspectMusic(file);if(!editingAudio||inspection!==musicInspection)return;audioDraft={...audioDraft,music:file,name:file.name};updateAudioDraft();$('audioInfo').textContent='Track ready.';}catch(e){if(inspection===musicInspection)$('audioInfo').textContent=e.message;}finally{if(inspection===musicInspection)$('saveAudio').disabled=false;}};
$('removeMusic').onclick=()=>{audioDraft={...audioDraft,music:null,name:''};updateAudioDraft();};
$('originalVolume').oninput=()=>{audioDraft.originalVolume=Number($('originalVolume').value)/100;$('originalLevel').textContent=$('originalVolume').value+'%';};
$('musicVolume').oninput=()=>{audioDraft.musicVolume=Number($('musicVolume').value)/100;$('musicLevel').textContent=$('musicVolume').value+'%';$('musicPreview').volume=audioDraft.musicVolume;};
$('saveAudio').onclick=async()=>{try{$('saveAudio').disabled=true;await S.saveAudio(projectId,audioDraft);mix=audioDraft;closeAudio();await load(true);notice('Story audio saved. Music and volume settings apply to playback and export.');}catch(e){$('audioInfo').textContent=e.message;}finally{$('saveAudio').disabled=false;}};
$('cancelAudio').onclick=closeAudio;$('closeAudio').onclick=closeAudio;$('audioDialog').oncancel=e=>{e.preventDefault();closeAudio();};
$('previewAll').onclick=()=>{if(order.length&&order.every(id=>clip(id)))playback.play(order[0],true);};
$('stopPreview').onclick=stop;
// plain=true: the Overnight Factory's export (owner 2026-10-24: no subtitles, no music). Returns true when saved.
async function exportStory({plain=false}={}){
  if(busy()||!project)return false;stop();exporter=new AbortController();updateControls();$('progress').value=0;$('exportStatus').textContent='Checking clips and browser support…';$('exportDialog').showModal();
  try{$('exportStatus').textContent=plain?'Preparing the video…':'Timing subtitles to the voices…';const base=currentFinish(),finish=plain?F.finishSettings({...base,subtitles:{...base.subtitles,enabled:false}}):base,pro=finish.quality==='1080'&&await isPro(),wide=project?.aspect==='16:9',size=pro?(wide?{width:1920,height:1080}:{width:1080,height:1920}):(wide?{width:1280,height:720}:{width:720,height:1280});
    // Narration (opt-in): never in the Factory's plain export; a stale narration stops here with its fix (owner 2026-10-31).
    const narrated=plain?null:await narration.exportOptions();
    const audio=plain?{...mix,music:null}:narrated?{...mix,originalVolume:narrated.originalVolume}:mix;
    const finished=[];for(const id of order)finished.push({...clip(id),cues:finish.subtitles.enabled?await cuesFor(id):[],voice:plain||!audioSettings(mix).duck||!mix.music?[]:await voiceFor(id)});
    const blob=await renderStory(finished,{...size,finish,audio,narration:narrated?.narration||null,signal:exporter.signal,onProgress:p=>{$('progress').value=p.percent;$('exportStatus').textContent='Scene '+p.scene+' of '+p.total+' · '+p.percent+'%';}});
    // Owner 2026-10-29: the MP4 and a ready-to-post caption go in the story's own folder, next to its scenes.
    const name=exportBaseName(project),folder=await saveToStoryFolder(blob,name+'.mp4',project,records,{signal:exporter.signal});
    try{const caption=(await S.edit(projectId)).publish?.caption||suggestedPost(project).caption;if(caption)await saveToStoryFolder(new Blob([caption.replace(/\r?\n/g,'\r\n')],{type:'text/plain'}),name+' - caption.txt',project,records);}catch(e){console.warn('Caption file:',e);}
    notice('Your finished MP4 and its caption are ready'+(folder?' in Downloads/'+folder:'. Check your downloads')+'.');
    return true;
  }catch(e){notice(e.name==='AbortError'?'Export cancelled. Your clips are saved.':e.message,e.name!=='AbortError');if(plain)throw e;return false;}finally{exporter=null;$('exportDialog').close();updateControls();}
}
$('export').onclick=()=>exportStory();
// Overnight Factory: story-workspace.html?project=ID&factoryExport=1 exports by itself, tells the panel and closes.
if(params.get('factoryExport')==='1')(async()=>{
  const report=(ok,error='')=>chrome.runtime.sendMessage({type:'factory-export-done',projectId,ok,error}).catch(()=>{});
  try{
    for(const limit=Date.now()+120000;!(project&&order.length&&order.every(id=>clip(id)));){if(Date.now()>limit)throw Error('Not every scene has its video clip in the workspace.');await new Promise(r=>setTimeout(r,1000));}
    await new Promise(r=>setTimeout(r,1500));
    if(!await exportStory({plain:true}))throw Error('The export did not start.');
    await report(true);setTimeout(()=>window.close(),4000);
  }catch(e){await report(false,String(e?.message||e));}
})();
// ---------- Finish the video (Phase 1, owner 2026-10-19): automatic subtitles, styles, titles, 1080p, SRT ----------
let savedFinish=null,editingFinish=false,finishDraft=null,finishIndex=0,finishURL=null,finishLoop=0,planCache=null;
const voiceCache=new Map(),infoCache=new Map();
function currentFinish(){return savedFinish||F.initialFinish(project?.setup||project?.project?.setup||{},S.projectTitle(project||{}));}
// Pro check for 1080p (owner 2026-11-05: a Pro member saw 1080p greyed out). The answer used to come only from the 0xFlow
// panel; with the panel closed, or slow to reply, the Workspace decided "not Pro" and kept that for a minute. It now asks
// the server itself when the panel gives no plan, and when nothing can be checked it does not lock the member out
// (the same rule as the run limits: never block work because of a connection problem). Only a real answer is cached.
async function serverPlan(){
  try{
    const c=await chrome.storage.local.get(['remoteRepairUrl','remoteRepairToken']);if(!c.remoteRepairUrl||!c.remoteRepairToken)return null;
    const base=new URL(String(c.remoteRepairUrl).trim()).href.replace(/\/+$/,'');
    const r=await fetch(base+'/usage/generations',{headers:{Authorization:'Bearer '+c.remoteRepairToken},redirect:'error',signal:AbortSignal.timeout(15000)});
    const b=r.ok?await r.json():null;return b&&typeof b.used==='number'?{pro:!!b.unlimited}:null;
  }catch{return null;}
}
async function isPro(){
  if(planCache&&Date.now()-planCache.at<60000)return planCache.pro;
  let answer=null;
  try{const r=await chrome.runtime.sendMessage({type:'story-plan'});if(r?.ok&&r.plan&&r.plan!=='unknown')answer={pro:!!r.pro};}catch{}
  if(!answer||!answer.pro)answer=(await serverPlan())||answer;   // a "free" from the panel is double-checked too
  if(!answer)return true;
  planCache={pro:answer.pro,at:Date.now()};return answer.pro;
}
async function clipInfo(id){const c=clip(id);if(!c)return null;const key=c.key+':'+c.updatedAt;if(!infoCache.has(key))infoCache.set(key,inspectClip(c.blob));const m=await infoCache.get(key);return {...m,range:trimRange(m.duration,c.trim)};}
async function cuesFor(id){
  const narrated=await narration?.cuesFor(id);if(narrated)return narrated;
  const c=clip(id);if(!c)return [];const key=c.key+':'+c.updatedAt;
  if(!voiceCache.has(key))voiceCache.set(key,analyzeVoice(c.blob));
  const [segments,info]=await Promise.all([voiceCache.get(key),clipInfo(id)]);
  const scene=project.project.scenes.find(s=>s.id===id)||{};
  return F.timeCues(subtitleText(project,scene),info.duration,segments);
}
async function storyTimeline(){let at=0;const rows=[];for(const id of order){const info=await clipInfo(id);if(!info)continue;rows.push({id,offset:at,trimStart:info.range.start,keptDuration:info.range.duration});at+=info.range.duration;}return {rows,total:at};}
function renderStyleChips(){
  const box=$('styleChips');box.replaceChildren();
  for(const style of F.CAPTION_STYLES){const b=node('button',F.STYLE_LABELS[style],'chip');b.type='button';b.setAttribute('aria-pressed',String(finishDraft.subtitles.style===style));b.onclick=()=>{finishDraft.subtitles.style=style;renderStyleChips();};box.append(b);}
}
function fillFinishForm(){
  const d=finishDraft;$('subsEnabled').checked=d.subtitles.enabled;$('subsPosition').value=d.subtitles.position;$('subsHighlight').value=d.subtitles.highlight;
  $('subsSize').value=String(Math.round(d.subtitles.size*100));$('subsSizeOut').textContent=$('subsSize').value+'%';
  $('titleEnabled').checked=d.title.enabled;$('titleText').value=d.title.text;$('endEnabled').checked=d.end.enabled;$('endText').value=d.end.text;
  for(const b of document.querySelectorAll('[data-quality]'))b.setAttribute('aria-pressed',String(b.dataset.quality===d.quality));renderStyleChips();$('slowZoom').checked=d.effects.slowZoom;renderTransitionChips();
}
function readFinishForm(){
  finishDraft=F.finishSettings({subtitles:{enabled:$('subsEnabled').checked,style:finishDraft.subtitles.style,position:$('subsPosition').value,size:Number($('subsSize').value)/100,highlight:$('subsHighlight').value},
    title:{enabled:$('titleEnabled').checked,text:$('titleText').value,seconds:finishDraft.title.seconds},end:{enabled:$('endEnabled').checked,text:$('endText').value},effects:{...finishDraft.effects,transition:$('transitionsEnabled').checked?(finishDraft.effects.transition==='cut'?'fade':finishDraft.effects.transition):'cut',slowZoom:$('slowZoom').checked},quality:finishDraft.quality});
}
async function showFinishScene(index){
  const ids=order.filter(id=>clip(id));if(!ids.length)return;finishIndex=(index+ids.length)%ids.length;const id=ids[finishIndex];
  if(finishURL)URL.revokeObjectURL(finishURL);finishURL=URL.createObjectURL(clip(id).blob);
  const v=$('finishVideo');v.src=finishURL;$('finishScene').textContent='Scene '+(order.indexOf(id)+1)+' of '+order.length;
  const [cues,info,line]=await Promise.all([cuesFor(id),clipInfo(id),storyTimeline()]);
  if(project.kind==='manual')$('finishInfo').textContent=cues.length?'Subtitles use dialogue from your saved prompts. Check it against the spoken audio.':'No dialogue text found for this scene. Add your subtitle text in Trim, then Save changes.';
  v.dataset.scene=id;v.currentTime=info.range.start;v.preview={cues,info,row:line.rows.find(r=>r.id===id),total:line.total};
}
function drawFinishFrame(){
  if(!editingFinish)return;finishLoop=requestAnimationFrame(drawFinishFrame);
  const [FW,FH]=frameSize(),v=$('finishVideo'),p=v.preview,ctx=$('finishCanvas').getContext('2d');ctx.clearRect(0,0,FW,FH);if(!p)return;
  const c=clip(v.dataset.scene),storyTime=p.row.offset+Math.max(0,v.currentTime-p.info.range.start);
  const ids=order.filter(id=>clip(id)),look=F.frameLook(finishDraft.effects,ids.indexOf(v.dataset.scene),ids.length,Math.max(0,v.currentTime-p.info.range.start),p.info.range.duration);
  v.style.transform=look.scale>1.0005?`scale(${look.scale.toFixed(4)})`:'';F.drawOverlay(ctx,FW,FH,look);
  if(c?.caption?.enabled)drawCaption(ctx,FW,FH,c.caption);else F.drawSubtitle(ctx,FW,FH,p.cues,v.currentTime,finishDraft.subtitles);
  F.drawTitle(ctx,FW,FH,finishDraft.title,storyTime);
  // The end card plays as an extra ending after the last scene: preview it when the last clip reaches its end.
  if(p.row.offset+p.row.keptDuration>=p.total-0.01&&v.currentTime>=p.info.range.end-0.05)F.drawEndCard(ctx,FW,FH,finishDraft.end,0);
}
function closeFinish(){editingFinish=false;cancelAnimationFrame(finishLoop);const v=$('finishVideo');v.pause();v.removeAttribute('src');v.preview=null;if(finishURL)URL.revokeObjectURL(finishURL);finishURL=null;$('finishDialog').close();updateControls();}
$('openFinish').onclick=async()=>{
  if(busy()||!project)return;stop();editingFinish=true;finishDraft=structuredClone(currentFinish());updateControls();fillFinishForm();$('finishInfo').textContent=savedFinish?'':'Optional finishing starts off. Choose what you want, then Save finish.';
  $('finishDialog').showModal();drawFinishFrame();
  const pro=await isPro();const hd=document.querySelector('[data-quality="1080"]');hd.disabled=!pro;$('qualityNote').textContent=pro?'1080p takes about twice as long to export.':'1080p export is part of Pro. 720p is free.';
  if(!pro&&finishDraft.quality==='1080'){finishDraft.quality='720';fillFinishForm();}
  try{await showFinishScene(0);}catch(e){$('finishInfo').textContent=e.message;}
};
for(const id of ['subsEnabled','subsPosition','subsHighlight','subsSize','titleEnabled','titleText','endEnabled','endText','slowZoom','transitionsEnabled'])$(id).addEventListener('input',()=>{readFinishForm();$('subsSizeOut').textContent=$('subsSize').value+'%';renderTransitionChips();});
for(const b of document.querySelectorAll('[data-quality]'))b.onclick=()=>{if(b.disabled)return;finishDraft.quality=b.dataset.quality;fillFinishForm();};
$('oneClickFinish').onclick=()=>{const quality=finishDraft.quality;finishDraft=F.presetFor(project.setup||project.project.setup||{},S.projectTitle(project));finishDraft.quality=quality;fillFinishForm();$('finishInfo').textContent='Suggested preset enabled. Uncheck anything you do not want, then Save finish.';};
$('finishPrev').onclick=()=>showFinishScene(finishIndex-1).catch(e=>$('finishInfo').textContent=e.message);
$('finishNext').onclick=()=>showFinishScene(finishIndex+1).catch(e=>$('finishInfo').textContent=e.message);
$('saveFinish').onclick=async()=>{try{readFinishForm();await S.saveFinish(projectId,finishDraft);savedFinish=F.finishSettings(finishDraft);closeFinish();await load(true);notice('Finish settings saved. They apply to the exported MP4.');}catch(e){$('finishInfo').textContent=e.message;}};
for(const tab of document.querySelectorAll('.finish-tabs [data-tab]'))tab.onclick=()=>{for(const t of document.querySelectorAll('.finish-tabs [data-tab]'))t.setAttribute('aria-selected',String(t===tab));for(const p of document.querySelectorAll('[data-panel]'))p.hidden=p.dataset.panel!==tab.dataset.tab;};
$('cancelFinish').onclick=closeFinish;$('closeFinish').onclick=closeFinish;$('finishDialog').oncancel=e=>{e.preventDefault();closeFinish();};
$('downloadSrt').onclick=async()=>{
  try{const line=await storyTimeline(),scenes=[];for(const row of line.rows)scenes.push({...row,cues:await cuesFor(row.id)});
    await saveToStoryFolder(new Blob([F.toSRT(scenes)],{type:'application/x-subrip'}),exportBaseName(project)+'.srt',project,records);
    $('finishInfo').textContent='Subtitles downloaded (.srt).';}catch(e){$('finishInfo').textContent=e.message;}
};
// ---------- Phase 2: effects in the Finish popup, music library + ducking in Music & audio ----------
function renderTransitionChips(){
  const box=$('transitionChips');box.replaceChildren();$('transitionsEnabled').checked=finishDraft.effects.transition!=='cut';
  for(const t of F.TRANSITIONS){const b=node('button',F.TRANSITION_LABELS[t],'chip');b.type='button';b.setAttribute('aria-pressed',String(finishDraft.effects.transition===t));b.onclick=()=>{finishDraft.effects.transition=finishDraft.effects.transition===t?'cut':t;renderTransitionChips();};box.append(b);}
}
async function voiceFor(id){const narrated=narration?.voiceFor(id);if(narrated)return narrated;const c=clip(id);if(!c)return [];const key=c.key+':'+c.updatedAt;if(!voiceCache.has(key))voiceCache.set(key,analyzeVoice(c.blob));return voiceCache.get(key);}
const MUSIC_BASE='https://repair.corethea.com/music/';let library=null,libraryMood='',libraryPreview=new Audio();
async function libraryTrackFile(track){
  const url=new URL(track.file,MUSIC_BASE).href,cache=await caches.open('flow-music-v1');
  let res=await cache.match(url);if(!res){res=await fetch(url);if(!res.ok)throw Error('This track could not be downloaded. Try again later.');await cache.put(url,res.clone());}
  return new File([await res.blob()],track.file.split('/').pop(),{type:'audio/mpeg'});
}
async function renderLibrary(){
  const list=$('libraryList'),moods=$('libraryMoods');
  try{if(!library){const r=await fetch(MUSIC_BASE+'manifest.json',{cache:'no-cache'});if(!r.ok)throw Error();library=(await r.json()).tracks||[];}}
  catch{list.replaceChildren(node('p','The music library is not available right now. You can still use your own file.','trim-note'));moods.replaceChildren();return;}
  const all=[...new Set(library.map(t=>t.mood))];if(!libraryMood||!all.includes(libraryMood))libraryMood=all[0]||'';
  moods.replaceChildren(...all.map(m=>{const b=node('button',m,'chip');b.type='button';b.setAttribute('aria-pressed',String(m===libraryMood));b.onclick=()=>{libraryMood=m;renderLibrary();};return b;}));
  list.replaceChildren(...library.filter(t=>t.mood===libraryMood).map(t=>{
    const row=node('div',undefined,'track'),play=node('button','▶','track-play');play.type='button';play.setAttribute('aria-label','Preview '+t.title);
    play.onclick=()=>{const url=new URL(t.file,MUSIC_BASE).href;if(libraryPreview.src===url&&!libraryPreview.paused){libraryPreview.pause();play.textContent='▶';return;}for(const b of list.querySelectorAll('.track-play'))b.textContent='▶';libraryPreview.src=url;libraryPreview.volume=.5;libraryPreview.play().catch(()=>{});play.textContent='❚❚';};
    const info=node('div',undefined,'track-info');info.append(node('strong',t.title),node('small',[t.artist,Math.floor(t.seconds/60)+':'+String(Math.round(t.seconds%60)).padStart(2,'0')].filter(Boolean).join(' · ')));
    const use=node('button',audioDraft?.libraryId===t.id?'✓ Using':'Use','track-use');use.type='button';
    use.onclick=async()=>{use.disabled=true;use.textContent='Downloading…';try{const file=await libraryTrackFile(t);await inspectMusic(file);// Library tracks are loudness-normalized: the old 15 % default made them almost silent (owner export 2026-10-19).
      const quiet=!(audioDraft?.musicVolume>0.15);audioDraft={...audioDraft,music:file,name:t.title+(t.artist?' — '+t.artist:'')+' (public domain)',libraryId:t.id,...(quiet?{musicVolume:0.35}:{})};libraryPreview.pause();updateAudioDraft();renderLibrary();$('audioInfo').textContent='Track ready.';}catch(e){$('audioInfo').textContent=e.message;use.disabled=false;use.textContent='Use';}};
    row.append(play,info,use);return row;}));
}
$('duckMusic').onchange=()=>{audioDraft.duck=$('duckMusic').checked;};
$('cancelExport').onclick=()=>exporter?.abort();$('exportDialog').oncancel=e=>{e.preventDefault();exporter?.abort();};
$('popout').onclick=async()=>{try{if(globalThis.chrome?.windows?.create&&globalThis.chrome?.tabs?.getCurrent){const tab=await chrome.tabs.getCurrent();await chrome.windows.create({tabId:tab.id,type:'popup',width:1380,height:900});}else window.open(location.href,'flow-story-workspace','popup,width=1380,height=900');}catch(e){notice('Could not pop out: '+e.message,true);}};
window.addEventListener('beforeunload',e=>{if(exporter||importing){e.preventDefault();e.returnValue='';}});
const channel=new BroadcastChannel('flow-story-workspace');channel.onmessage=e=>{if(e.data?.projectId===projectId)load();};
setInterval(()=>{if(document.visibilityState==='visible'&&!importing)load();},4000);
setInterval(()=>{if(document.visibilityState==='visible')pollRegeneration();},2000);
window.addEventListener('pagehide',()=>{channel.close();musicPlayer.pause();if(musicURL)URL.revokeObjectURL(musicURL);playback.clear();for(const tile of tiles.values())for(const u of tile.urls)URL.revokeObjectURL(u);});
publishKit=createPublishKit({getProject:()=>project,isBusy:busy,stop,onChange:updateControls,request:panelRequest});
// AI narration pilot: off unless chrome.storage.local narrationPilot === true (or ?narration=1 on the local preview page).
const narrationPilot=new URLSearchParams(location.search).get('narration')==='1'||await globalThis.chrome?.storage?.local?.get('narrationPilot').then(x=>x.narrationPilot===true,()=>false)===true;
// Own voice API key (owner 2026-11-11, paid Pro): Google AI Studio or ElevenLabs, charged to the member. Pro unlocks the 🎙 button
// and the own-key panel; the server pilot generator stays for the pilot flag on a non-Pro account.
let narrationPro=false;const hasStorage=!!globalThis.chrome?.storage?.local,byokGenerator=hasStorage?createByokGenerator():null,pilotGenerator=narrationPilot&&hasStorage?createNarrationGenerator():null;
const activeGenerator=()=>narrationPro?byokGenerator:pilotGenerator;
const generator=hasStorage?{opened:a=>activeGenerator()?.opened(a),render:a=>activeGenerator()?.render(a),stop:()=>{byokGenerator?.stop();pilotGenerator?.stop();},available:()=>!!activeGenerator()?.available()}:null;
narration=createNarration({getProject:()=>project,getOrder:()=>order,storyTimeline,stopPlayback:stop,onChange:updateControls,notice,pilot:()=>narrationPilot||narrationPro,generator});
if(hasStorage)proAccount(serverClient()).then(ok=>{narrationPro=ok;if(ok&&project&&narrationFits(project.setup)&&$('openNarration'))$('openNarration').hidden=false;});
// The narration preview follows the playing tile between scene changes (silent between scene slices).
setInterval(()=>{if(!narration?.state().active||!selected)return;const v=tiles.get(selected)?.video;narration.sync(v&&!v.paused?storyTimeAt(selected)?.time??null:null,!!v&&!v.paused);},200);
await load(true);
await pollRegeneration();
