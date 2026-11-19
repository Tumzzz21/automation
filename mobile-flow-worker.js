// Experimental mobile Flow runner. The worker owns all queue work; the panel is a view.
// Persist before every irreversible action. A lost submit acknowledgement is never retried.
const MOBILE_FLOW_KEY = 'mobileFlowWorkerV1';
const MOBILE_FLOW_ALARM = 'mobile-flow-worker';
let mobileJob = null, mobileDrive = null, mobileStarting = false, mobileWrite = Promise.resolve();
let settings = {}, queue = [], runToken = '', stopRequested = false, queueStopReason = '';
const outputDir = null, loggedFlowPreferences = new Set(), flowDownloadUnsafeTabs = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const downloadFolder = () => settings.downloadSubfolder || 'Flow Automation';
const outputFileName = (_item, _ext, name) => name;
async function downloadMediaBuffer(...args) {return downloadMediaBufferUnlocked(...args);}
const assertRunActive = token => { if (stopRequested || token !== runToken) throw Error('Mobile queue stopped'); };
// Quetta 1.8.2 tabs.get(id) returned the active tab for every requested ID.
// query() retains the correct IDs; never trust a mismatched single-tab reply.
async function mobileTab(tabId) {
  const tab=(await chrome.tabs.query({})).find(t=>t.id===tabId);
  if(!tab)throw Error('Original Flow tab was closed');
  return tab;
}
async function mobileWaitForTabComplete(tabId, timeoutMs = 60000) {
  const token=runToken, until=Date.now()+timeoutMs;
  // Mobile browsers can omit onUpdated after switching accounts. Poll the exact
  // tab via query(), which also avoids Quetta's incorrect tabs.get() replies.
  while(true) {
    assertRunActive(token);
    const tab=await mobileTab(tabId);
    assertRunActive(token);
    if(tab.status==='complete')return;
    if(Date.now()>=until)throw Error(`Flow tab did not finish loading within ${Math.round(timeoutMs/1000)} seconds`);
    await sleep(500);
  }
}
async function exec(tabId, func, args=[], world) {
  assertRunActive(runToken);
  if(tabId!==mobileJob.tabId)throw Error('Worker tab ownership mismatch');
  await mobileOwnedPage();
  const [result]=await chrome.scripting.executeScript({target:{tabId},func,args,world:world||'MAIN'});
  if(result?.error)throw Error(String(result.error));
  return result?.result;
}

