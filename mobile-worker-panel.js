// Pilot controls are separate from Start. The worker remains the owner when this tab is hidden/closed.
(() => {
  const pilot=/MOBILE WORKER/.test(chrome.runtime.getManifest().version_name||'');
  if (!/Android/i.test(navigator.userAgent) && !(pilot&&/iPhone|iPad/i.test(navigator.userAgent))) return;
  let active=false, starting=false;
  // Owner 2026-11-04: the plain teal box looked unfinished. Card in the 0xFlow purple/teal look: state pill, progress, state-aware buttons.
  const style=document.createElement('style');
  style.textContent=`
  .mq{flex-basis:100%;box-sizing:border-box;margin:12px 0 2px;padding:14px;border-radius:16px;border:1px solid #6e5aa64d;color:#efeaff;background:radial-gradient(120% 90% at 100% 0,#91e5e11a,transparent 55%),linear-gradient(160deg,#211b36,#13111f 70%);box-shadow:inset 0 1px 0 #ffffff0d,0 8px 24px #0000004d;--mq:#9a8fbf}
  .mq[data-state=running]{--mq:#91e5e1;border-color:#91e5e166;box-shadow:inset 0 1px 0 #ffffff0d,0 0 0 1px #91e5e11f,0 8px 28px #3fc6c01f}
  .mq[data-state=paused]{--mq:#f2b84b;border-color:#f2b84b4d}
  .mq[data-state=done]{--mq:#78e3b7;border-color:#78e3b74d}
  .mq-head{display:flex;align-items:center;gap:10px}
  .mq-icon{flex:none;display:grid;place-items:center;width:34px;height:34px;border-radius:11px;font-size:17px;color:#171324;background:linear-gradient(135deg,#c5a6ff,#91e5e1);box-shadow:0 4px 14px #b28bff33}
  .mq-title{flex:1;min-width:0}
  .mq-title strong{display:block;font-size:14px;letter-spacing:.2px}
  .mq-title small{display:block;font-size:10.5px;color:#a9a3c4;margin-top:1px}
  .mq-pill{flex:none;display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--mq);background:color-mix(in srgb,var(--mq) 14%,transparent);border:1px solid color-mix(in srgb,var(--mq) 35%,transparent)}
  .mq-pill::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--mq)}
  .mq[data-state=running] .mq-pill::before{animation:mq-pulse 1.4s ease-in-out infinite}
  @keyframes mq-pulse{0%,100%{box-shadow:0 0 0 0 #91e5e199}50%{box-shadow:0 0 0 5px #91e5e100}}
  .mq-progress{margin-top:13px}
  .mq-progress[hidden]{display:none}
  .mq-count{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:#c9c2e6;margin-bottom:6px}
  .mq-count b{color:#fff;font-size:13px}
  .mq-track{height:7px;border-radius:99px;background:#ffffff12;overflow:hidden}
  .mq-fill{height:100%;width:0;border-radius:99px;background:linear-gradient(90deg,#c5a6ff,#91e5e1);transition:width .4s ease}
  .mq[data-state=paused] .mq-fill{background:linear-gradient(90deg,#c5a6ff,#f2b84b)}
  .mq-status{margin:12px 0 0;padding:9px 11px;border-radius:10px;font-size:11.5px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;color:#ddd7f2;background:#0000002e;border-left:3px solid var(--mq)}
  .mq-status:empty{display:none}
  .mq-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
  .mq-actions button{flex:1 1 auto;min-height:40px;padding:9px 14px;border-radius:11px;font-size:12.5px;font-weight:600;cursor:pointer;color:#e6defb;background:#ffffff0a;border:1px solid #ffffff1f}
  .mq-actions button[hidden]{display:none}
  .mq-actions .mq-primary{order:-1;flex-basis:100%;border:0;color:#171324;font-weight:700;background:linear-gradient(110deg,#c5a6ff,#91e5e1);box-shadow:0 4px 16px #b28bff2e}
  .mq-actions .mq-stop{color:#f6aab9;border-color:#f886a94d;background:#f886a90d}
  .mq-actions .mq-danger{color:#f3a0a0;border-color:#ef626240;background:transparent}
  .mq-actions button:disabled{opacity:.45;cursor:default}
  .mq-actions button:focus-visible{outline:2px solid #80e5ed;outline-offset:2px}
  .mq-foot{margin:11px 0 0;font-size:10px;line-height:1.4;color:#8f88ab}`;
  document.head.append(style);
  const box=document.createElement('div');box.className='mq';box.dataset.state='idle';
  box.innerHTML='<div class="mq-head"><span class="mq-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h11M4 12h8M4 17h6"/><path d="M15 13l5 3.5-5 3.5z" fill="currentColor"/></svg></span><div class="mq-title"><strong>Background queue</strong><small>Runs on its own — you can leave this tab</small></div><span class="mq-pill" data-mq-pill>Ready</span></div><div class="mq-progress" data-mq-progress hidden><div class="mq-count"><span data-mq-phase>Working</span><span><b data-mq-done>0</b> / <span data-mq-total>0</span> saved</span></div><div class="mq-track"><div class="mq-fill" data-mq-fill></div></div></div><p class="mq-status" data-worker-status></p><div class="mq-actions" data-mq-actions><button type="button" class="mq-primary" data-worker-start>▶ Start background queue</button><button type="button" class="mq-primary" data-worker-resume hidden>↻ Resume worker</button><button type="button" class="mq-stop" data-worker-stop hidden>■ Stop</button></div><p class="mq-foot">AI Story Auto and manual Flow video queues. No keep-alive audio; the browser may still ask you to tap Download.</p>';
  const start=document.getElementById('startBtn');if(!start)return;
  start.parentElement.append(box);
  const button=box.querySelector('[data-worker-start]'),status=box.querySelector('[data-worker-status]'),actions=box.querySelector('[data-mq-actions]');
  const resumeButton=box.querySelector('[data-worker-resume]'),stopButton=box.querySelector('[data-worker-stop]');
  const workspaceButton=document.createElement('button');workspaceButton.type='button';workspaceButton.className='mq-primary';workspaceButton.textContent='▣ Open Workspace';workspaceButton.hidden=true;actions.append(workspaceButton);
  const continueSaved=document.createElement('button');continueSaved.type='button';continueSaved.textContent='Continue with downloaded clip';continueSaved.hidden=true;actions.append(continueSaved);
  const PHASES={pending:'Waiting',preparing:'Preparing scene',submitting:'Sending to Flow',rendering:'Flow is rendering',ready:'Video ready',downloading:'Saving video',workspace:'Copying to Workspace'};
  function paintQueue(job) {
    const state=!job?'idle':job.status==='running'?'running':job.status==='done'?'done':'paused';
    box.dataset.state=state;box.querySelector('[data-mq-pill]').textContent={idle:'Ready',running:'Running',paused:'Paused',done:'Complete'}[state];
    const items=job?.items||[],done=items.filter(i=>i.phase==='done').length,current=items.find(i=>i.phase!=='done');
    box.querySelector('[data-mq-progress]').hidden=!items.length;
    box.querySelector('[data-mq-done]').textContent=done;box.querySelector('[data-mq-total]').textContent=items.length;
    box.querySelector('[data-mq-fill]').style.width=(items.length?Math.round(done/items.length*100):0)+'%';
    box.querySelector('[data-mq-phase]').textContent=state==='done'?'All done':state==='paused'?'Paused at scene '+(done+1):PHASES[current?.phase]||'Working';
    button.hidden=state==='running'||state==='paused';button.classList.toggle('mq-primary',state!=='done');resumeButton.hidden=state!=='paused';stopButton.hidden=state!=='running';
  }
  const discard=document.createElement('button');discard.type='button';discard.className='mq-danger';discard.textContent='✕ Discard stopped run';discard.hidden=true;actions.append(discard);
  discard.onclick=()=>{if(!confirm('Discard the stopped mobile run? Saved clips and the story stay. A video still rendering in Flow is not downloaded; save it from Flow yourself if you want it.'))return;request('discard').then(refresh).catch(error=>{status.textContent=error.message;});};
  continueSaved.onclick=()=>request('continue-saved').then(refresh).catch(error=>{status.textContent=error.message;});
  let finishedStoryId=null;
  let journalId=null,journalSeen=new Set();
  workspaceButton.onclick=()=>{if(finishedStoryId)void chrome.tabs.create({url:chrome.runtime.getURL('story-workspace.html?project='+encodeURIComponent(finishedStoryId)),active:true});};
  const request=async(type,input)=>{const r=await chrome.runtime.sendMessage({type:'mobile-flow:'+type,input});if(!r?.ok)throw Error(r?.error||'Worker unavailable');return r;};
  async function begin() {
    if(starting||active||running)throw Error('A queue is already running');
    starting=true;
    try {
      collectSettingsFromForm();
      if(settings.platform!=='flow')throw Error('Select Flow first');
      if(queue.some(i=>!['pending','done'].includes(i.status)))throw Error('Requeue errors explicitly first');
      const pending=queue.filter(i=>i.status==='pending');if(!pending.length)throw Error('Add prompts first');
      const gate=typeof usageAllowsNext==='function'?await usageAllowsNext(0):{ok:true};if(!gate.ok)throw Error(gate.message);
      const candidates=(await chrome.tabs.query({})).filter(t=>t.url&&FLOW_PROJECT_URL_RE.test(t.url));
      const tab=candidates.find(t=>t.active)||candidates[0];if(!tab)throw Error('Open your Flow project first');
      if(candidates.length>1&&!candidates.some(t=>t.active))throw Error('Several Flow projects are open. Activate the intended project first.');
      const items=pending.map(item=>({id:item.id,text:item.generationText||item.text,filename:outputNameForItem(item,'mp4'),builderProjectId:item.builderProjectId,manualProjectId:item.manualProjectId,image:settings.mode==='frame-to-video'?imagesForItem(item)[0]:null}));
      await request('start',{tabId:tab.id,projectUrl:tab.url.split(/[?#]/)[0],settings:{mode:settings.mode,flowPace:settings.flowPace,afterResultMinSeconds:settings.afterResultMinSeconds,afterResultMaxSeconds:settings.afterResultMaxSeconds,flowOutputCount:settings.flowOutputCount,flowDurationSeconds:settings.flowDurationSeconds,flowModel:settings.flowModel,aspectRatio:settings.aspectRatio,videoResolution:settings.videoResolution,videoGenerationResolution:settings.videoGenerationResolution,downloadSubfolder:settings.downloadSubfolder,renameOutputs:true,chainLastFrame:settings.chainLastFrame,manualSheets:settings.manualSheets},items});
      await refresh();
    } finally {starting=false;}
  }
  async function refresh() {
    const {job}=await request('status');active=job?.status==='running';
    if(job&&typeof log==='function') {
      if(journalId!==job.id){journalId=job.id;journalSeen=new Set();}
      for(const entry of job.logs||[]) {
        const key=entry.at+'|'+entry.text;if(journalSeen.has(key))continue;
        journalSeen.add(key);log('Mobile Auto: '+String(entry.text).replace(/https?:\/\/\S+/g,'[media link]'));
      }
    }
    const waiting=job?.items?.find(i=>i.phase!=='done');continueSaved.hidden=!(job?.status==='paused'&&waiting?.phase==='workspace'&&waiting.diskSaved);discard.hidden=!(job&&job.status!=='running'&&job.status!=='done');
    finishedStoryId=job?.status==='done'&&job.storyId?job.storyId:null;workspaceButton.hidden=!finishedStoryId;
    button.disabled=active||running;start.disabled=active||running;
    if(!job){status.textContent='';if(typeof paintQueue==='function')paintQueue(job);return;}
    status.textContent=finishedStoryId?(job.items.some(i=>i.workspaceSkipped)?'Videos saved on your phone. Import clips missing from Workspace to review them.':'All videos saved. Review your clips in Workspace.'):(job.error||'')+(!continueSaved.hidden?'\nThe clip is downloaded. Resume retries the Workspace copy, or Continue keeps the downloaded file and runs the next scene.':'');
    for(const result of job.items){const item=queue.find(i=>i.id===result.id);if(!item)continue;item.status=result.phase==='done'?'done':job.status==='paused'?'error':'running';item.detail=result.outputName||result.detail||job.error||`Worker: ${result.phase}`;if(result.outputName)item.outputName=result.outputName;}
    if(typeof paintQueue==='function')paintQueue(job);
    if(!running)renderQueue();
  }
  button.onclick=()=>begin().catch(error=>{status.textContent=error.message;});
  stopButton.onclick=()=>request('stop').then(refresh).catch(error=>{status.textContent=error.message;});
  resumeButton.onclick=()=>request('resume').then(refresh).catch(error=>{status.textContent=error.message;});
  start.addEventListener('click',event=>{if(active||starting){event.preventDefault();event.stopImmediatePropagation();status.textContent='Stop the worker before starting another queue.';}},true);
  async function startStory(projectId) {
    if(active||starting||running)throw Error('Wait for the active queue');starting=true;
    try {
      const gate=typeof usageAllowsNext==='function'?await usageAllowsNext(0):{ok:true};if(!gate.ok)throw Error(gate.message);
      const tabs=(await chrome.tabs.query({})).filter(t=>/^https:\/\/flow\.google\.com(?:\/|$)/i.test(t.url||''));
      let tab=tabs.find(t=>t.active)||(tabs.length===1?tabs[0]:null);
      if(!tab&&tabs.length)throw Error('Several Flow tabs are open. Select the one with your intended account, then press Auto again.');
      if(!tab)tab=await chrome.tabs.create({url:'https://flow.google.com/',active:true});
      await request('story',{projectId,tabId:tab.id,settings:{platform:'flow',flowModel:settings.flowModel,flowPace:settings.flowPace,afterResultMinSeconds:settings.afterResultMinSeconds,afterResultMaxSeconds:settings.afterResultMaxSeconds,flowImageModel:settings.flowImageModel,videoResolution:settings.videoResolution,videoGenerationResolution:settings.videoGenerationResolution,downloadSubfolder:settings.downloadSubfolder}});
      document.getElementById('controlTabBtn')?.click();await refresh();box.scrollIntoView({block:'center'});
    } finally {starting=false;}
  }
  function supportsStory(p) {
    const setup=p?.setup;if(!setup)return false;
    const targets=FacelessBuilder.generationTargets(p.target,settings);
    const imagesReady=!!p.project?.scenes?.length&&[...(p.project.assets||[]),...p.project.scenes].every(x=>p.media?.[x.id]?.blob?.size>0&&/^[a-f0-9]{64}$/.test(p.media[x.id].sha256||'')&&!(p.redoIds||[]).includes(x.id)&&!(p.staleSceneIds||[]).includes(x.id));
    return (targets.imagePlatform==='flow'||imagesReady)&&targets.videoPlatform==='flow'&&setup.exportProfile!=='Recurring assets + video'&&setup.exportProfile!=='Image prompts only'&&setup.imageMode!=='Prompts only'&&p.sceneImageMode!=='sheets'&&!p.pronunciations?.trim();   // wide 16:9 stories run in the worker too (owner 2026-11-11)
  }
  window.MobileFlowPilot={supportsStory,start:begin,startStory,isActive:()=>active||starting,status:()=>request('status'),stop:()=>request('stop'),resume:()=>request('resume'),discard:()=>request('discard'),refresh};
  chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.mobileFlowWorkerV1)void refresh().catch(()=>{});});
  void refresh().catch(error=>{status.textContent=error.message;});
})();
