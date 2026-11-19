// Preview-only entry point, sharing the original Control page's click engine.
// Flow's Length control can live in an inline Angular popover, outside CDK/Radix overlays.
function pg_motionLengthSlider(){
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
  const roots=[...document.querySelectorAll('.cdk-overlay-pane,[role="dialog"],[role="menu"],[data-radix-popper-content-wrapper]')].filter(visible);
  for(const label of document.querySelectorAll('label,span,div,p'))if(label.children.length<=1&&/^Length$/i.test(label.textContent.trim())&&visible(label)){
    for(let p=label.parentElement,depth=0;p&&p!==document.body&&depth<6;p=p.parentElement,depth++)if(/(?:^|[^\d])\d{1,2}\s*Secs?\b/i.test(p.textContent)&&!p.querySelector('video')&&(p.querySelector('[role=slider],input[type=range]')||/Omni|Veo/i.test(p.textContent))){roots.push(p);break;}
  }
  for(const root of roots.sort((a,b)=>a.textContent.length-b.textContent.length)){
    const text=root.innerText||root.textContent,match=text.match(/(?:^|[^\d])(\d{1,2})\s*Secs?\b/i);if(!/Length/i.test(text)||!match)continue;
    const label=Number(match[1]);let context=root;
    for(let i=0;i<4&&context.parentElement&&context.parentElement!==document.body&&!/Omni\s+1\.2\s+Flash/i.test(context.textContent);i++)context=context.parentElement;
    const omni12=/Omni\s+1\.2\s+Flash/i.test(context.textContent);
    const el=[...root.querySelectorAll('[role="slider"],input[type="range"]')].find(visible);
    if(!el){if(omni12&&label>=3&&label<=15)return {ok:true,labelOnly:true,min:3,max:15,now:label,label};continue;}
    const num=v=>v==null||v===''?NaN:Number(v);
    let min=num(el.getAttribute('aria-valuemin')??el.getAttribute('min')),max=num(el.getAttribute('aria-valuemax')??el.getAttribute('max'));
    // Flow's live Angular duration slider indexes its 13 choices as 0..12;
    // the visible header is the duration in seconds (3..15), not that index.
    if(omni12&&(!Number.isFinite(min)||!Number.isFinite(max)||min===0&&(max===1||max===12||max===100))){min=3;max=15;}
    if(!Number.isFinite(min)||!Number.isFinite(max)||max<=min||label<min||label>max)continue;
    let track=el;
    if(el.tagName!=='INPUT')for(let p=el.parentElement;p&&p!==root.parentElement;p=p.parentElement)if(p.getBoundingClientRect().width>el.getBoundingClientRect().width*3){track=p;break;}
    const r=track.getBoundingClientRect(),thumb=el.getBoundingClientRect(),pad=el.tagName==='INPUT'?8:thumb.width/2;
    return {ok:true,min,max,now:label,label,left:r.left+pad,right:r.right-pad,y:thumb.top+thumb.height/2};
  }
  return {ok:false,error:'Flow Length control could not be read'};
}
(() => {
  let owner=null;
  const api={
    get busy(){return owner!==null;},
    acquire(id){if(owner&&owner!==id)throw Error('Another motion study is running.');if(typeof running!=='undefined'&&running)throw Error('Finish or pause your current generation queue first.');owner=id;},
    release(id){if(owner===id)owner=null;},
    // A Motion Studio window that closed or crashed mid-run must not block the queue forever.
    // Owner 2026-11-12: Free and Discord Free Pro get 1 Motion Studio try a day (one source video = one try; redo, continue
    // and collect for it are free). Paid Pro is unlimited. Shows the Upgrade popup here when the try is used.
    async allowRun(runId){
      if(typeof featureTake!=='function')return {ok:true};
      const r=await featureTake('motion',String(runId||''));
      if(!r.ok&&r.limit&&typeof upgradeNudge==='function')upgradeNudge(r.message,'motion');
      return r;
    },
    async upgrade(){if(typeof usageUpgrade==='function')await usageUpgrade();},
    async releaseIfOrphaned(){
      if(!owner)return true;
      const url=chrome.runtime.getURL('motion/index.html');
      const open=(await chrome.tabs.query({}).catch(()=>null))?.some(tab=>(tab.url||tab.pendingUrl||'').startsWith(url));
      if(open!==false)return false;
      owner=null;if(typeof log==='function')log('Motion Studio was closed; its Flow lock was released.');return true;
    },
    async pointer(tabId,x,y){if(!owner)throw Error('Motion Control has no active queue lock.');return cdpMouseClick((method,params)=>chrome.debugger.sendCommand({tabId},method,params),x,y);},
    async setLength(tabId,seconds){
      if(!owner)throw Error('Motion Control has no active queue lock.');
      if(!Number.isInteger(seconds)||seconds<3||seconds>15)throw Error('Invalid Motion duration.');
      const read=()=>exec(tabId,pg_motionLengthSlider,[]);   // isolated world, read only (owner run 2026-11-13)
      let slider=await read();
      if(!slider?.ok)throw Error('Flow’s Length control could not be read. Refresh Flow and retry. No video was submitted.');
      if(seconds<slider.min||seconds>slider.max)throw Error('This Flow model does not offer '+seconds+' seconds. Choose Omni 1.2 Flash for clips up to 15 seconds, then retry. No video was submitted.');
      if(slider.now===seconds&&slider.label===seconds)return;
      if(slider.labelOnly)throw Error('Set Flow’s visible Length to '+seconds+' Sec, then retry. No video was submitted.');
      if(slider.now!==seconds){await api.pointer(tabId,slider.left+(seconds-slider.min)/Math.max(1,slider.max-slider.min)*(slider.right-slider.left),slider.y);await new Promise(r=>setTimeout(r,200));}
      for(let step=0;step<20;step++){
        slider=await read();if(!slider?.ok||!Number.isFinite(slider.now))break;
        if(slider.now===seconds&&(slider.label==null||slider.label===seconds))return;
        const key=slider.now<seconds?'ArrowRight':'ArrowLeft',code=key==='ArrowRight'?39:37;
        for(const type of ['rawKeyDown','keyUp'])await chrome.debugger.sendCommand({tabId},'Input.dispatchKeyEvent',{type,key,code:key,windowsVirtualKeyCode:code,nativeVirtualKeyCode:code});
        await new Promise(r=>setTimeout(r,100));
      }
      throw Error('Flow did not confirm the requested '+seconds+'-second length. No video was submitted.');
    },
    // Motion Studio: Flow settings through the main engine's proven routine (Video, Ingredients, ratio, Length, x1 and the
    // model), the same one the queue uses, instead of a separate copy.
    async flowSettings(tabId,opts){
      if(!owner)throw Error('Motion Control has no active queue lock.');
      if(typeof flowSetupViaDebugger!=='function')throw Error('Reload the extension: the Flow settings routine is missing.');
      const r=await flowSetupViaDebugger(tabId,{mode:'ingredients',outputCount:1,...opts});
      if(!r?.ok){const why=String(r?.error||'Flow settings could not be set').trim();throw Error(why+(/[.!?]$/.test(why)?'':'.')+' No video was submitted.');}
      return r.settingsText||'';
    },
    // Flow's New project button is pressed with one real browser click, like the Factory (owner 2026-11-10).
    async flowClick(tabId,x,y){
      if(!owner)throw Error('Motion Control has no active queue lock.');
      if(typeof flowCdpClick!=='function')throw Error('Reload the extension: the Flow click routine is missing.');
      return flowCdpClick(tabId,x,y);
    },
    // Owner 2026-11-12 ("unusual activity" on a Motion piece): Motion's clips and pictures go into Flow like the queue's
    // photos since 11-08: real clicks on "+" and "Upload media", Chrome's own file picker answered by the debugger with
    // a short-lived copy (Downloads/0xFlow-upload-temp, removed by uploadDone). {ok:false} lets Motion use the page way.
    async uploadFile(tabId,{name,type,blob}){
      if(!owner)throw Error('Motion Control has no active queue lock.');
      if(typeof flowUploadReal!=='function'||(typeof flowMobileUa==='function'&&flowMobileUa()))return {ok:false,error:'real upload unavailable here'};
      const bytes=new Uint8Array(await blob.arrayBuffer());let bin='';
      for(let i=0;i<bytes.length;i+=32768)bin+=String.fromCharCode(...bytes.subarray(i,i+32768));
      return flowUploadReal(tabId,[{name,type:type||blob.type,base64:btoa(bin)}],6000);
    },
    async uploadDone(tabId){if(typeof flowUploadTempDone==='function')await flowUploadTempDone(tabId);},
    // Real typing where the real click put the cursor (Flow's prompt box, the library search box). clear: select-all and
    // delete first, only ever sent by Motion for the focused search box (never the prompt box with its reference chips).
    async typeText(tabId,{text,clear=false}){
      if(!owner)throw Error('Motion Control has no active queue lock.');
      const send=(method,params)=>chrome.debugger.sendCommand({tabId},method,params);
      if(clear){
        // Owner run 2026-11-12: a select-all meant for the search box reached the prompt box and removed the source-video
        // chip. Now: no Ctrl+A ever; the keys go only if the cursor is in Flow's "Search assets" box right now, and only
        // select that box's own text (Home, Shift+End). Otherwise nothing is typed and Motion clicks the box again.
        // Read in the extension's isolated world, never in Flow's own page world (owner run 2026-11-13, unusual activity).
        const inSearch=await chrome.scripting.executeScript({target:{tabId},world:'ISOLATED',func:()=>{const e=document.activeElement;return !!e&&e.tagName==='INPUT'&&/search assets/i.test((e.getAttribute('aria-label')||'')+' '+(e.placeholder||''));}}).catch(()=>null);
        if(inSearch?.[0]?.result!==true)return {typed:false};
        for(const type of ['rawKeyDown','keyUp'])await send('Input.dispatchKeyEvent',{type,key:'Home',code:'Home',windowsVirtualKeyCode:36,nativeVirtualKeyCode:36});
        for(const type of ['rawKeyDown','keyUp'])await send('Input.dispatchKeyEvent',{type,key:'End',code:'End',windowsVirtualKeyCode:35,nativeVirtualKeyCode:35,modifiers:8});
      }
      await send('Input.insertText',{text:String(text||'')});
      await new Promise(r=>setTimeout(r,250));
      return {typed:true};
    },
    // A real mouse move with no click: shows a finished Flow video without opening it.
    async hover(tabId,x,y){
      if(!owner)throw Error('Motion Control has no active queue lock.');
      if(typeof flowCdpMouseMove!=='function')throw Error('Reload the extension: the Flow hover routine is missing.');
      return flowCdpMouseMove(tabId,x,y);
    },
    // The finished Flow video, read with the main engine's download routine (extension fetch, page fallback).
    async fetchMedia(tabId,url){
      if(!owner)throw Error('Motion Control has no active queue lock.');
      if(typeof downloadMediaBuffer!=='function')throw Error('Reload the extension: the Flow download routine is missing.');
      return downloadMediaBuffer(tabId,{src:url,host:new URL(url).host},'Motion Studio');
    },
    // The finished piece through Flow's own Download menu, exactly like the queue (owner 2026-11-12: reading the video's
    // address failed live). The card is pinned by its poster, Chrome saves the file, and Flow's own reply gives the bytes.
    // download: the size to save ('360p', '720p', ...); generation: what was made (a 360p draft may be saved upscaled).
    async downloadResult(tabId,{posters=[],video=null,name,download,generation}){
      if(!owner)throw Error('Motion Control has no active queue lock.');
      if(typeof downloadVideoViaMenu!=='function'||typeof settings!=='object')throw Error('Reload the extension: the Flow download routine is missing.');
      const before={videoResolution:settings.videoResolution,videoGenerationResolution:settings.videoGenerationResolution};
      settings.videoResolution=download||generation||'default';settings.videoGenerationResolution=generation||'720p';
      try{
        const pin=posters.length?{posterSources:posters}:video?{videoSource:video}:null;
        const r=await downloadVideoViaMenu(tabId,'Motion '+name,[],stage=>{if(typeof log==='function'&&/^(clicking|Flow)/.test(stage))log('Motion '+name+': '+stage);},name+'.mp4',null,pin,true);
        if(r?.replyBytes?.byteLength)return r.replyBytes;
        if(r?.sourceUrl&&/^https:/.test(r.sourceUrl)){try{return await downloadMediaBuffer(tabId,{src:r.sourceUrl,host:new URL(r.sourceUrl).host},'Motion '+name);}catch{}}
        throw Error('Flow saved '+name+' to '+(r?.where||'Downloads')+', but Motion could not read it back to join. Press Generate again to retry; nothing is sent again.');
      }finally{Object.assign(settings,before);}
    },
    async open(){
      const url=chrome.runtime.getURL('motion/index.html');
      const existing=(await chrome.tabs.query({})).find(tab=>tab.url===url);
      if(existing){await chrome.windows.update(existing.windowId,{focused:true});await chrome.tabs.update(existing.id,{active:true});return;}
      await chrome.windows.create({url,type:'popup',width:1180,height:900,focused:true});
    }
  };
  window.OxMotion=Object.freeze(api);
  const style=document.createElement('style');style.textContent='.fb-library-tabs .fb-motion-tab{background:#203735;border-color:#5caa9d;color:#b3fff0}.fb-library-tabs .fb-motion-tab:after{content:"BETA";font-size:8px;margin-left:5px;padding:2px 4px;background:#77d9c52b;border-radius:4px;letter-spacing:.5px}';document.head.append(style);
})();