function mobilePersist() {
  const value = structuredClone(mobileJob);
  mobileWrite = mobileWrite.catch(() => {}).then(() => chrome.storage.local.set({[MOBILE_FLOW_KEY]:value}));
  return mobileWrite;
}
function log(text) {
  if (!mobileJob) return;
  mobileJob.logs.push({at:Date.now(),text:String(text)});
  mobileJob.logs = mobileJob.logs.slice(-150);
  void mobilePersist();
}
async function mobilePhase(item, phase) {
  item.phase = phase; item.updatedAt = Date.now();
  log(`${item.id}: ${phase}`);
  await mobilePersist();
}
function mobileValidateInput(input) {
  if (!input || !Number.isInteger(input.tabId) || !/^https:\/\/flow\.google\.com\/(?:u\/\d+\/)?project\//.test(input.projectUrl||'')) throw Error('Choose an open Flow project');
  if (!['frame-to-video','text-to-video'].includes(input.settings?.mode)) throw Error('Worker pilot supports Frame to Video and Text to Video');
  if (Number(input.settings.flowOutputCount)!==1 || input.settings.chainLastFrame || input.settings.manualSheets) throw Error('Worker pilot requires x1 with chaining and storyboard sheets off');
  if (!Array.isArray(input.items) || !input.items.length || input.items.length>30) throw Error('Use 1–30 prompts');
  for (const item of input.items) {
    if (!item.id || typeof item.text!=='string' || !item.text.trim() || item.text.length>40000 || !/^[^/\\\x00-\x1f]+\.mp4$/.test(item.filename||'')) throw Error('Invalid prompt or output name');
    if (item.builderProjectId || item.manualProjectId) throw Error('Worker pilot uses manual Control queues; project/workspace integration is not enabled yet');
    if (input.settings.mode==='frame-to-video' && (!item.image?.name || !/^data:image\/(?:png|jpeg|webp);base64,/.test(item.image.dataUrl||'') || item.image.dataUrl.length>24*1024*1024)) throw Error('Each frame prompt needs one PNG/JPEG/WebP start image');
  }
  if (new Set(input.items.map(i=>i.id)).size!==input.items.length) throw Error('Duplicate prompt IDs');
  const folder=String(input.settings.downloadSubfolder||'Flow Automation');
  if (/^[\/\\]|\.\.|[\x00-\x1f:]/.test(folder)) throw Error('Invalid download folder');
}
async function mobileOwnedPage() {
  assertRunActive(runToken);
  const tab = await mobileTab(mobileJob.tabId);
  const url=String(tab.url||'').split(/[?#]/)[0];
  // A media detail route is still inside this exact project; never accept another project.
  if (url!==mobileJob.projectUrl&&!url.startsWith(mobileJob.projectUrl+'/edit/')) throw Error('Original Flow project changed; queue paused');
  return tab;
}
async function mobileUsage(saved=false) {
  const config=await chrome.storage.local.get(['remoteRepairUrl','remoteRepairToken']);
  if (!config.remoteRepairUrl || !config.remoteRepairToken) return;
  try {
    const response=await remoteRepairRequest(config,'/usage/generations',saved?{count:1,source:'queue',platform:'flow'}:undefined);
    const body=response.body;
    if (!saved && response.status===200 && !body?.unlimited && (body?.remaining===0 || (Number.isFinite(body?.used)&&Number.isFinite(body?.limit)&&body.used>=body.limit))) throw Object.assign(Error('Free daily generation limit reached'),{quota:true});
    if (!saved && [401,403,429].includes(response.status)) throw Object.assign(Error('Account/usage check denied; reopen the panel'),{quota:true});
  } catch(error) { if(error.quota) throw error; log('Usage counter unavailable; same offline allowance as the standard queue.'); }
}
function pg_mobileFlowCreditRejection(trackingKey = null, promptText = '') {
  const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
  // An account warning can arrive before Flow mounts/claims the new result tile.
  const accountWarning=[...document.querySelectorAll('flow-video-tile,flow-grid-tile-container,[role="alert"]')].filter(visible).some(e=>/\bfailed\b[\s\S]{0,100}we noticed (?:some )?unusual activity/i.test(e.innerText||''));
  if(accountWarning)return {rejected:false,blocked:true};
  if(!trackingKey) {
    const blockedGenerate=[...document.querySelectorAll('flow-prompt-warning-button button[aria-label="Insufficient credits warning"]')].some(visible);
    if(blockedGenerate)return {rejected:true,blocked:false};
  }
  let texts=[];
  if(trackingKey) {
    const tracker=window.__flowStudioResultTrackers?.[trackingKey]||window.__flowStudioResultTracker;
    if(tracker?.key!==trackingKey||tracker.error)return {rejected:false};
    const tile=tracker.tile;
    if(!tile?.isConnected)return {rejected:false};
    if(tile.querySelector('video,flow-pending-tile')||tile.querySelector('img[alt="Generated video thumbnail"]')||/\b\d{1,3}\s*%/.test(tile.innerText||''))return {rejected:false};
    const clone=tile.cloneNode(true);for(const label of clone.querySelectorAll('.footer-title'))label.remove();
    let text=clone.textContent||'';
    const prompt=String(promptText).toLowerCase().replace(/\s+/g,' ').trim();
    text=text.toLowerCase().replace(/\s+/g,' ');
    if(prompt.length>=20){text=text.split(prompt).join(' ');const head=prompt.slice(0,80);let at=text.indexOf(head);if(at>=0)text=text.slice(0,at)+' '+text.slice(at+prompt.length);}
    // Credit words in a prompt title are not a failed generation.
    if(!/\bfailed\b|\bfailure\b|\berror\b|you have not been charged/.test(text))return {rejected:false};
    texts=[text];
  } else texts=[...document.querySelectorAll('[role="alert"],[role="dialog"]')].filter(visible).map(e=>e.innerText||'');
  const text=texts.join(' ').toLowerCase().replace(/\s+/g,' ');
  const blocked=/unusual activity|suspicious|captcha|daily limit|usage limit|rate limit/.test(text);
  return {blocked,rejected:!blocked&&/not enough (?:ai |flow )?credits|insufficient (?:ai |flow )?credits|out of (?:ai |flow )?credits|(?:you have|you've) (?:run out of|used all (?:of )?your) (?:ai |flow )?credits/.test(text)};
}
async function mobileSwitchPolicy() {
  const config=await chrome.storage.local.get(['manualAccountSwitch','remoteRepairUrl','remoteRepairToken']);
  const selected=config.manualAccountSwitch;
  if(!selected?.on)return null;
  if(!selected.confirmedPaid)throw Error('Account switching needs confirmation that each selected Flow account has its own paid plan.');
  if(!config.remoteRepairUrl||!config.remoteRepairToken)throw Error('Connect your Pro account before switching Flow accounts.');
  const r=await remoteRepairRequest(config,'/usage/generations');
  if(r.status!==200||!['pro','community'].includes(r.body?.plan))throw Error('Account switching requires a verified Pro or Discord Pro plan.');
  const max=r.body.plan==='pro'?10:2;   // paid Pro 10 accounts, Discord Pro 2 (owner 2026-11-13)
  const accounts=[...new Set(selected.accounts||[])].filter(n=>Number.isInteger(n)&&n>=0&&n<max).slice(0,max);
  if(accounts.length<2)throw Error('Select at least two eligible Flow accounts for switching.');
  return accounts;
}
const mobileAccountOf=url=>Number(String(url).match(/^https:\/\/flow\.google\.com\/u\/(\d+)(?:\/|$)/)?.[1]||0);
async function mobileFinishAccountSwitch() {
  const change=mobileJob.accountSwitch;if(!change)return;
  const accounts=await mobileSwitchPolicy();
  if(!accounts?.includes(change.next))throw Error('Account switch setting changed; remaining scenes are preserved.');
  while(Date.now()<change.notBefore){assertRunActive(runToken);await sleep(Math.min(1000,change.notBefore-Date.now()));}
  assertRunActive(runToken);
  if(!(await mobileSwitchPolicy())?.includes(change.next))throw Error('Account switch was disabled or the selected account changed.');
  if(change.tabId==null) {
    // If acknowledgement is lost after this boundary, do not create another tab.
    change.creating=true;await mobilePersist();
    const tab=await chrome.tabs.create({url:'https://flow.google.com/u/'+change.next+'/',active:true});
    change.tabId=tab.id;change.creating=false;await mobilePersist();
  }
  const ready=await mobileStoryReadyTab(change.tabId,runToken);assertRunActive(runToken);
  if(mobileAccountOf(ready.url)!==change.next)throw Error('Selected Flow account did not open; sign in there before Resume.');
  mobileJob.accountHistory=mobileJob.accountHistory||[];
  mobileJob.accountHistory.push({account:change.from,projectUrl:mobileJob.projectUrl,tabId:mobileJob.tabId});
  mobileJob.tabId=ready.id;mobileJob.projectUrl=ready.url.split(/[?#]/)[0];
  const item=mobileJob.items.find(i=>i.phase!=='done');
  if(item){
    item.creditRejections=(item.creditRejections||0)+(change.rejected?1:0);
    for(const k of ['submittedAt','resultIdentity','resultSource','frameIdentity','downloadStartedAt','downloadId','downloadSource'])delete item[k];
    item.trackingKey=`mobile:${mobileJob.id}:${item.id}:account${change.next}`;item.phase='pending';
  }
  mobileJob.usedSwitchAccounts=[...new Set([...(mobileJob.usedSwitchAccounts||[]),change.from])];
  mobileJob.accountSwitch=null;await mobilePersist();log('Flow account '+(change.next+1)+' is ready; continuing unfinished scenes.');
}
async function mobileRequestAccountSwitch(item, rejected = true) {
  if(!rejected||!item||['ready','downloading','workspace','done'].includes(item.phase))return false;
  const accounts=await mobileSwitchPolicy();if(!accounts)return false;
  const current=mobileAccountOf(mobileJob.projectUrl),index=accounts.indexOf(current);
  if(index<0)throw Error('Current Flow account is not selected; choose the intended account before Resume.');
  const next=accounts.slice(index+1).find(n=>!(mobileJob.usedSwitchAccounts||[]).includes(n));
  if(next===undefined)throw Error('Flow credits ran out on all remaining selected accounts. Saved scenes are preserved.');
  mobileJob.accountSwitch={from:current,next,rejected,notBefore:Date.now()+30000,tabId:null};await mobilePersist();
  log('Flow confirmed insufficient credits. Switching to selected account '+(next+1)+' after 30 seconds.');
  await mobileFinishAccountSwitch();return true;
}
function pg_mobileFlowCreateProject() {
  const button=[...document.querySelectorAll('button,[role="button"]')].find(e=>{
    const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&!e.disabled&&/new project/i.test(`${e.innerText||''} ${e.getAttribute('aria-label')||''}`);
  });
  if(!button)return {clicked:false};
  button.click();return {clicked:true};
}
// Bootstrap belongs to the worker: activating Flow hides/freezes phone panels.
async function mobileStoryReadyTab(tabId, token = null) {
  let tab=await mobileTab(tabId);
  const initial=[tab.url,tab.pendingUrl].find(url=>/^https:\/\/flow\.google\.com(?:\/|$)/i.test(url||''));
  let root=String(initial||'').match(/^https:\/\/flow\.google\.com\/(?:u\/\d+\/)?/i)?.[0];
  if(!root)throw Error('Open Google Flow and sign in, then press Auto again.');
  await chrome.tabs.update(tabId,{active:true});
  let requested=false;
  for(let attempt=0;attempt<45;attempt++) {
    if(token)assertRunActive(token);
    tab=await mobileTab(tabId);
    const url=String(tab.url||tab.pendingUrl||'');
    if(tab.status!=='complete'&&String(tab.pendingUrl||'').startsWith(root)){await sleep(1000);continue;}
    // A fresh generic Flow home may resolve to its signed-in default /u/N/ route.
    if(root==='https://flow.google.com/')root=url.match(/^https:\/\/flow\.google\.com\/u\/\d+\//)?.[0]||root;
    if(!url.startsWith(root))throw Error('Flow account or page changed. Sign in on the intended Flow tab, then press Auto again.');
    const projectRoot=url.match(/^https:\/\/flow\.google\.com\/(?:u\/\d+\/)?project\/[^/?#]+/i)?.[0];
    if(projectRoot)return {...tab,url:projectRoot};
    if(!/^$|^[?#]/.test(url.slice(root.length)))throw Error('Open the Flow home page or a Flow project, then press Auto again.');
    if(!requested&&tab.status==='complete') {
      const [result]=await chrome.scripting.executeScript({target:{tabId},func:pg_mobileFlowCreateProject,world:'MAIN'});
      requested=!!result?.result?.clicked;
    }
    await sleep(1000);
  }
  throw Error('Flow is open. Finish signing in or open a project there, then return and press Auto again. No generation was submitted.');
}
function pg_mobileFlowProjectReturnPoint() {
  const buttons=[...document.querySelectorAll('button,[role="button"]')].map(e=>({e,r:e.getBoundingClientRect(),label:String(e.innerText||'').trim().toLowerCase(),aria:String(e.getAttribute('aria-label')||'').trim().toLowerCase()})).filter(x=>x.r.width>0&&x.r.width<110&&x.r.height>0&&x.r.height<80&&x.r.top>=0&&x.r.top<100&&!x.e.disabled&&(/^(?:back|go back|arrow_back|done|check)$/.test(x.label)||/^(?:back button to go to previous page|done editing)$/.test(x.aria)));
  buttons.sort((a,b)=>(/back/.test(b.label)?1:0)-(/back/.test(a.label)?1:0));
  const x=buttons[0];return x?{x:x.r.left+x.r.width/2,y:x.r.top+x.r.height/2}:null;
}
async function mobileReturnProject() {
  const tab=await mobileOwnedPage();if(!String(tab.url).split(/[?#]/)[0].startsWith(mobileJob.projectUrl+'/edit/'))return;
  const target={tabId:tab.id};let attached=false;
  try {
    await chrome.debugger.attach(target,'1.3');attached=true;await sleep(400);
    const point=await exec(tab.id,pg_mobileFlowProjectReturnPoint,[],'MAIN');
    if(!point)throw Error('Mobile media-detail Back/Done control not found');
    await flowCdpClick(tab.id,point.x,point.y,true);
    const until=Date.now()+10000;
    while(Date.now()<until){assertRunActive(runToken);const current=await mobileTab(tab.id);if(String(current.url).split(/[?#]/)[0]===mobileJob.projectUrl)return;await sleep(500);}
    throw Error('Media detail did not return to the original project');
  } finally {if(attached)await chrome.debugger.detach(target).catch(()=>{});}
}
function pg_mobileFlowDismissKeyboard() {
  const active=document.activeElement;
  if(active?.matches?.('textarea,input,[contenteditable="true"],[role="textbox"]'))active.blur();
  return {height:innerHeight,visualHeight:window.visualViewport?.height||innerHeight};
}
function pg_mobileFlowSubmitHit(point) {
  const hit=document.elementFromPoint(point.x,point.y)?.closest('button,[role="button"]');
  const label=hit?`${hit.innerText||''} ${hit.getAttribute('aria-label')||''}`:'';
  return {ok:!!hit&&!hit.disabled&&hit.getAttribute('aria-disabled')!=='true'&&/start generation|arrow_forward|\bgenerate\b|\bsend\b/i.test(label)};
}
function pg_mobileStoryReferences(names) {
  const key=img=>img.getAttribute('data-media-id')||String(img.currentSrc||img.src||'').match(/\/image\/([a-z0-9-]+)/i)?.[1]||String(img.currentSrc||img.src||'').split('?')[0].replace(/=s\d+[^/]*$/i,'');
  const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
  const pictures=[...document.querySelectorAll('img[alt="Ingredient image"]')].filter(visible),keys=pictures.map(key);
  const found=[];
  for(const name of names){const wanted=name.toLowerCase(),tiles=[...document.querySelectorAll('flow-grid-tile-container')].filter(t=>[t,...t.querySelectorAll('.footer-title,[data-filename],[title],[aria-label],button')].some(e=>[e.textContent,e.getAttribute('data-filename'),e.getAttribute('title'),e.getAttribute('aria-label')].some(v=>String(v||'').trim().toLowerCase()===wanted)));const matches=tiles.filter(t=>[...t.querySelectorAll('img')].some(img=>img.complete&&keys.includes(key(img))));if(matches.length===1)found.push(name);}
  return {count:pictures.length,names:found,exact:pictures.length===names.length&&found.length===names.length};
}
async function mobileStoryAttach(names) {
  let state=await exec(mobileJob.tabId,pg_mobileStoryReferences,[names],'MAIN');
  if(state.exact)return;
  if(state.count)await flowClearComposerIngredients(mobileJob.tabId,runToken);
  const target={tabId:mobileJob.tabId};let attached=false;
  try {
    await chrome.debugger.attach(target,'1.3');attached=true;
    await exec(mobileJob.tabId,pg_mobileFlowDismissKeyboard,[],'MAIN');
    await cdpEscape((method,params)=>chrome.debugger.sendCommand(target,method,params));await sleep(600);
    for(const name of names){
      await mobilePace('attach');
      const menu=await exec(mobileJob.tabId,pg_flowAssetMenuState,[],'MAIN');
      if(!menu.plus)throw Error('Mobile reference + button not found');
      await flowCdpClick(mobileJob.tabId,menu.plus.x,menu.plus.y,true);await sleep(600);
      const deadline=Date.now()+25000;let searched=false;
      while(Date.now()<deadline){
        assertRunActive(runToken);
        state=await exec(mobileJob.tabId,pg_mobileStoryReferences,[names.slice(0,names.indexOf(name)+1)],'MAIN');
        if(state.exact)break;
        if(!searched){searched=!!(await exec(mobileJob.tabId,pg_flowSearchStartFrame,[name],'MAIN'))?.ok;await sleep(500);continue;}
        const point=await exec(mobileJob.tabId,pg_flowFramePickerPoint,[name],'MAIN');
        if(point?.action==='select'||point?.action==='add')await flowCdpClick(mobileJob.tabId,point.x,point.y,true);
        await sleep(500);
      }
      if(!state?.exact)throw Error('Mobile reference could not be confirmed: '+name);
    }
  } finally {if(attached){await cdpEscape((method,params)=>chrome.debugger.sendCommand(target,method,params)).catch(()=>{});await chrome.debugger.detach(target).catch(()=>{});}}
}
// Flow's mobile picker creates a detached file input only when Upload is clicked.
// Supply the selected local bytes synchronously, without opening an OS chooser.
function pg_mobileFlowPickerUpload(file) {
  const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
  const button=[...document.querySelectorAll('button[aria-label="Upload media"]')].find(visible);
  if(!button)return {ok:false,error:'Mobile frame picker upload button is unavailable'};
  const comma=file.dataUrl.indexOf(','),raw=atob(file.dataUrl.slice(comma+1)),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
  const dt=new DataTransfer();dt.items.add(new File([bytes],file.name,{type:file.dataUrl.slice(5,comma).split(';')[0]}));
  const original=HTMLInputElement.prototype.click;let handled=false;
  try {
    HTMLInputElement.prototype.click=function(){
      if(this.type==='file'){
        if(handled)throw Error('Multiple upload inputs requested');
        handled=true;this.files=dt.files;
        window.__flowAttach={state:'working',want:1,names:[file.name],start:Date.now(),stableSince:0,settleMs:1000,method:'mobile-start-picker',error:null};
        this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return;
      }
      return original.call(this);
    };
    button.click();
  } finally {HTMLInputElement.prototype.click=original;}
  return {ok:handled,error:handled?null:'Picker did not request an upload input'};
}
async function mobileFramePickerUpload(image) {
  const target={tabId:mobileJob.tabId};let attached=false;
  try {
    await chrome.debugger.attach(target,'1.3');attached=true;
    await cdpEscape((method,params)=>chrome.debugger.sendCommand(target,method,params));await sleep(300);
    const state=await exec(mobileJob.tabId,pg_flowFrameState,[image.name],'MAIN');
    if(state?.startFilled&&!state?.matched) {
      const clear=await exec(mobileJob.tabId,pg_flowClearIngredientDraft,[],'MAIN');
      if(!clear)throw Error('Could not clear the previous Start image before upload');
      await flowCdpClick(mobileJob.tabId,clear.x,clear.y,true);await sleep(500);
    }
    const point=await exec(mobileJob.tabId,pg_flowOpenStartFrame,[],'MAIN');
    if(!point?.ok)throw Error(point?.error||'Mobile Start picker unavailable');
    if(point.x!=null)await flowCdpClick(mobileJob.tabId,point.x,point.y,true);
    await sleep(500);assertRunActive(runToken);
    const result=await exec(mobileJob.tabId,pg_mobileFlowPickerUpload,[image],'MAIN');
    if(!result?.ok)throw Error(result?.error||'Mobile picker upload failed');
    log('Mobile Start picker accepted '+image.name+'; verifying the ready project asset.');
  } finally {if(attached)await chrome.debugger.detach(target).catch(()=>{});}
}
async function mobilePrepare(item) {
  await mobileOwnedPage();
  if(item.projectId&&mobileStoryVersion(await mobileProject(item.projectId),item)!==item.sourceVersion)throw Error('Story changed before generation; paused without submitting');
  await chrome.tabs.update(mobileJob.tabId,{active:true});
  await mobileWaitForTabComplete(mobileJob.tabId,60000);
  await mobileReturnProject();
  const composer=await exec(mobileJob.tabId,pg_flowReturnToProjectComposer,[],'MAIN');
  if(!composer?.ok)throw Error('Return to the original project composer before continuing');
  await mobileUsage();
  await mobilePhase(item,'setup');
  const mode=item.mode||settings.mode,isImage=item.kind==='image';
  const setup=await flowSetupViaDebugger(mobileJob.tabId,{mode:isImage?'image':mode==='frame-to-video'?'frames':'video',aspectRatio:item.aspectRatio||settings.aspectRatio||'portrait',durationSeconds:item.duration||settings.flowDurationSeconds||8,outputCount:1,model:isImage?(settings.flowImageModel||''):settings.flowModel,videoResolution:settings.videoGenerationResolution});
  if (!setup?.ok) throw Error(setup?.error||'Flow setup failed');
  const credit=await exec(mobileJob.tabId,pg_mobileFlowCreditRejection,[],'MAIN');
  if(credit?.blocked)throw Error('Flow reported unusual activity or a usage limit. No account switch or retry.');
  if(credit?.rejected)throw Object.assign(Error('Flow confirmed insufficient credits before submission'),{flowCredits:true});
  await exec(mobileJob.tabId,pg_mobileFlowDismissKeyboard,[],'MAIN');await sleep(500);
  const referenceImages=item.image?[item.image]:(item.images||[]);
  for(const image of referenceImages) {
    const name=image.name;
    const existing=await exec(mobileJob.tabId,pg_flowExistingImages,[[name]],'MAIN');
    if (!existing?.names?.includes(name.toLowerCase())) {
      await mobilePhase(item,'upload');
      const data=image.dataUrl,comma=data.indexOf(',');
      let upload;
      if(!isImage&&item.image) {
        // Use one upload route, never both drop/paste and picker for the same file.
        // The ordinary composer's + menu is absent in the phone frame layout.
        await mobileFramePickerUpload(image);
        upload={state:'working'};
      } else upload=await exec(mobileJob.tabId,pg_flowAttachStart,[[{name,type:data.slice(5,comma).split(';')[0],base64:data.slice(comma+1)}],1000,FLOW_SELECTORS],'MAIN');
      const deadline=Date.now()+120000;
      while (upload?.state!=='done' && Date.now()<deadline) {
        assertRunActive(runToken); await sleep(1000);
        await mobileReturnProject();
        await exec(mobileJob.tabId,pg_flowReturnToProjectComposer,[],'MAIN');
        const ready=await exec(mobileJob.tabId,pg_flowExistingImages,[[name]],'MAIN');
        if (ready?.names?.includes(name.toLowerCase())) break;
        upload=await exec(mobileJob.tabId,pg_flowAttachPoll,[ready],'MAIN');
        if(upload?.state==='error') throw Error(upload.error||'Frame upload failed');
      }
      const uploaded=await exec(mobileJob.tabId,pg_flowExistingImages,[[name]],'MAIN');
      if(!uploaded?.names?.includes(name.toLowerCase()))throw Error('Start image upload did not become a ready project asset');
    }
  }
  await exec(mobileJob.tabId,pg_flowReturnToProjectComposer,[],'MAIN');
  if(isImage){
    const names=referenceImages.map(i=>i.name),current=await exec(mobileJob.tabId,pg_mobileStoryReferences,[names],'MAIN');
    if(!current.exact)await mobileStoryAttach(names);
    if(!(await exec(mobileJob.tabId,pg_mobileStoryReferences,[names],'MAIN'))?.exact)throw Error('Story image references could not be verified; no generation submitted');
  }else if (item.image) {
    await mobilePhase(item,'frame');
    item.frameIdentity=await ensureFlowStartFrame(mobileJob.tabId,item.image.name,runToken);
  }
  await mobilePhase(item,'prompt');
  await mobilePace('prompt');
  const inserted=await flowInsertPrompt(mobileJob.tabId,item.text);
  if (!inserted?.ok) throw Error(inserted?.error||'Prompt insertion failed');
  if (item.image && !(await exec(mobileJob.tabId,pg_flowFrameState,[item.image.name,item.frameIdentity],'MAIN'))?.ready) throw Error('Start frame changed; no video submitted');
  const tracking=await exec(mobileJob.tabId,pg_flowStartResultTracking,[item.trackingKey,1,isImage?'image':'video',false,item.text.slice(0,200)],'MAIN');
  if (!tracking?.ok) throw Error(tracking?.error||'Could not track this submission');
  const target={tabId:mobileJob.tabId};let attached=false;
  try {
    await chrome.debugger.attach(target,'1.3');attached=true;
    await exec(mobileJob.tabId,pg_mobileFlowDismissKeyboard,[],'MAIN');
    await cdpEscape((method,params)=>chrome.debugger.sendCommand(target,method,params));
    let point=null,previous=null;const deadline=Date.now()+30000;
    while(Date.now()<deadline) {
      assertRunActive(runToken);await sleep(500);
      const next=await exec(mobileJob.tabId,pg_flowGeneratePoint,[],'MAIN');
      const hit=next?.ok&&!next.disabled?await exec(mobileJob.tabId,pg_mobileFlowSubmitHit,[next],'MAIN'):null;
      if(hit?.ok&&previous&&Math.abs(previous.x-next.x)<1&&Math.abs(previous.y-next.y)<1){point=next;break;}
      previous=hit?.ok?next:null;
    }
    if (!point) throw Error('Flow Generate button is unavailable; nothing submitted');
    await mobilePace('generate');
    await mobileOwnedPage();
    // The persisted boundary deliberately precedes the click. Recovery may inspect, never re-click.
    item.submittedAt=Date.now();await mobilePhase(item,'submitting');
    assertRunActive(runToken);
    await flowCdpClick(mobileJob.tabId,point.x,point.y,true);
    await mobilePhase(item,'rendering');
  } finally {if(attached)await chrome.debugger.detach(target).catch(()=>{});}
}
async function mobilePoll(item) {
  await mobileOwnedPage();
  const result=await exec(mobileJob.tabId,pg_flowTrackedResult,[item.trackingKey],'MAIN');
  if(!result?.ready){const credit=await exec(mobileJob.tabId,pg_mobileFlowCreditRejection,[item.trackingKey,item.text],'MAIN');if(credit?.blocked)throw Error('Flow reported unusual activity or a usage limit. No account switch or retry.');if(credit?.rejected)throw Object.assign(Error('Flow rejected this tracked request for insufficient credits'),{flowCredits:true});}
  if (result?.error) throw Error(result.error+'; check Flow. Automatic resubmission is disabled. If Flow already made the video, download it there and Discard the stopped run.');
  if (result?.ready) {item.resultIdentity=result.identity;item.resultSource=result.src||'';await mobilePhase(item,'ready');return;}
  if (Date.now()-item.submittedAt>12*60000) throw Error('Generation wait expired; video retained in Flow, not regenerated');
  item.progress=result?.progressPercent??null;await mobilePersist();
  await sleep(4000);
}
async function mobileSave(item) {
  await mobileOwnedPage();
  await chrome.tabs.update(mobileJob.tabId,{active:true});
  if(item.kind==='image')return mobileSaveImage(item);
  item.downloadStartedAt=Date.now();await mobilePhase(item,'downloading');
  const result=await downloadVideoViaMenuUnlocked(mobileJob.tabId,item.id,[],text=>{item.detail=text;void mobilePersist();},item.filename,null,item.resultIdentity,false);
  item.downloadId=result.downloadId;item.outputName=result.placedName;item.bytes=result.bytes;item.downloadSource=result.sourceUrl;item.diskSaved=true;
  if(result.replyBytes)mobileReplyBytes.set(item.id,result.replyBytes);
  await mobilePersist();
  if(item.projectId){await mobilePhase(item,'workspace');await mobileCaptureClip(item);}
  await mobileFinish(item);
}
// Owner phone test 2026-11-08: Flow revokes its download link once the phone has the file, so the Workspace copy uses the
// bytes copied from Flow's own reply during the download (kept in memory only, until the clip is saved).
const mobileReplyBytes=new Map();
async function mobileCaptureClip(item) {
  const reply=mobileReplyBytes.get(item.id);
  const bytes=reply||await downloadMediaBuffer(mobileJob.tabId,{src:item.downloadSource,host:'Flow story video'},item.id);
  await mobileSaveStoryClip(item,bytes);item.workspaceSaved=true;mobileReplyBytes.delete(item.id);await mobilePersist();
}
async function mobileSaveImage(item) {
  // Save the project image before native download; next stages never depend on a hidden panel callback.
  if(!item.projectSaved){
    const bytes=await downloadMediaBuffer(mobileJob.tabId,{src:item.resultSource,host:'Flow story image'},item.id);
    const saved=await mobileSaveStoryImage(item,bytes);item.filename=item.filename.replace(/\.jpg$/,'.'+saved.ext);item.projectSaved=true;await mobilePersist();
  }
  const p=await mobileProject(item.projectId),media=p.media[item.imageId];
  const data=await mobileBlobData(media.blob,media.name);
  await mobilePhase(item,'downloading');item.downloadStartedAt=Date.now();await mobilePersist();
  const id=await chrome.downloads.download({url:data.dataUrl,filename:`${downloadFolder()}/${item.filename}`,saveAs:false,conflictAction:'uniquify'});
  item.downloadId=id;await mobilePersist();
  const until=Date.now()+5*60000;
  while(Date.now()<until){assertRunActive(runToken);const [record]=await chrome.downloads.search({id});if(record?.state==='complete'){item.outputName=record.filename;item.bytes=record.fileSize;return mobileFinish(item);}if(record?.state==='interrupted')throw Error('Image download interrupted; project image is saved');await sleep(1000);}
  throw Error('Image is saved in project; browser Download confirmation timed out');
}
// The user's "Wait after each result" (owner 2026-11-06; off at 0): saved in the job, so a restarted worker still waits.
function mobileStartAfterResultWait() {
  const s=mobileJob?.settings||{},min=Math.max(0,Number(s.afterResultMinSeconds)||0),max=Math.max(min,Number(s.afterResultMaxSeconds)||0);
  if(max>0)mobileJob.afterResultUntil=Date.now()+Math.round((min+Math.random()*(max-min))*1000);
}
async function mobileAfterResultWait() {
  if(!(mobileJob?.afterResultUntil>Date.now()))return;
  log(`Waiting ${Math.ceil((mobileJob.afterResultUntil-Date.now())/1000)}s before the next prompt (your Wait after each result setting).`);await mobilePersist();
  while(mobileJob.afterResultUntil>Date.now()){assertRunActive(runToken);if(stopRequested)throw Error('Stopped by user');await sleep(Math.min(1000,mobileJob.afterResultUntil-Date.now()));}
}
// Gentle pace (owner 2026-11-06): the user's pace from the job; a job started by an older panel has none (no pauses).
async function mobilePace(step) {
  const ms=flowPaceMs(mobileJob?.settings?.flowPace??'off',step);
  if(ms){assertRunActive(runToken);await sleep(ms);assertRunActive(runToken);}
}
async function mobileFinish(item) {
  item.phase='done';item.completedAt=Date.now();mobileStartAfterResultWait();
  // Mark before reporting: a worker restart cannot double-count saved usage.
  const report=!item.usageReported;item.usageReported=true;await mobilePersist();
  if(report)await mobileUsage(true);
  await exec(mobileJob.tabId,pg_flowStopResultTracking,[item.trackingKey],'MAIN').catch(()=>{});
  log(`${item.id}: saved ${item.outputName}`);await mobilePersist();
}
async function mobileRecoverDownload(item) {
  const records=await chrome.downloads.search(item.downloadId!=null?{id:item.downloadId}:{startedAfter:new Date(item.downloadStartedAt).toISOString()});
  const own=records.filter(record=>item.downloadId!=null?record.id===item.downloadId:matchesFlowDownload(record,mobileJob.projectUrl,item.downloadStartedAt));
  if (own.length!==1) throw Error('Download recovery uncertain. Check Downloads; generation will not be repeated.');
  const record=own[0];
  if(record.state==='interrupted') throw Error('Download interrupted; generated video retained in Flow');
  if(record.state!=='complete'){if(Date.now()-(item.downloadRecoveryStartedAt||item.downloadStartedAt)>5*60000)throw Error('Browser download is still waiting. Confirm Save on the phone, then Resume; the video will not be generated again.');await sleep(3000);return;}
  if(record.fileSize<(item.kind==='image'?100:100*1024))throw Error('Recovered download is too small');
  item.downloadId=record.id;item.outputName=record.filename;item.bytes=record.fileSize;item.diskSaved=true;await mobilePersist();
  if(item.projectId&&item.kind!=='image'){item.downloadSource=record.finalUrl||record.url;await mobilePhase(item,'workspace');await mobileCaptureClip(item);}
  await mobileFinish(item);
}
async function mobileRun() {
  if(mobileDrive)return mobileDrive;
  if(!mobileJob || mobileJob.status!=='running')return;
  mobileDrive=(async()=>{
    if(!mobileJob || mobileJob.status!=='running')return;
    settings=mobileJob.settings;queue=mobileJob.items;runToken=mobileJob.id;stopRequested=false;
    try {
      if(!mobileJob.accountPolicyChecked) {
        // Initial account selection is allowed only before any request was sent.
        if(!queue.some(i=>i.submittedAt||i.phase==='done')) {
          const accounts=await mobileSwitchPolicy(),current=mobileAccountOf(mobileJob.projectUrl);
          if(accounts&&!accounts.includes(current)) {
            mobileJob.accountSwitch={from:current,next:accounts[0],rejected:false,notBefore:Date.now(),tabId:null};await mobilePersist();
            log('Opening the first selected Flow account before generation.');
          }
        }
        mobileJob.accountPolicyChecked=true;await mobilePersist();
      }
      if(mobileJob.accountSwitch){if(mobileJob.accountSwitch.creating&&mobileJob.accountSwitch.tabId==null)throw Error('Account tab creation uncertain; inspect Flow before Resume.');await mobileFinishAccountSwitch();}
      while(!stopRequested && mobileJob.status==='running') {
        const item=queue.find(i=>i.phase!=='done');
        if(!item){
          if(mobileJob.storyId){
            const next=await mobileStoryPlan(mobileJob);
            if(next){next.trackingKey=`mobile:${mobileJob.id}:${queue.length}`;queue.push(next);await mobilePersist();continue;}
          }
          mobileJob.status='done';log('Worker queue complete; panel/audio not required.');await mobilePersist();
          if(mobileJob.storyId){
            mobileJob.workspaceAvailable=true;
            if(!mobileJob.workspaceOpened){
              mobileJob.workspaceOpened=true;await mobilePersist();
              try{await chrome.tabs.create({url:chrome.runtime.getURL('story-workspace.html?project='+encodeURIComponent(mobileJob.storyId)),active:true});}
              catch{log('Videos saved. Open Workspace from the Control panel.');await mobilePersist();}
            }
          }
          break;
        }
        if(item.phase==='submitting') {
          const probe=await exec(mobileJob.tabId,pg_flowTrackedResult,[item.trackingKey],'MAIN');
          if(!probe?.ready&&!Number.isFinite(probe?.progressPercent))throw Error('Submission acknowledgement uncertain; check Flow before Retry. No automatic resubmission. If Flow already made the video, download it there and Discard the stopped run.');
          await mobilePhase(item,'rendering');
        }
        if(item.phase==='rendering')await mobilePoll(item);
        else if(item.phase==='ready')await mobileSave(item);
        else if(item.phase==='downloading')await mobileRecoverDownload(item);
        else if(item.phase==='workspace'){await mobileCaptureClip(item);await mobileFinish(item);}
        else {await mobileAfterResultWait();await mobilePrepare(item);}
      }
    } catch(error) {
      let switched=false;
      if(error.flowCredits&&!stopRequested){try{switched=await mobileRequestAccountSwitch(queue.find(i=>i.phase!=='done'));}catch(switchError){error=switchError;}}
      if(!switched){mobileJob.status='paused';mobileJob.error=String(error?.message||error);log(mobileJob.error);await mobilePersist();}
    } finally {
      if(mobileJob.status!=='running')await chrome.alarms.clear(MOBILE_FLOW_ALARM);
    }
  })().finally(()=>{mobileDrive=null;if(mobileJob?.status==='running'&&!stopRequested)void mobileRun();});
  return mobileDrive;
}
const mobileBoot=(async()=>{mobileJob=(await chrome.storage.local.get(MOBILE_FLOW_KEY))[MOBILE_FLOW_KEY]||null;})();
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===MOBILE_FLOW_ALARM)void mobileBoot.then(mobileRun);});
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(!String(message?.type||'').startsWith('mobile-flow:'))return false;
  if(sender.id!==chrome.runtime.id || String(sender.url||'').split(/[?#]/)[0]!==chrome.runtime.getURL('control.html')) {reply({ok:false,error:'Only the Control panel may use this pilot'});return false;}
  (async()=>{
    await mobileBoot;
    if(message.type==='mobile-flow:status')return {ok:true,job:mobileJob};
    if(message.type==='mobile-flow:stop') {stopRequested=true;if(mobileJob){mobileJob.status='paused';mobileJob.error='Stopped by user';await mobilePersist();}return {ok:true};}
    if(message.type==='mobile-flow:continue-saved') {
      if(!mobileJob||mobileJob.status!=='paused'||mobileDrive||mobileStarting)throw Error('Wait for the paused queue.');
      const item=mobileJob.items.find(i=>i.phase!=='done');
      if(item?.phase!=='workspace'||!item.diskSaved||!item.projectId)throw Error('No confirmed saved clip is waiting for a Workspace copy.');
      mobileStarting=true;stopRequested=false;
      try {
        await mobileMarkDownloadedClip(item);if(stopRequested)throw Error('Stopped by user');
        item.workspaceSkipped=true;item.workspaceError=mobileJob.error;await mobileFinish(item);
        if(stopRequested)throw Error('Stopped by user');
        mobileJob.status='running';mobileJob.error='';await mobilePersist();
        if(stopRequested){mobileJob.status='paused';await mobilePersist();throw Error('Stopped by user');}
        await chrome.alarms.create(MOBILE_FLOW_ALARM,{periodInMinutes:0.5});void mobileRun();return {ok:true};
      } finally {mobileStarting=false;}
    }
    // Owner test 2026-11-04: Stop, close the browser tab, Auto again -> blocked by the stopped job, and Resume failed because
    // its Flow tab was gone. Discard lets the user drop a stopped job (saved clips and the story stay); nothing is regenerated.
    if(message.type==='mobile-flow:discard') {
      if(!mobileJob||mobileJob.status==='running'||mobileDrive||mobileStarting)throw Error('Stop the worker before discarding its run');
      mobileJob=null;stopRequested=false;await mobilePersist();await chrome.alarms.clear(MOBILE_FLOW_ALARM);return {ok:true};
    }
    if(message.type==='mobile-flow:resume') {
      if(!mobileJob||mobileJob.status!=='paused'||mobileDrive||mobileStarting)throw Error('No paused worker queue is ready to resume');
      // The original Flow tab may have been closed: continue in the one open tab that shows the same project.
      const tabs=await chrome.tabs.query({});
      if(!tabs.some(t=>t.id===mobileJob.tabId)) {
        const same=tabs.filter(t=>{const u=String(t.url||'').split(/[?#]/)[0];return u===mobileJob.projectUrl||u.startsWith(mobileJob.projectUrl+'/edit/');});
        if(same.length!==1)throw Error(same.length?'Several tabs show this Flow project. Close the extras, then Resume.':'The Flow tab of this run was closed. Open the same Flow project again, then Resume — or Discard the stopped run.');
        mobileJob.tabId=same[0].id;
      }
      const item=mobileJob.items.find(i=>i.phase!=='done');
      if(item?.phase==='downloading')item.downloadRecoveryStartedAt=Date.now();
      // Explicit Resume may retry an interrupted browser save, never the paid generation.
      if(item?.phase==='downloading'&&item.resultIdentity&&/browser download did not complete|Download interrupted/.test(mobileJob.error||'')){
        item.phase='ready';item.downloadId=null;item.downloadRetryCount=(item.downloadRetryCount||0)+1;
      }
      mobileJob.status='running';mobileJob.error='';await mobilePersist();
      await chrome.alarms.create(MOBILE_FLOW_ALARM,{periodInMinutes:0.5});void mobileRun();return {ok:true};
    }
    if(message.type==='mobile-flow:story') {
      if(mobileJob?.status==='running'||mobileDrive||mobileStarting)throw Error('A worker queue is already running');
      if(mobileJob?.items?.some(i=>['submitting','rendering','ready','downloading','workspace'].includes(i.phase)))throw Error('The last mobile run was stopped in the middle of a video. In Control, press Resume worker, or Discard stopped run to start fresh.');
      mobileStarting=true;
      try {
        const input=message.input;if(!input?.projectId||!Number.isInteger(input.tabId))throw Error('Choose a saved AI Story and Flow tab');
        const tab=await mobileTab(input.tabId);
        if(![tab.url,tab.pendingUrl].some(url=>/^https:\/\/flow\.google\.com(?:\/|$)/.test(url||'')))throw Error('Choose a Google Flow tab');
        const p=await mobileProject(input.projectId),chosen=FacelessBuilder.generationTargets(p.target,input.settings);
        const next={id:crypto.randomUUID(),storyId:p.id,title:p.project.title,status:'running',createdAt:Date.now(),tabId:tab.id,projectUrl:tab.url.split(/[?#]/)[0],settings:{...input.settings,platform:'flow',mode:'frame-to-video',flowModel:chosen.model,flowOutputCount:1,flowDurationSeconds:Number(p.setup.sceneDuration),aspectRatio:globalThis.StoryShape?.isLandscape(p)?'landscape':'portrait',renameOutputs:true},items:[],logs:[]};
        // Validate the complete route before replacing the prior completed job.
        await mobileStoryPlan(next);
        const ready=await mobileStoryReadyTab(tab.id);
        next.projectUrl=ready.url.split(/[?#]/)[0];
        mobileJob=next;await mobilePersist();await chrome.alarms.create(MOBILE_FLOW_ALARM,{periodInMinutes:0.5});void mobileRun();return {ok:true,id:next.id};
      } finally {mobileStarting=false;}
    }
    if(message.type!=='mobile-flow:start')throw Error('Unknown worker operation');
    if(mobileJob?.status==='running'||mobileDrive||mobileStarting)throw Error('A mobile worker queue is already running');
    if(mobileJob?.items?.some(i=>['submitting','rendering','ready','downloading','workspace'].includes(i.phase)))throw Error('The last mobile run was stopped in the middle of a video. Press Resume worker, or Discard stopped run to start fresh.');
    mobileValidateInput(message.input);
    mobileStarting=true;
    try {
    const input=message.input;const tab=await mobileTab(input.tabId);
    if(String(tab.url||'').split(/[?#]/)[0]!==input.projectUrl)throw Error('Flow project changed');
    const id=crypto.randomUUID();
    mobileJob={id,status:'running',createdAt:Date.now(),tabId:input.tabId,projectUrl:input.projectUrl,settings:input.settings,items:input.items.map((item,index)=>({...item,phase:'pending',trackingKey:`mobile:${id}:${index}`})),logs:[]};
    await mobilePersist();await chrome.alarms.create(MOBILE_FLOW_ALARM,{periodInMinutes:0.5});
    void mobileRun();return {ok:true,id};
    } finally {mobileStarting=false;}
  })().then(reply,error=>reply({ok:false,error:String(error?.message||error)}));
  return true;
});
void mobileBoot.then(mobileRun);
