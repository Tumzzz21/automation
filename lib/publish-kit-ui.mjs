import * as S from './story-workspace.mjs';
import {publishDraft,suggestedPost,coverReferences,defaultCoverReferences,coverReferenceLabel,coverPreviewDraft,fallbackCoverScene,drawCover,coverWide} from './publish-kit.mjs';

export function createPublishKit({getProject,isBusy,stop,onChange,request}){
  const $=id=>document.getElementById(id),dialog=$('publishDialog');
  let project=null,draft=null,generated=null,source='scene',pending=null,saving=false,painting=0,timer=null,urls=[],checking=false,previewReady=false;
  const info=text=>$('publishInfo').textContent=text;
  function controls(){
    const locked=!!pending||saving;
    for(const id of ['generateCover','coverEngine','coverMoment','useSceneCover','useGeneratedCover','savePublish'])$(id).disabled=locked;
    for(const el of $('coverReferences').querySelectorAll('input'))el.disabled=locked;
    $('downloadCover').disabled=saving||!previewReady||!(source==='generated'?generated?.blob:project?.media?.[draft?.sceneId]?.blob);
    $('useGeneratedCover').hidden=!generated?.blob;
  }
  function currentDraft(){return publishDraft({...draft,source,headline:$('coverHeadline').value,caption:$('postCaption').value,position:$('headlinePosition').value,sceneId:draft.sceneId});}
  async function paint(){
    if(!project)return false;draft=currentDraft();const revision=++painting;previewReady=false;controls();
    const buffer=document.createElement('canvas');
    try{await drawCover(buffer,source==='generated'?generated?.blob:project.media?.[draft.sceneId]?.blob,coverPreviewDraft(draft,generated),{wide:coverWide(project)});if(revision!==painting||!dialog.open)return false;const canvas=$('coverCanvas');canvas.width=buffer.width;canvas.height=buffer.height;canvas.getContext('2d').drawImage(buffer,0,0);previewReady=true;controls();return true;}
    catch(e){if(revision===painting)info('Could not preview this image: '+e.message);return false;}
  }
  function dispose(){painting++;for(const u of urls)URL.revokeObjectURL(u);urls=[];clearInterval(timer);timer=null;}
  async function open(){
    if(isBusy()||!getProject())return;stop();project=getProject();saving=true;dialog.showModal();onChange();info('Loading cover and caption…');controls();
    try{
      const edits=await S.edit(project.id);draft=publishDraft(edits.publish||suggestedPost(project));generated=edits.cover||null;pending=edits.coverRequestId&&edits.cover?.requestId!==edits.coverRequestId?edits.coverRequestId:null;
      draft.sceneId=fallbackCoverScene(project,draft.sceneId);
      source=generated?.blob&&(!edits.publish||edits.publish.source==='generated')?'generated':'scene';
      $('coverHeadline').value=draft.headline;$('postCaption').value=draft.caption;$('headlinePosition').value=draft.position;
      $('coverEngine').value=['flow','gemini','chatgpt'].includes(project.target?.imagePlatform)?project.target.imagePlatform:'flow';$('coverMoment').value='';
      const defaults=new Set(defaultCoverReferences(project));
      $('coverReferences').replaceChildren(...coverReferences(project).map((a,i)=>{
        const label=document.createElement('label'),input=document.createElement('input'),image=document.createElement('img'),text=document.createElement('span');
        const name=coverReferenceLabel(project,a.id,i);input.type='checkbox';input.value=a.id;input.checked=defaults.has(a.id);input.setAttribute('aria-label','Use '+name);
        const url=URL.createObjectURL(project.media[a.id].blob);urls.push(url);image.src=url;image.alt=name;text.textContent=name;
        label.append(input,image,text);input.onchange=()=>{if($('coverReferences').querySelectorAll('input:checked').length>3){input.checked=false;info('Choose up to three references for one cover.');}};return label;
      }));
      $('coverReferenceNote').textContent=coverReferences(project).length?'Choose the characters to feature (up to 3). Character references are preselected when recognized.':'No saved character references yet. You can generate from the scene description or use a scene image.';
      info('Edit your cover and post caption, then save. Suggested caption uses the title and opening dialogue; review before posting.');
      saving=false;controls();await paint();timer=setInterval(()=>poll().catch(e=>info(e.message)),2000);await poll();
    }catch(e){pending=null;saving=false;info(e.message);controls();}
  }
  async function poll(){
    if(!dialog.open||!pending||checking)return;checking=true;const id=pending,p=project.id;
    try{
      const edits=await S.edit(p);if(!dialog.open||project.id!==p||pending!==id)return;
      if(edits.cover?.requestId===id){generated=edits.cover;pending=null;source='generated';info('New cover saved. The generated poster includes its title. Download it, or change the title and regenerate.');await paint();return;}
      const status=await request('story-cover-status',{projectId:p,requestId:id});
      if(['starting','running'].includes(status.state))info('Generating your cover · '+(status.detail||'Keep the original side panel open.'));
      else{pending=null;info(status.state==='failed'?'Cover generation failed. Your previous cover is kept. Check Control before retrying.':status.state==='missing'?'The cover was generated but not saved here. Check Control and your downloads.':'Cover is stopped or waiting. Check Control to continue, or start a new cover when the queue is clear.');}
    }catch(e){if(dialog.open&&project.id===p){pending=null;info(e.message+' Your previous cover is kept.');}}finally{checking=false;controls();}
  }
  async function save(){await S.savePublish(project.id,currentDraft());}
  async function close(){
    if(saving)return;saving=true;controls();try{await save();dispose();dialog.close();project=null;pending=null;}catch(e){info('Could not save: '+e.message);}finally{saving=false;onChange();}
  }
  $('openPublish').onclick=()=>open();$('savePublish').onclick=async()=>{saving=true;controls();try{await save();info('Cover headline and caption saved on this device.');}catch(e){info(e.message);}finally{saving=false;controls();}};
  $('closePublish').onclick=close;dialog.oncancel=e=>{e.preventDefault();close();};
  for(const id of ['coverHeadline','headlinePosition'])$(id).oninput=()=>{if(source==='generated'&&generated?.headline)info('This poster’s title is part of its artwork. Click Generate story cover to apply a different title or placement.');paint();};
  $('useSceneCover').onclick=()=>{source='scene';paint();};$('useGeneratedCover').onclick=()=>{source='generated';paint();};
  $('generateCover').onclick=async()=>{
    if(pending||saving)return;saving=true;controls();
    const requestId=crypto.randomUUID(),p=project.id;
    try{
      await save();const refs=Array.from($('coverReferences').querySelectorAll('input:checked'),x=>x.value);
      info('Starting cover generation. This uses image-generation credits.');
      pending=requestId;
      await request('story-cover',{projectId:p,requestId,platform:$('coverEngine').value,referenceIds:refs,moment:$('coverMoment').value,headline:$('coverHeadline').value,position:$('headlinePosition').value});
      if(dialog.open&&project?.id===p)info('Cover generation started. You can close this editor; the result will be saved to this story.');
    }catch(e){if(dialog.open&&project?.id===p){pending=null;info(e.message);}}finally{saving=false;controls();}
  };
  $('copyPostCaption').onclick=async()=>{try{await navigator.clipboard.writeText($('postCaption').value);await save();info('Post caption copied.');}catch(e){info('Copy unavailable. Select the caption text and copy it manually. '+e.message);}};
  $('downloadCover').onclick=async()=>{
    if(saving)return;saving=true;controls();
    try{if(!await paint())throw Error('Wait for a valid cover preview before downloading.');await save();const blob=await new Promise(r=>$('coverCanvas').toBlob(r,'image/jpeg',.93));if(!blob)throw Error('Cover export failed.');const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=(project.project.title||'Story').replace(/[<>:"/\\|?*\x00-\x1f]/g,'').slice(0,90)+'-cover.jpg';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);info('Portrait cover downloaded · 1080 × 1920.');}catch(e){info(e.message);}finally{saving=false;controls();}
  };
  window.addEventListener('pagehide',dispose);
  return {isOpen:()=>dialog.open};
}
