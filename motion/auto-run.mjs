import {motionDuration,flowRefusalHint} from './core.mjs';
import {motionPage} from './auto-page.mjs';
// duration: Flow length in whole seconds (a Motion Studio piece); settings(seconds): the host sets Flow (main engine).
export async function runMotion({project,tab,prompt,readMedia,checkpoint,progress,stopped,callPage,recover=false,duration=motionDuration(project.source.duration),settings=null,fetchMedia=null,downloadResult=null,onConsent=null,watch=null,preferMenu=false,fetchSigned=null,uploadReal=null,uploadDone=null,realTyping=false}) {
  const resumePreparation=!recover&&/^uploading |^filling prompt$/.test(project.run?.phase||'');
  const run=recover||resumePreparation?project.run:{id:crypto.randomUUID(),url:tab.url,tabId:tab.id,phase:'preparing',startedAt:Date.now()};
  if(!run||run.tabId!==tab.id||run.url!==tab.url)throw Error('Recover using the same Flow project and tab.');
  const check=()=>{if(stopped())throw Error('Paused. If submitted, use Recover result; do not start another generation.');};
  const call=async(action,args={})=>{check();const result=await callPage({action,runId:run.id,expectedUrl:run.url,...args});if(!result?.ok)throw Error(result?.error||'Flow did not answer the "'+action+'" step. Keep the Flow tab open and press Generate again; nothing is sent twice.');return result;};
  const mark=async phase=>{run.phase=phase;await checkpoint({...run});progress(phase);};
  if(!recover){
    if(['dispatching','submitted','collecting','needs_review'].includes(project.run?.phase))throw Error('A previous run needs recovery or review. No new video was submitted.');
    if(resumePreparation){await call('resumePreparation');}
    else{
      await mark('preparing');
      check();await callPage({action:'release',runId:run.id,expectedUrl:run.url}).catch(()=>{});
      // Never send while Flow is still making another video in this project (its "%" tile would look like ours).
      for(let t0=Date.now(),said=false;;){check();const b=await callPage({action:'busy',runId:run.id,expectedUrl:run.url}).catch(()=>null);
        if(!b?.ok||!b.busy)break;
        if(Date.now()-t0>20*60000)throw Error('Flow has been making another video in this project for 20 minutes. Let it finish (or delete it in Flow), then press ↻ on this piece. Nothing was sent.');
        if(!said){said=true;progress('Waiting: Flow is still making another video in this project ('+b.busy+'). This piece is sent when it finishes.');}
        await new Promise(res=>setTimeout(res,3000));}
      // Empty the shared composer first (the previous piece's text and chips), then claim it for this run.
      for(let i=0;;i++){check();const r=await callPage({action:'clearDraft',runId:run.id,expectedUrl:run.url});if(!r?.ok)throw Error(r?.error||'Flow did not answer.');if(r.clean)break;if(i>=12)throw Error('The Flow prompt box could not be cleared. Clear it in Flow, then retry. No video was submitted.');progress(r.waiting||'Clearing the Flow prompt box…');await new Promise(res=>setTimeout(res,700));}
      await call('init');
      if(settings){progress('Setting Flow: Ingredients, '+duration+' s, x1…');await settings(duration);}else await call('settings',{duration});
    }
    let effectivePrompt=prompt;
    for(const role of ['source','character','continuity','background']){
      const file=project[role];if(!file)continue;await mark(`uploading ${role}`);
      const extension=file.name.match(/\.[a-z0-9]+$/i)?.[0]||(role==='source'?'.mp4':'.png');
      const uploadName=`oxm-${run.id}-${role}${extension}`;
      effectivePrompt=effectivePrompt.split(file.name).join(uploadName);
      const existing=resumePreparation?await call('fileStatus',{key:file.key}):{sent:false};
      if(!existing.sent){
      const blob=await readMedia(file.key);if(!blob||blob.size!==file.size)throw Error(`Saved ${role} file is missing. Select it again.`);
      // Real upload first (main engine's flowUploadReal: real clicks, Chrome's file picker); the page upload only if it misses.
      let real=null;
      if(uploadReal){check();await call('beforeUpload');real=await uploadReal({name:uploadName,type:file.type,blob}).catch(e=>({ok:false,error:String(e?.message||e)}));
        if(real?.ok)await call('registerUpload',{key:file.key,name:uploadName,type:file.type});
        else progress('Real upload not used ('+String(real?.error||'unavailable').slice(0,80)+'); uploading through the page.');}
      if(!real?.ok){
      const bytes=new Uint8Array(await blob.arrayBuffer());
      for(let offset=0,index=0;offset<bytes.length;offset+=262144,index++){
        let binary='';const part=bytes.subarray(offset,offset+262144);for(let j=0;j<part.length;j+=8192)binary+=String.fromCharCode(...part.subarray(j,j+8192));
        await call('chunk',{key:file.key,name:uploadName,type:file.type,index,base64:btoa(binary)});
      }
      await call('upload',{key:file.key,size:file.size});
      }
      }
      // Up to 2 minutes for Flow to attach the file, plus up to 10 minutes for the member to answer Flow's agree dialog.
      let ready=false,deadline=Date.now()+120000,asked=false;
      while(Date.now()<deadline){const result=await call('attachment',{name:uploadName,realTyping});if(result.ready){ready=true;break;}if(result.waiting)progress(result.waiting);if(result.consent&&!asked){asked=true;deadline=Math.max(deadline,Date.now()+600000);await onConsent?.();}
        // Answered (or cancelled): back to the normal 2 minutes for Flow to attach the file.
        else if(asked&&!result.consent&&asked!=='answered'){asked='answered';deadline=Date.now()+120000;}await new Promise(r=>setTimeout(r,1200));}
      if(!ready)throw Error(`Flow did not confirm the ${role} attachment. No generation was sent.`);
      await call('closePicker',{realTyping});
    }
    await uploadDone?.().catch?.(()=>{});
    await mark('filling prompt');
    // @ mentions of the pictures are off (the page only types them when sent mentions:true); the extra time is for them.
    for(let i=0,t0=Date.now();;i++){const r=await call('fill',{prompt:effectivePrompt,realTyping});if(r.filled!==false)break;
      if(r.waiting)progress(r.waiting);
      if(r.mentioning?Date.now()-t0>90000:i>=6)throw Error('Flow’s prompt box did not take the cursor. Click into it once, then retry. No video was sent.');
      await new Promise(res=>setTimeout(res,r.mentioning?400:300));}
    await mark('dispatching');await watch?.arm?.();
    {check();const r=await callPage({action:'submit',runId:run.id,expectedUrl:run.url,prompt:effectivePrompt});
      // The page refused before pressing Generate (a reference gone, the prompt changed…): nothing was sent. Owner run
      // 2026-11-12: the piece stayed "dispatching" and Continue offered to collect a video that was never made.
      if(!r?.ok){if(r?.error&&!/already submitted/i.test(r.error))await mark('not sent').catch(()=>{});throw Error(r?.error||'Flow did not answer the "submit" step. Look in the Flow tab before trying again.');}}
    await mark('submitted');
  }
  // Flow's own replies (flow-watch.mjs) name our video and its signed link; the page poll stays as the fallback and
  // still reports Flow's failures.
  const watched=()=>{const w=watch?.result?.();return w&&!w.ambiguous&&w.video?w:null;};
  const deadline=Date.now()+12*60*1000;let result,polls=0;
  while(Date.now()<deadline){check();
    let w=watched();if(w&&(watch.named?.()??true)){result={ready:true,url:w.video,posters:w.poster?[w.poster]:[],watched:w};break;}
    try{result=await call('poll',{sourcesOnly:!!downloadResult});}
    catch(e){if(stopped())throw e;const hint=flowRefusalHint(e.message);if(hint!==e.message){
      // Nothing to collect: free Flow’s prompt box for the next piece and mark the run refused (not "sent"), so ↻ or
      // Continue makes this piece again instead of waiting for a video Flow never made.
      await callPage({action:'finish',runId:run.id,expectedUrl:run.url}).catch(()=>{});await mark('refused').catch(()=>{});
      throw Object.assign(Error(hint),{flowRefused:true});}
      // Owner run 2026-11-12: Flow showed two new videos and Motion could not tell which was its own. Collecting again
      // would stop the same way, so the page is freed and the piece is marked to be made again (↻ or Continue).
      if(/More than one new video/i.test(e.message)){
        await callPage({action:'finish',runId:run.id,expectedUrl:run.url}).catch(()=>{});await mark('unclear').catch(()=>{});
        throw Object.assign(Error(e.message.replace(/ Check Flow manually; no result was selected.?/,'')+' Motion took neither. You can download the right one in Flow, or press ↻ on this piece to make it again.'),{flowUnclear:true});}
      throw e;}
    if(result.ready){
      // The page saw a finished tile; Flow's reply with the link arrives within its next 5 s poll.
      for(let i=0;i<8&&!w&&watch?.result?.()?.id;i++){await new Promise(r=>setTimeout(r,1000));w=watched();}
      // A guessed video (not named by Flow's Generate reply) is used only when the tile we followed shows its picture.
      const pic=src=>String(src||'').match(/\/image\/([0-9a-f-]{36})/i)?.[1]?.toLowerCase();
      if(w&&!(watch.named?.()??true)&&!(pic(w.poster)&&(result.posters||[]).some(p=>pic(p)===pic(w.poster))))w=null;
      if(w)result={ready:true,url:w.video,posters:w.poster?[w.poster]:result.posters||[],watched:w};
      break;
    }
    // Every ~30 s, say what Flow has answered so far (a stuck run shows why in the log).
    polls=(polls||0)+1;progress(polls%12===0&&watch?.summary?'Generating in Flow… ('+watch.summary()+')':'Generating in Flow…');await new Promise(r=>setTimeout(r,2500));}
  if(!result?.ready)throw Error('Generation is still unresolved. Recover this run later; it will not be submitted again.');
  // A later piece must never take this video (owner run 2026-11-13: piece 2 got piece 1's video).
  await call('taken',{media:[...(result.posters||[]),result.url,result.watched?.id,result.watched?.poster].filter(Boolean)}).catch(()=>{});
  await mark('collecting');let blob;
  // Flow's signed link to our own video: read it directly (no hover, no Download menu). A 360p draft saved as 720p
  // upscaled still goes through Flow's Download menu, which makes the upscale.
  if(result.watched&&fetchSigned&&!preferMenu){
    try{const buf=await fetchSigned(result.watched.video);const b=new Blob([buf],{type:'video/mp4'});if(b.size>=1024)blob=b;}
    catch(e){progress('Reading Flow’s link failed ('+(e?.message||e)+'); using Flow’s Download menu…');}
  }
  // The extension reads the finished video itself (the main engine's routine, with the page as fallback); reading it inside
  // the Flow page is cross-site and failed live (owner 2026-11-12).
  if(blob){}
  else if(downloadResult){const buf=await downloadResult({posters:result.posters||[],video:result.url||null});blob=new Blob([buf],{type:'video/mp4'});if(blob.size<1024)throw Error('The downloaded clip is empty. Press Generate again to collect it; it is not sent again.');}
  else if(fetchMedia&&result.url&&/^https:/.test(result.url)){const buf=await fetchMedia(result.url);blob=new Blob([buf],{type:'video/mp4'});if(!blob.size)throw Error('The generated clip came back empty. Press Generate again to collect it; it is not sent again.');}
  else{
  const metadata=await call('fetchResult');const chunks=[];
  for(let offset=0;offset<metadata.size;offset+=262144){const item=await call('resultChunk',{offset});chunks.push(Uint8Array.from(atob(item.base64),c=>c.charCodeAt(0)));}
  blob=new Blob(chunks,{type:metadata.type});if(blob.size!==metadata.size)throw Error('Incomplete result transfer. Recover to collect it again.');
  }
  return {blob,run,finish:()=>call('finish')};
}
// Owner run 2026-11-13 ("unusual activity" again): Motion's page code ran in Flow's own page world (world MAIN) on
// every poll and kept its state there as window.__oxMotionNativeLab, visible to Flow's scripts. Like the main engine since
// 11-07 (Flow page quiet), it now runs in the extension's isolated world: same page, invisible to Flow's code.
export async function callMotionPage(tabId,args,pointer,setLength,hover,typeText){
  const results=await chrome.scripting.executeScript({target:{tabId},world:'ISOLATED',func:motionPage,args:[args]});
  const result=results[0]?.result;
  if(result?.click){
    const {x,y}=result.click;
    if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0)throw Error('Flow returned an invalid click position.');
    if(typeof pointer!=='function')throw Error('The OxFlow click engine is unavailable. Open the preview Control panel.');
    await pointer(tabId,x,y);
  }
  // A finished Flow video mounts only under a real mouse; move there without clicking (a click opens Flow's editor).
  if(result?.hover){
    const {x,y}=result.hover;
    if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0)throw Error('Flow returned an invalid result position.');
    if(typeof hover==='function')await hover(tabId,x,y);
  }
  // Real typing (owner 2026-11-12): Chrome types the text where the real click put the cursor.
  if(result?.typeText){
    if(typeof typeText!=='function')throw Error('The OxFlow typing engine is unavailable. Reload the extension.');
    await typeText(tabId,result.typeText);
  }
  if(result?.setDuration){
    if(typeof setLength!=='function')throw Error('The OxFlow length control is unavailable. Reopen the preview Control panel.');
    try{await setLength(tabId,result.setDuration);}
    catch(error){await chrome.scripting.executeScript({target:{tabId},world:'ISOLATED',func:motionPage,args:[{...args,action:'closeSettings'}]}).catch(()=>{});throw error;}
    const finished=await chrome.scripting.executeScript({target:{tabId},world:'ISOLATED',func:motionPage,args:[{...args,action:'finishSettings'}]});
    const reply=finished[0]?.result;if(!reply?.ok)throw Error(reply?.error||'Flow settings could not be confirmed.');return reply;
  }
  return result;
}
