// Original lab adapter for Muse's signed-in chat. No competitor code or private APIs.
// Message IDs and user-message boundaries bind results; retries never resend an armed job.
const MUSE_ORIGINS = ['https://muse.ai/*', 'https://*.muse.ai/*'];
const MUSE_JOB_STORE = 'oxMuseLabPendingV1';
const MUSE_MODES = ['text-to-image','image-to-image','text-to-video','frame-to-video','ingredients-to-video'];
function isMuseTab(tab) { try { const u=new URL(tab?.url||'');return u.protocol==='https:'&&(u.hostname==='muse.ai'||u.hostname.endsWith('.muse.ai')); } catch { return false; } }
async function ensureMuseAccess() { if(await chrome.permissions.contains({origins:MUSE_ORIGINS}))return true;return chrome.permissions.request({origins:MUSE_ORIGINS}); }
async function getMuseTab(slot) {
  const known=slotTabs.get(slot);if(known!=null){const t=await chrome.tabs.get(known).catch(()=>null);if(isMuseTab(t))return t;}
  const [active]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
  const tabs=isMuseTab(active)?[active]:(await chrome.tabs.query({url:MUSE_ORIGINS})).filter(isMuseTab).sort((a,b)=>(b.lastAccessed||0)-(a.lastAccessed||0));
  if(!tabs[0])throw Error('Muse setup: open your signed-in Muse chat in this Chrome profile first.');
  slotTabs.set(slot,tabs[0].id);return tabs[0];
}
// Picking Muse opens muse.ai at once, or brings an open Muse tab to the front (never reloads it: a pending request keeps its chat).
async function museOpenPage() {
  if(settings.platform!=='muse'||!await chrome.permissions.contains({origins:MUSE_ORIGINS}))return;
  const known=slotTabs.get(0),kt=known!=null?await chrome.tabs.get(known).catch(()=>null):null;
  if(kt&&(isMuseTab(kt)||isMuseTab({url:kt.pendingUrl}))){if(!kt.active)await chrome.tabs.update(kt.id,{active:true});return;}
  const tabs=(await chrome.tabs.query({url:MUSE_ORIGINS})).filter(isMuseTab).sort((a,b)=>(b.lastAccessed||0)-(a.lastAccessed||0));
  const tab=tabs[0]?await chrome.tabs.update(tabs[0].id,{active:true}):await chrome.tabs.create({url:'https://muse.ai/',active:true});
  slotTabs.set(0,tab.id);
}
function museMediaPrompt(text,mode,ratio) {
  const kind=/image/.test(mode)?'image':'video';
  const references=mode==='frame-to-video'?' Use the attached image as the starting frame.':mode==='ingredients-to-video'||mode==='image-to-image'?' Use the attached images as visual references.':'';
  return `Create exactly one ${kind}, aspect ratio ${ratio}.${references} Return the generated ${kind} as a media attachment. Do not browse, send messages to others, make purchases, or take other actions. If generation cannot be completed, explain why.\n\nCreative brief:\n${String(text||'').trim()}`;
}
// Self-contained page function. All reads/actions stay inside the known Muse chat surface.
function pg_museChat(action,options={}) {
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
  const compact=s=>String(s||'').replace(/\s+/g,' ').trim();
  const editor=[...document.querySelectorAll('textarea[aria-label="Message"],[contenteditable="true"][aria-label="Message"]')].find(visible);
  const composer=editor?.closest('[data-hatch-composer-chrome]');
  const log=document.querySelector('[role="log"][aria-label="Chat messages"]');
  const messages=log?[...log.querySelectorAll('[data-message-item][data-message-id][data-message-role]')]:[];
  const message=e=>({id:e.getAttribute('data-message-id'),role:e.getAttribute('data-message-role'),text:compact(e.innerText||e.textContent),media:[
    ...[...e.querySelectorAll('[data-hatch-video-wrapper]')].map(w=>{const v=w.querySelector('video');return {kind:'video',src:w.getAttribute('data-hatch-video-src')||v?.currentSrc||v?.src||'',ready:!!v&&v.readyState>=2};}),
    ...[...e.querySelectorAll('[data-testid="hatch-chat-attachment-presentation-image"] img')].filter(i=>!i.closest('[data-hatch-video-wrapper]')).map(i=>({kind:'image',src:i.currentSrc||i.src,ready:i.complete&&i.naturalWidth>=256&&i.naturalHeight>=256}))
  ]});
  if(action==='messages')return {ok:!!log,messages:messages.map(message)};
  if(!editor||!composer||!log)return {ok:false,error:'Muse chat controls are unavailable. Sign in and open the main Muse chat; no prompt was sent.'};
  const text=compact(editor.value??editor.textContent);
  const attachments=[...composer.querySelectorAll('img')].filter(i=>visible(i)&&i.complete&&i.naturalWidth>0);
  const busy=!!composer.querySelector('[role="progressbar"],[aria-busy="true"]');
  const send=[...composer.querySelectorAll('button')].find(b=>visible(b)&&/^send$/i.test(b.getAttribute('aria-label')||''));
  const attachmentNames=attachments.map(i=>i.getAttribute('alt')||'');
  if(action==='state')return {ok:true,text,attachments:attachments.length,attachmentNames,busy,send:!!send&&!send.disabled,messageIds:messages.map(e=>e.getAttribute('data-message-id'))};
  if(action==='attach'){
    if(text||attachments.length)return {ok:false,error:'Clear the existing Muse draft and attachments before starting.'};
    const input=composer.querySelector('input[type="file"]');if(!input)return {ok:false,error:'Muse attachment input is unavailable.'};
    const dt=new DataTransfer();
    for(const f of options.files||[]){const raw=atob(f.base64),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));dt.items.add(new File([bytes],f.name,{type:f.type}));}
    input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true};
  }
  if(action==='type'){
    if(text)return {ok:false,error:'Muse contains an unsent draft. Clear it before starting.'};
    if(editor.tagName==='TEXTAREA')Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(editor,options.prompt);
    else {editor.focus();document.execCommand('selectAll',false);document.execCommand('insertText',false,options.prompt);}
    editor.dispatchEvent(new Event('input',{bubbles:true}));return {ok:true};
  }
  if(action==='send-point'){
    if(text!==compact(options.prompt)||busy||attachments.length!==options.attachments||options.names?.some((n,i)=>attachmentNames[i]!==n)||!send||send.disabled)return {ok:false,error:'Muse prompt, references or Send button changed; not submitted.'};
    const r=send.getBoundingClientRect();return {ok:true,x:r.left+r.width/2,y:r.top+r.height/2};
  }
  return {ok:false,error:'Unknown Muse action'};
}
// Pure association logic: ignore old messages, require one exact submitted user anchor,
// and never take media after a later user message or from the wrong media type.
function museOwnedResult(messages,job) {
  const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
  let anchor=job.anchorId?messages.findIndex(m=>m.id===job.anchorId):-1;
  if(anchor<0){const matches=messages.map((m,i)=>({m,i})).filter(({m})=>m.role==='user'&&!job.baselineIds.includes(m.id)&&norm(m.text).includes(norm(job.prompt)));
    if(matches.length>1)return {error:'Multiple Muse messages match this request; queue paused, no result guessed.',pause:true};
    if(!matches.length)return {waiting:true};anchor=matches[0].i;
  }
  if(messages[anchor].role!=='user'||!norm(messages[anchor].text).includes(norm(job.prompt)))return {error:'Muse request identity changed; queue paused, no result guessed.',pause:true};
  let end=messages.findIndex((m,i)=>i>anchor&&m.role==='user');if(end<0)end=messages.length;
  const replies=messages.slice(anchor+1,end).filter(m=>m.role==='assistant'&&!job.baselineIds.includes(m.id));
  const media=replies.flatMap(m=>(m.media||[]).filter(a=>a.kind===job.kind&&a.ready&&a.src).map(a=>({...a,messageId:m.id})));
  const unique=[...new Map(media.map(m=>[m.src,m])).values()];
  if(unique.length>1)return {error:'Muse returned multiple media files; queue paused, select a result manually. No result guessed.',pause:true,anchorId:messages[anchor].id};
  if(unique.length===1)return {result:unique[0],anchorId:messages[anchor].id};
  const note=replies.map(m=>m.text).join(' ');
  if(/(?:out of|not enough|insufficient) credits|limit reached|try again tomorrow|too many requests/i.test(note))return {error:'Muse generation limit reached. Resume this existing request later.',limit:true,anchorId:messages[anchor].id};
  if(/can(?:not|'t|’t) (?:make|generate|create)|(?:unable|(?:was|were)(?:\s+not|n't|n’t) able) to (?:generate|create|make)|could(?:\s+not|n't|n’t) (?:generate|create|make)|(?:video|image|media) generation (?:failed|was unsuccessful)|not allowed|violates?.{0,20}polic/i.test(note))return {error:'Muse could not generate this request. Review its reply; it will not be resent automatically.',anchorId:messages[anchor].id};
  if(end<messages.length)return {error:'Another user message followed this request before its media was found. Queue paused; check Muse manually before resuming.',pause:true,anchorId:messages[anchor].id};
  return {waiting:true,anchorId:messages[anchor].id};
}
async function museJobFingerprint(item,mode,references) {
  const raw=JSON.stringify([item.builderProjectId||item.manualProjectId||'manual',item.index,mode,item.text,references.map(r=>[r.name,r.dataUrl])]);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function museJournal(id,value) { const all=(await chrome.storage.local.get(MUSE_JOB_STORE))[MUSE_JOB_STORE]||{};if(value===null)delete all[id];else {if(!all[id]&&Object.keys(all).length>=50)throw Error('Muse has 50 pending requests. Resolve them before submitting more.');all[id]=value;}await chrome.storage.local.set({[MUSE_JOB_STORE]:all}); }
async function runMusePrompt(item,slot,token) {
  item.platform='muse';item.status='running';item.retryAt=null;item.attempts=(item.attempts||0)+1;renderQueue();
  let job,id,pauseMessage='';
  try {
    assertRunActive(token);
    if(!MUSE_MODES.includes(settings.mode))throw Error('Muse setup: this mode is not supported by Muse yet.');
    if(!await chrome.permissions.contains({origins:MUSE_ORIGINS}))throw Error('Muse setup: select Muse and allow site access before starting.');
    const tab=await getMuseTab(slot),kind=MODES[settings.mode].resultKind;
    const references=MODES[settings.mode].needsImages?imagesForItem(item):[];
    if(MODES[settings.mode].needsImages&&!references.length)throw Error('Muse setup: assign a reference image first.');
    if(references.length>(settings.mode==='frame-to-video'?1:3)||references.some(r=>!/^image\//.test(r.type||r.dataUrl?.match(/^data:([^;]+)/)?.[1]||'')||Number(r.size||0)>10*1024*1024))throw Error('Muse supports one start frame or up to three reference images, each under 10 MB.');
    id=await museJobFingerprint(item,settings.mode,references);
    job=(await chrome.storage.local.get(MUSE_JOB_STORE))[MUSE_JOB_STORE]?.[id]||null;
    const path=new URL(tab.url);const location=path.origin+path.pathname;
    if(job&&job.location!==location)throw Error('Return to the Muse conversation used by this pending request; it will not be resubmitted.');
    if(!job){
      let owns=false;const target={tabId:tab.id};
      try {
        try{await chrome.debugger.attach(target,'1.3');owns=true;}catch(e){if(!/another debugger|already attached/i.test(String(e?.message||e)))throw e;}
        await sleep(400);assertRunActive(token);
        const before=await exec(tab.id,pg_museChat,['state'],'MAIN');
        if(!before?.ok)throw Error(before?.error||'Muse chat is not ready.');
        if(before.text||before.attachments||before.busy)throw Error('Clear the existing Muse draft and wait for uploads before starting.');
        if(references.length){const files=references.map(r=>{const v=dataUrlToB64(r.dataUrl);return {name:r.name,base64:v.b64,type:v.type};});const a=await exec(tab.id,pg_museChat,['attach',{files}],'MAIN');if(!a?.ok)throw Error(a?.error||'Muse could not accept the images.');
          let stable=0;const start=Date.now();while(Date.now()-start<120000){assertRunActive(token);const s=await exec(tab.id,pg_museChat,['state'],'MAIN');if(s?.attachments===references.length&&!s.busy){stable=stable||Date.now();if(Date.now()-stable>=1500)break;}else stable=0;await sleep(500);}
          const s=await exec(tab.id,pg_museChat,['state'],'MAIN');if(s?.attachments!==references.length||s.busy||!stable||Date.now()-stable<1500)throw Error('Muse reference upload was not confirmed; no prompt submitted.');
        }
        const ratio=({portrait:'9:16',landscape:'16:9',square:'1:1'})[settings.aspectRatio]||'9:16';
        const prompt=museMediaPrompt(item.generationText||item.text,settings.mode,ratio);
        const typed=await exec(tab.id,pg_museChat,['type',{prompt}],'MAIN');if(!typed?.ok)throw Error(typed?.error||'Muse prompt entry failed.');
        await sleep(500);assertRunActive(token);
        const point=await exec(tab.id,pg_museChat,['send-point',{prompt,attachments:references.length,names:references.map(r=>r.name)}],'MAIN');if(!point?.ok)throw Error(point?.error||'Muse Send is not ready.');
        // Persist BEFORE the click. If acceptance is uncertain, Retry only observes
        // this request; it never spends generation credits by sending it again.
        job={location,tabId:tab.id,prompt,kind,baselineIds:before.messageIds,armedAt:Date.now()};await museJournal(id,job);assertRunActive(token);
        await flowCdpClick(tab.id,point.x,point.y,true);log(`${item.id}: Muse media request sent; waiting for its own message and result.`);
      }finally{if(owns)await chrome.debugger.detach(target).catch(()=>{});}
    }else log(`${item.id}: resuming the existing Muse request; prompt will not be sent again.`);
    const started=Date.now();let stableKey='',stableAt=0,result;
    while(Date.now()-started<settings.maxWaitMinutes*60000){
      assertRunActive(token);const current=await chrome.tabs.get(tab.id);if(!isMuseTab(current)||new URL(current.url).origin+new URL(current.url).pathname!==job.location)throw Error('The Muse task tab changed; return to the original conversation and Retry.');
      const state=await exec(tab.id,pg_museChat,['messages'],'MAIN');if(!state?.ok)throw Error('Muse chat history is unavailable. The request is retained for Retry.');
      const own=museOwnedResult(state.messages,job);
      if(own.anchorId&&own.anchorId!==job.anchorId){job.anchorId=own.anchorId;await museJournal(id,job);}
      if(own.error){if(own.limit||own.pause){stopRequested=true;queueStopReason=own.limit?'Muse generation limit reached':'Muse conversation changed';pauseMessage=own.error;}throw Error(own.error);}
      if(own.result){const key=own.result.messageId+'|'+own.result.src;if(key!==stableKey){stableKey=key;stableAt=Date.now();}if(Date.now()-stableAt>=1500){result=own.result;break;}}
      else {stableKey='';stableAt=0;}
      item.detail=job.anchorId?'Muse is generating this request…':'Waiting for Muse to confirm this request; it will not be resent.';renderQueue();await sleep(2000);
    }
    if(!result)throw Error('Muse result not confirmed in time. Request retained; Retry waits again without resubmitting.');
    item.museResult={messageId:result.messageId,kind:job.kind};
    if(autoDownloadOff(job.kind,item)){item.detail='generated in Muse; automatic download is off';}
    else {
      const src=result.src;if(!/^https:\/\/|^blob:https:\/\/muse\.ai\//i.test(src))throw Error('Muse result URL is unsupported; download it manually from its confirmed message.');
      item.detail='downloading the confirmed Muse result';renderQueue();
      const bytes=await downloadMediaBuffer(tab.id,{src,host:'Muse'},item.id);assertRunActive(token);
      const ext=job.kind==='video'?'mp4':guessImageExt(bytes,src);
      if(job.kind==='video'?!P().bufferHasMp4Signature(bytes):!P().bufferHasImageSignature(bytes))throw Error('Muse download returned invalid media bytes; its generation is retained.');
      const saved=await saveOutput(item,bytes,ext);item.outputName=saved.name;item.detail=`saved ${saved.name} → ${saved.where}`;
    }
    await museJournal(id,null);item.status='done';item.progressPercent=100;log(`${item.id}: done - ${item.detail}`);
  }catch(e){
    const cancelled=stopRequested||token!==runToken;
    item.status=cancelled?'pending':'error';item.retryAt=null;item.detail=pauseMessage||(cancelled?'Paused; existing Muse request will be resumed.':String(e?.message||e));
    log(`${item.id}: Muse ${item.detail}`);
  }finally{renderQueue();schedulePersist();}
}
