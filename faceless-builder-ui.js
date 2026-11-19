/* Faceless Builder is deliberately independent of the transient generation queue. */
// One yellow milestone star for every 100 recorded completed stories.
(()=>{const style=document.createElement('style');style.textContent='#builderTabPanel .fb-template-usage{display:flex;align-items:center;justify-content:space-between;gap:8px}#builderTabPanel .fb-template-usage-label{min-width:0}#builderTabPanel .fb-template-stars{flex-shrink:0;max-width:48%;color:#ffd45c;font:600 10px/1.25 system-ui;letter-spacing:1px;text-align:right;overflow-wrap:anywhere}';document.head.append(style);})();
// AI Drama cover labels remain readable UI text instead of being baked into the thumbnail.
(()=>{const style=document.createElement('style');style.textContent='#builderTabPanel .fb-badge-language{background:#302545ed;color:#dcf9f4;text-transform:uppercase}#builderTabPanel .fb-cover-languages{position:absolute;left:8px;right:8px;bottom:6px;display:flex;flex-wrap:wrap;justify-content:flex-start;gap:3px;padding:0;pointer-events:none}#builderTabPanel .fb-cover-languages span{display:inline-block;padding:1px 2px;border:1px solid #c1afea88;border-radius:4px;background:#20182ce8;color:#fff;font:500 9px/1.2 system-ui,sans-serif;white-space:nowrap}@media(max-width:480px){#builderTabPanel .fb-cover-languages{left:5px;right:5px}#builderTabPanel .fb-cover-languages span{font-size:8px}}';document.head.append(style);})();
(() => {
  'use strict';
  const B=window.FacelessBuilder;
  const deletedProjects=new Set();
  let projectRenderRevision=0;
  let templateUsage=null,templateUsageFetched=0,templateUsagePending=null;
  let buildWatchTimer=null,buildWatchBusy=false;
  let dbPromise,catalog=[],templates=[],answers={},step=0,selected=null,pollTimer=null,busy=false,mediaWrites=Promise.resolve(),quick=false,activeTemplate=null,target=null;
  const db=()=>dbPromise ||= new Promise((resolve,reject)=>{const r=indexedDB.open('flow-faceless-projects',1);r.onupgradeneeded=()=>r.result.createObjectStore('projects',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>{dbPromise=null;reject(r.error);};});
  async function store(method,value){const d=await db();return new Promise((resolve,reject)=>{const tx=d.transaction('projects',method==='getAll'?'readonly':'readwrite');const r=tx.objectStore('projects')[method](...(value===undefined?[]:[value]));tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
  // One-time cleanup (owner 2026-10-25): older versions marked scenes "sheet tried" when a queue was loaded, so a reload,
  // stop or rebuild left them marked and storyboard sheets quietly became single images. Those marks are cleared once.
  if(typeof chrome!=='undefined'&&chrome.storage?.local)(async()=>{try{const k='sheetTriedCleanupV1';if((await chrome.storage.local.get(k))[k])return;for(const p of await store('getAll'))if(p.sheetTriedIds?.length){p.sheetTriedIds=[];await store('put',p);}await chrome.storage.local.set({[k]:Date.now()});}catch(e){console.warn('Storyboard sheet cleanup:',e);}})();
  function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
  function userText(tag,text,cls){const e=el(tag,text,cls);e.setAttribute('data-no-i18n','');return e;}
  function button(text,fn){const b=el('button',text);b.type='button';if(/^(Continue|Create|Build scene|＋ New)/.test(text))b.className='fb-primary';let pending=null;b.onclick=()=>{if(pending)return pending;pending=Promise.resolve().then(fn).catch(error).finally(()=>{pending=null;});return pending;};return b;}
  const dialog=el('section',undefined,'fb-dialog hidden'),body=el('div',undefined,'fb-body'),message=el('p','', 'fb-message');
  dialog.id='builderTabPanel';dialog.setAttribute('role','tabpanel');dialog.setAttribute('aria-labelledby','builderTabBtn');
  Object.defineProperty(dialog,'open',{get:()=>!dialog.classList.contains('hidden')});
  dialog.close=()=>{clearTimeout(pollTimer);$('controlTabBtn').click();};
  function error(e){
    const text=e?.message||String(e);
    if(/Builder capacity reached|Daily builder limit reached|Daily idea limit reached|Hourly limit reached/i.test(text)){message.textContent='';showLimitNotice(text);return;}
    message.textContent=text;
  }
  function showLimitNotice(text){
    document.querySelector('.fb-limit-dialog')?.remove();
    const notice=el('dialog',undefined,'fb-limit-dialog'),head=el('div',undefined,'fb-limit-head'),icon=el('span','!','fb-limit-icon'),copy=el('div'),close=button('×',()=>notice.close());
    const daily=/Daily builder limit/i.test(text),account=/Daily idea limit|Hourly limit/i.test(text),reserve=/capacity reached for (free|Discord Pro) accounts/i.test(text);copy.append(el('h3',account?(/Hourly/i.test(text)?'Hourly limit reached':'Daily idea limit reached'):daily?'Daily Builder limit reached':reserve?'AI Story is very busy':'Builder is at capacity'),el('small','Please try again later'));close.setAttribute('aria-label','Close notice');head.append(icon,copy,close);
    notice.setAttribute('aria-labelledby','fb-limit-title');copy.querySelector('h3').id='fb-limit-title';
    notice.append(head,el('p',account?text:reserve?text.replace(/^Builder capacity reached for [^:]*:\s*/i,'').replace(/^./,x=>x.toUpperCase()):daily?'You’ve used today’s Builder allowance. New stories and idea suggestions are paused until the daily limit resets. Your existing projects remain available.':'The Builder has reached its shared request limit or is handling too many builds. Please try again later.'),el('div','✓ Your existing projects are safe. You can return and try again.','fb-limit-saved'));
    const actions=el('div',undefined,'fb-limit-actions');
    // Daily limits offer Upgrade to Pro (owner 2026-10-27); same order flow as the Run card button (usage-limit.js).
    // Paid-first pause when the AI quota runs low (owner 2026-11-02) offers it too.
    if((daily||account||reserve)&&typeof usageUpgrade==='function'){const up=button('✦ Upgrade to Pro',async()=>{await usageUpgrade(up);});up.className='fb-limit-upgrade';actions.append(up);}
    actions.append(button('Got it',()=>notice.close()));notice.append(actions);notice.addEventListener('close',()=>notice.remove(),{once:true});document.body.append(notice);notice.showModal();actions.lastElementChild.focus();
  }
  // Server unreachable (connection refused/timed out, or nginx answering 502/503 without JSON): say so in a small popup,
  // at most once per 10 minutes, instead of an empty gallery or a silent failure (owner request 2026-10-19).
  let serverDownShownAt=0;
  // AI narration pilot (owner 2026-10-31 plan, Phase 3): hidden unless chrome.storage.local narrationPilot === true.
  let narrationPilot=false;
  if(typeof chrome!=='undefined'&&chrome.storage?.local){chrome.storage.local.get('narrationPilot').then(x=>{narrationPilot=x.narrationPilot===true;}).catch(()=>{});chrome.storage.onChanged?.addListener((c,area)=>{if(area==='local'&&c.narrationPilot)narrationPilot=c.narrationPilot.newValue===true;});}
  // Monthly AI narration (owner 2026-10-31, Pro 300 s): when it is used up, new stories cannot pick AI narrator until it resets.
  let narrationUsedUp=false;
  async function checkNarration(){try{const N=await import('./lib/story-narration-generate.mjs'),c=await N.serverClient().capabilities(),was=narrationUsedUp;narrationUsedUp=!c.available||!!c.allowance&&c.allowance.remainingSeconds<1;return was!==narrationUsedUp;}catch{return false;}}
  const narrationOn=a=>narrationPilot&&!narrationUsedUp&&Boolean(B.narrationEligible?.(a));
  function serverDownWarning(){
    if(Date.now()-serverDownShownAt<600000||document.querySelector('dialog.fb-server-down'))return;serverDownShownAt=Date.now();
    const dialog=el('dialog',undefined,'gs-popup fb-server-down'),close=()=>dialog.close();dialog.setAttribute('aria-labelledby','fbServerDownTitle');
    const heading=el('div',undefined,'gs-popup-heading'),emblem=el('span','!','gs-popup-emblem'),text=el('div');emblem.setAttribute('aria-hidden','true');
    const title=el('h3','Can’t reach AI Story');title.id='fbServerDownTitle';text.append(el('span','CONNECTION','gs-popup-eyebrow'),title);heading.append(emblem,text);
    const ok=button('OK',close);ok.className='gs-google';const actions=el('div',undefined,'gs-popup-actions');actions.append(ok);
    dialog.append(heading,el('p','Check your internet connection. If it’s working, the AI Story server may be restarting, so please try again in a minute. New stories and idea suggestions need this connection; your saved projects stay safe on this device.'),actions);
    dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal();ok.focus();
  }
  async function request(route,payload){
    if(payload?.setup)payload={...payload,setup:B.compatibleLanguageSetup(payload.setup)};
    if(route==='/builder/jobs'&&payload!==undefined){
      await window.FlowGoogleSignIn?.refresh?.();
      const account=window.FlowGoogleSignIn?.current?.();
      if(account?.signedIn&&account.builder?.remaining===0)throw Error('Daily builder limit reached. Your story allowance is used up. New stories and idea suggestions are unavailable until it resets.');
    }
    const connection=await chrome.storage.local.get(['remoteRepairUrl','remoteRepairToken']);
    if(!connection.remoteRepairToken||!connection.remoteRepairUrl)throw Error('Connect cloud repair in the Auto-Fix tab first to use AI Story.');
    // One failed request is often a short internet blip, not the server being down (owner report 2026-10-22: the popup
    // showed while 18 other users were served). A read is retried once after 2 s; a POST is never resent (it may already
    // have reached the server), so it only warns when a quick read confirms the server cannot be reached.
    let result;try{result=await remoteRepairRequest(connection,route,payload);}catch(e){
      if(!e?.remoteTransportError)throw e;
      await new Promise(resolve=>setTimeout(resolve,2000));
      if(payload!==undefined){if(!await remoteRepairRequest(connection,'/builder/usage').then(()=>true,()=>false))serverDownWarning();throw e;}
      try{result=await remoteRepairRequest(connection,route);}catch(e2){if(e2?.remoteTransportError)serverDownWarning();throw e2;}
    }
    // A story whose panel was closed before it finished stays "Writing" locally; days later the server has removed the
    // finished job and answers 404. End it as failed instead of polling forever under "not enabled" (owner report 2026-11-03).
    if(result.status===404&&/^\/builder\/jobs\/[^/]+(?:\/cancel)?$/.test(route))return {state:'failed',error:'This story is no longer on the server: it finished while the panel was closed and was removed after a few days. Press Try again to write it again with the same settings.'};
    if(result.status===503&&result.body?.code==='MAINTENANCE'){maintenance=result.body.maintenance||{on:true};maintenancePaint().catch(()=>{});throw Object.assign(Error(result.body.error||'System in maintenance mode.'),{code:'MAINTENANCE'});}
    if(result.status>=400)throw Error(result.status===404?'AI Story is not enabled on this server yet.':result.body?.error||'Builder request failed.');
    // A new or cancelled story changes "N of 2 free stories left today": update the sign-in bar now instead of on its next minute poll.
    if(route==='/builder/jobs'&&payload!==undefined)templateUsageFetched=0;
    if(payload!==undefined&&/^\/builder\/jobs(?:\/[^/]+\/cancel)?$/.test(route))window.FlowGoogleSignIn?.refresh?.();
    return result.body;
  }
  // Leaving the project view (Back to projects, setup steps…) forgets the open project, so the build status refresh no
  // longer reopens it a few seconds later (owner report 2026-10-15). openProject() sets `selected` again itself.
  function clear(){selected=null;factoryShown=false;projectRenderRevision++;body.replaceChildren();message.textContent='';}
  function ideaKey(text){return String(text).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();}
  // Ideas to avoid, newest first, cut to fit the template context (owner 2026-10-30: the old cut kept the oldest ideas and dropped the newest).
  function avoidIdeas(list){const out=[];for(const t of [...new Set(list.filter(Boolean))].reverse()){const next=[...out,t.slice(0,90)];if(JSON.stringify(next).length>950)break;out.push(t.slice(0,90));}return JSON.stringify(out);}
  async function ideaHistory(){const saved=await chrome.storage.local.get(['facelessIdeaHistory']);return Array.isArray(saved.facelessIdeaHistory)?saved.facelessIdeaHistory:[];}
  async function rememberIdeas(job){
    const history=await ideaHistory();
    const projects=await store('getAll');const previous=new Set([...history.filter(x=>x.id!==job.id).flatMap(x=>x.topics||[]),...projects.filter(x=>x.id!==job.id).flatMap(x=>x.topics||[x.setup?.topic||''])].map(ideaKey));
    const topics=job.topics.filter(t=>!previous.has(ideaKey(t)));
    if(!history.some(x=>x.id===job.id))await chrome.storage.local.set({facelessIdeaHistory:[...history,{id:job.id,topics:job.topics}].slice(-200)});
    job.topics=topics;
    if(!topics.length){job.state='failed';job.error='These ideas were already suggested. Request fresh ideas from a template.';delete job.topics;}
  }
  function nicheCategory(n){
    n=Number(n);if([45,52].includes(n))return 'Comedy';if([46,54].includes(n))return 'History';if([47].includes(n))return 'Finance';if([48,55].includes(n))return 'Lifestyle';if([49].includes(n))return 'Mystery';if([50].includes(n))return 'Seasonal';if([51,53].includes(n))return 'Drama';if(n===42)return 'ASMR';if(n===43)return 'History';if(n===41)return 'Miniature';if(n===57)return 'Health & wellness';if(n===59)return 'Animation';if(n===61)return 'Anime drama';if(n===60)return 'Stick figure';if([1,2,22].includes(n))return 'Cooking';if([3,4,25].includes(n))return 'Home';if([5,8,26].includes(n))return 'Health';if([6,21].includes(n))return 'Nature';if([7,9,24].includes(n))return 'Education';if([10,23].includes(n))return 'Technology';if([11,12].includes(n))return 'Product & craft';if([14,15,17,18,28].includes(n))return 'Animation';if([16,19,20,29,31,32].includes(n))return 'Character host';if([30,33].includes(n))return 'Documentary';return 'Story';
  }
  function seriesParts(records,root){
    const slots=new Map(),rank=p=>['queued','running'].includes(p.state)?3:['failed','cancelled'].includes(p.state)?0:2;
    for(const p of records.filter(x=>x.id===root||x.parentProjectId===root)){const number=Number(p.setup?.partNumber||1),old=slots.get(number);if(!old||rank(p)>rank(old)||(rank(p)===rank(old)&&(p.createdAt||0)>(old.createdAt||0)))slots.set(number,p);}
    return [...slots.values()].sort((a,b)=>Number(a.setup?.partNumber||1)-Number(b.setup?.partNumber||1));
  }
  // Owner 2026-10-29: each AI Story saves in its own folder named after the story (Part 2/3 join Part 1's folder).
  async function storyFolder(p){const all=p.parentProjectId||p.previousSeasonRootId?await store('getAll'):[],root=p.parentProjectId?all.find(x=>x.id===p.parentProjectId):p;
    // A later season saves next to the first one: "<first title> - Season 2" (owner 2026-11-11, Continue the story).
    if(root?.previousSeasonRootId&&Number(root.setup?.season||1)>1){let first=root;for(let i=0;i<60&&first?.previousSeasonRootId;i++)first=all.find(x=>x.id===first.previousSeasonRootId)||null;const title=String(first?.project?.title||'').trim();if(title)return title+' - Season '+root.setup.season;}
    return String(root?.project?.title||p.project?.title||'').trim();}
  function projectStatus(p,records=[]){
    if(p.kind==='manual')return {label:'Manual \u00b7 '+(p.videoDoneIds||[]).length+'/'+(p.project?.scenes?.length||0)+' clips saved',completed:p.state==='videos_finished'};
    const parts=seriesParts(records,p.parentProjectId||p.id),latest=parts.at(-1)||p;
    if(latest.kind==='topics'||latest.setup?.topicMode==='Suggest five ideas')return {label:({running:'Suggesting ideas',queued:'Ideas queued',finished:'Ideas ready',cancelled:'Suggestions cancelled',failed:'Needs attention'})[latest.state]||latest.state,completed:false};
    const finished=latest.state==='videos_finished'||(latest.setup?.exportProfile==='Image prompts only'&&latest.imagesReviewed);
    const total=Number(latest.setup?.partsTotal||1),number=Number(latest.setup?.partNumber||1);
    if(finished&&number>=total)return {label:'✓ Completed',completed:true};
    if(finished)return {label:'Part '+number+' complete · '+(total-number)+' remaining',completed:false};
    return {label:({video_ready:'Ready for video',prompts_ready:'Prompts ready',finished:'Prompts ready',images_generated:'Images ready',images_reviewed:'Images approved',running:'Writing',queued:'Queued',failed:'Needs attention',cancelled:'Cancelled'})[latest.state]||String(latest.state||'Needs attention').replaceAll('_',' '),completed:false};
  }
  async function deleteProject(p){
    if(busy)throw Error('Wait for the current Builder action to finish.');
    const records=await store('getAll'),root=p.parentProjectId||p.id,parts=records.filter(x=>x.id===root||x.parentProjectId===root),ids=new Set(parts.map(x=>x.id));
    if(running&&queue.some(x=>ids.has(x.builderProjectId||x.manualProjectId)))throw Error('Stop this project’s generation before deleting it.');
    if(!confirm('Delete "'+(p.project?.title||'this project')+'"'+(parts.length>1?' and all '+parts.length+' parts':'')+'? Saved prompts and images will be removed from this extension. Downloaded files stay on your computer.'))return;
    busy=true;
    try{
      for(const part of parts)if(part.kind!=='manual'&&['queued','running'].includes(part.state))await request('/builder/jobs/'+(part.jobId||part.id)+'/cancel',{});
      clearTimeout(pollTimer);for(const id of ids)deletedProjects.add(id);await mediaWrites;
      const d=await db();await new Promise((resolve,reject)=>{const tx=d.transaction('projects','readwrite');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);const projects=tx.objectStore('projects');for(const id of ids)projects.delete(id);});
      const active=await chrome.storage.local.get(['facelessActiveProjectId','facelessDismissedProjectId']),changes={};for(const key of ['facelessActiveProjectId','facelessDismissedProjectId'])if(ids.has(active[key]))changes[key]='';if(Object.keys(changes).length)await chrome.storage.local.set(changes);
      await window.FlowBuilderUI?.removeWorkspaceProjects?.([...ids]);
      if(selected&&ids.has(selected.id))selected=null;
      await showContinuation();await home('projects');
    }finally{busy=false;}
  }
  function orderedTemplates(list){
    return list.map((template,index)=>({template,index})).sort((a,b)=>{
      const rank=t=>Number(t.answers.niche)===34?-1000:Number(t.answers.niche)===58?-999.5:Number(t.answers.niche)===61?-999.25:Number(t.answers.niche)===38?-999:Number(t.answers.niche)>=35?-Number(t.answers.niche):0;   // Tagalog Drama, AI Drama (owner 2026-10-30), Anime Drama (owner 2026-11-08), Pinoy Folklore Horror (owner 2026-10-18), then newest
      return rank(a.template)-rank(b.template)||a.index-b.index;
    }).map(x=>x.template);
  }
  function templateHighlight(template,usage){
    if(Number(template.answers.niche)===34)return {label:'FEATURED',kind:'featured'};
    if([58,61].includes(Number(template.answers.niche)))return {label:'NEW',kind:'new'};
    if(usage?.trending)return {label:'TRENDING',kind:'trending'};
    if(usage?.popular)return {label:'POPULAR',kind:'popular'};
    return null;
  }
  const TEMPLATE_GROUPS=[
    {id:'all',label:'All'},
    {id:'stories',label:'Stories',description:'Drama, comedy, history and short films'},
    {id:'products',label:'UGC & Products',description:'Product ads, showcases and property listings'},
    {id:'explainers',label:'Tips & Explainers',description:'Health, food, money, technology and useful advice'},
    {id:'creative',label:'Creative & ASMR',description:'Miniature worlds, satisfying visuals, crafts and songs'},
    {id:'hosts',label:'Vlogs & Hosts',description:'Recurring presenters, podcasts and character-led videos'}
  ];
  function templateGroup(t){
    const n=Number(t.answers.niche);
    if([13,14,22,30,34,58,61,35,36,37,38,39,40,43,46,50,51,52,53,54,59].includes(n))return 'stories';
    if([4,11,56].includes(n))return 'products';
    if([12,27,28,41,42].includes(n))return 'creative';
    if([16,17,18,19,20,29,31,44,45,55].includes(n))return 'hosts';
    return 'explainers';
  }
  const templateQuery=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  function discoverTemplates(list,group='all',{query='',recent=false,category=''}={}){
    const words=templateQuery(query).split(/\s+/).filter(Boolean);
    return orderedTemplates(list).filter(t=>{
      const g=TEMPLATE_GROUPS.find(x=>x.id===templateGroup(t)),niche=nicheCategory(t.answers.niche);
      const text=templateQuery([t.title,t.id.replace(/-/g,' '),niche,g.label,g.description,t.answers.language,t.answers.presetContext].filter(Boolean).join(' '));
      return (group==='all'||g.id===group)&&(!recent||(Number(t.answers.niche)>=45&&Number(t.answers.niche)<=57)||Number(t.answers.niche)>=59)&&(!category||niche===category)&&words.every(word=>text.includes(word));
    });
  }
  const workspaceOpening=new Map();
  // Phones (owner 2026-10-31): Story Workspace never opens by itself; a new tab hides the panel there and stops the run.
  // The Open Story Workspace buttons still work.
  const onPhone=()=>typeof mobileOverlayDevice==='function'&&mobileOverlayDevice();
  async function openStoryWorkspace(p,{auto=false}={}){
    if(auto&&onPhone()){if(typeof log==='function')log('Videos are saved. Open Story Workspace from AI Story to edit or export the story.');return null;}
    const owner=await chrome.windows.getCurrent(),base=chrome.runtime.getURL('story-workspace.html'),key=owner.id+':'+p.id;
    if(workspaceOpening.has(key))return workspaceOpening.get(key);
    const opening=(async()=>{
      const tabs=await chrome.tabs.query({}),existing=tabs.find(tab=>{try{const url=new URL(tab.url||'');return url.href.split(/[?#]/)[0]===base&&url.searchParams.get('project')===p.id&&(!url.searchParams.has('ownerWindow')||url.searchParams.get('ownerWindow')===String(owner.id));}catch{return false;}});
      if(existing){await chrome.tabs.update(existing.id,{active:true});if(chrome.windows.update)await chrome.windows.update(existing.windowId,{focused:true});return existing;}
      return chrome.tabs.create({windowId:owner.id,url:base+'?project='+encodeURIComponent(p.id)+'&ownerWindow='+owner.id,active:true});
    })();workspaceOpening.set(key,opening);try{return await opening;}finally{workspaceOpening.delete(key);}
  }
  async function characterLibrary(options){return (await import('./lib/character-library-ui.mjs')).openCharacterLibrary(options);}
  // Hook Lab (owner 2026-10-29): three alternative first lines for Scene 1 before the story is written; the pick goes to
  // the writer as the exact opening line. Only for a written topic (not "Suggest five ideas"); a new topic clears them.
  function hookCard(){
    if(answers.topicMode==='Suggest five ideas'||!String(answers.topic||'').trim())return null;
    if(answers.hookTopic!==answers.topic){delete answers.hookOptions;delete answers.openingHook;}
    const card=el('div',undefined,'fb-card fb-hook-lab');let waiting=false;
    const paint=()=>{
      card.replaceChildren(el('strong','Opening hook · the first 3 seconds'),el('small',answers.hookOptions?'Pick the line Scene 1 opens with, or let the writer decide.':'Get 3 different openings (an action and a first line) and pick the one that stops the scroll.','fb-muted'));
      if(answers.hookOptions){
        const list=el('div',undefined,'fb-hook-options');list.setAttribute('role','radiogroup');list.setAttribute('aria-label','Opening hook');
        const key=h=>h?(typeof h==='string'?h:h.line):'',chosen=key(answers.openingHook);
        for(const h of [...answers.hookOptions,'']){
          const pick=button('',async()=>{if(chosen===key(h))return;answers.openingHook=h;delete answers.requestId;await saveDraft();paint();});
          if(!h)pick.textContent='Let the writer decide';else{if(h.action)pick.append(el('span','🎬 '+h.action,'fb-hook-action'));pick.append(el('span','💬 “'+key(h)+'”','fb-hook-line'));}
          pick.setAttribute('role','radio');pick.setAttribute('aria-checked',String(chosen===key(h)));pick.classList.add('fb-hook-option');list.append(pick);
        }
        card.append(list);
      }
      const ask=button(waiting?'Writing hooks…':answers.hookOptions?'↻ New hooks':'✨ Suggest 3 hooks',async()=>{
        if(waiting)return;waiting=true;paint();
        try{
          const setup=B.validateSetup({...answers,presetContext:String(answers.presetContext||'').slice(0,1500)});
          const j=await request('/builder/jobs',{setup,requestId:crypto.randomUUID(),templateId:activeTemplate?.id,kind:'hooks'});if(j.kind!=='hooks'){await request('/builder/jobs/'+(j.jobId||j.id)+'/cancel',{}).catch(()=>{});throw Error('Hook suggestions are not available on the server yet.');}
          const done=await pollJob(j.jobId||j.id,x=>Array.isArray(x.hooks)&&x.hooks.length>0);
          answers.hookOptions=done.hooks.slice(0,3);answers.hookTopic=answers.topic;answers.openingHook='';delete answers.requestId;await saveDraft();
        }catch(e){waiting=false;paint();card.append(el('small',e.message,'fb-message'));return;}
        waiting=false;paint();
      });
      ask.disabled=waiting||running;card.append(ask);
    };
    paint();return card;
  }
  function castSetupButton(){
    const ids=answers.characterIds||[],row=el('div',undefined,'fb-card');row.append(el('strong','Saved characters'),el('small',ids.length?ids.length+' selected · used automatically in your story.':'Reuse their identity and voice; clothes can follow your story.'));
    row.append(button(ids.length?'Change saved cast':'Choose saved characters',async()=>{
      const selectedIds=await characterLibrary({mode:'pick',selectedIds:ids});if(selectedIds===null)return;
      answers.characterIds=selectedIds;if(selectedIds.length)answers.imageWorkflow='Reference images first';delete answers.requestId;await saveDraft();if(quick)quickSummary();else reviewSetup();
    }));if(ids.length){import('./lib/character-library-ui.mjs').then(UI=>UI.ensureCharacterStyles());const label=el('label'),keep=el('input');keep.type='checkbox';keep.checked=answers.characterWardrobe!=='story';keep.setAttribute('aria-label','Keep saved outfit');keep.onchange=async()=>{answers.characterWardrobe=keep.checked?'saved':'story';delete answers.requestId;await saveDraft();};label.className='cl-outfit-option';label.append(keep,el('span','Keep saved outfit'));row.append(el('small','On: the saved outfit stays in every scene. Off: clothes follow the story.'),label);}return row;
  }
  async function autoApplySavedCast(p){
    const task=async()=>{
      if(!p.project||!p.libraryCastReview||running)return p;
      await mediaWrites;if(running)return p;
      const latest=(await store('getAll')).find(x=>x.id===p.id);if(!latest?.project||!latest.libraryCastReview)return latest||p;
      const C=await import('./lib/character-library.mjs'),cast=latest.libraryCast||[],match=C.resolveCastBindings(latest.project,cast);
      if(!cast.length||!match.bindings){latest.libraryCastIssue='The story could not clearly include '+(match.missing.join(', ')||'your selected cast')+'.';return latest;}
      const mapped=C.mappedReferences(latest.project,cast,match.bindings);
      if(latest.project.scenes.some(s=>latest.media?.[s.id]?.blob)||(await savedVideoIds(latest)).length||mapped.some(m=>latest.media?.[m.assetId]?.blob&&latest.media[m.assetId].sha256!==m.image.sha256)){latest.libraryCastIssue='This story already has generated references or scenes. Rebuild to use your selected cast without replacing existing work.';return latest;}
      const project=C.castWardrobePrompts(latest.project,cast,match.bindings,latest.libraryWardrobe||'story');B.validateProject(project,latest.setup);
      if(running)return p;latest.project=project;latest.media ||= {};
      for(const m of mapped){if(running)return latest;if(latest.media[m.assetId]?.sha256===m.image.sha256)continue;await attach(latest,m.assetId,m.image.blob,m.image.blob.type==='image/jpeg'?'jpg':m.image.blob.type.split('/')[1]);latest.media[m.assetId].libraryCharacter={id:m.characterId,name:m.name};}
      latest.libraryBindings=match.bindings;latest.libraryWardrobe ||= 'story';latest.libraryCastReview=false;latest.libraryReferenceMode='applied';delete latest.libraryCastIssue;await store('put',latest);return latest;
    };
    const pending=(autoApplySavedCast.pending||Promise.resolve()).catch(()=>{}).then(task);autoApplySavedCast.pending=pending;return pending;
  }
  async function castReviewCard(p){
    const UI=await import('./lib/character-library-ui.mjs');UI.ensureCharacterStyles();
    const card=el('section',undefined,'cl-cast-box');card.append(el('h4','Your selected cast needs a story update'),el('p',running?'Finish the current run, then reopen this story to use your selected cast.':p.libraryCastIssue||'The story did not clearly name your selected characters.','cl-note'));
    const actions=el('div',undefined,'fb-actions'),rebuild=button('Review setup & rebuild',async()=>{if(busy||running)throw Error('Finish the current action first.');answers={...p.setup,presetContext:storyContext(p.libraryBaseContext??''),characterIds:(p.libraryCast||[]).map(c=>c.id),characterWardrobe:p.libraryWardrobe||'story'};delete answers.requestId;target=p.target||null;activeTemplate=templates.find(t=>t.id===p.templateId)||null;quick=Boolean(activeTemplate);step=B.steps(answers).length;await saveDraft();if(quick)quickSummary();else reviewSetup();}),skip=button('Use story-generated characters',async()=>{if(busy||running)throw Error('Finish the current action first.');p.libraryCastReview=false;p.libraryReferenceMode='skipped';await store('put',p);await openProject(p);});rebuild.classList.add('fb-primary');rebuild.disabled=skip.disabled=running;actions.append(rebuild,skip);card.append(actions,el('small','Rebuilding creates a new story package. This project stays saved.','cl-note'));return card;
  }
  async function saveReferenceCharacter(p,x){
    const media=p.media?.[x.id];if(!media?.blob)throw Error('Generate or upload this reference image first.');
    await characterLibrary({seed:{name:p.media[x.id].libraryCharacter?.name||'',appearance:'',outfit:'',voice:'',style:p.setup.style==='Custom'?p.setup.customStyle:p.setup.style||'',sourcePrompt:x.imagePrompt,image:media.blob}});
  }
  async function useReferenceCharacter(p,x){
    if(running||busy)throw Error('Finish or stop generation before changing references.');if(autoPending?.id===p.id)await saveAutoRun({on:false});const ids=await characterLibrary({mode:'pick',max:1});if(!ids?.length)return;
    const C=await import('./lib/character-library.mjs'),[c]=await C.castSnapshot(ids);if(running||busy)throw Error('Finish or stop generation before changing references.');busy=true;
    try{await mediaWrites;if(running)throw Error('Stop generation before changing references.');const latest=(await store('getAll')).find(r=>r.id===p.id);if(!latest?.project.assets.some(a=>a.id===x.id))throw Error('Reference card no longer exists.');await attach(latest,x.id,c.image.blob,c.image.blob.type==='image/jpeg'?'jpg':c.image.blob.type.split('/')[1]);latest.media[x.id].libraryCharacter={id:c.id,name:c.name};await store('put',latest);await openProject(latest);message.textContent=c.name+' reference applied. Review the scene prompts and regenerate any scenes marked stale.';}finally{busy=false;}
  }
  async function home(initialView='templates'){
    // Paint local templates first. Optional network badges and saved media must not block this screen.
    clear();const revision=projectRenderRevision;
    let saved=[],draft=null,projects=[],backupState={},helpers=null,projectsLoading=true,projectsError='';const usagePainters=[];
    const nav=el('div',undefined,'fb-library-tabs'),controls=el('div',undefined,'fb-library-controls'),results=el('div',undefined,'fb-library-results');let view=initialView==='projects'?'projects':'templates',page=0,discovery='all';
    const templatesButton=button('▦ Templates',()=>{view='templates';page=0;search.value=category.value=type.value='';render();}),projectsButton=button('Projects · …',()=>{view='projects';page=0;search.value=category.value=type.value='';render();});const advanceButton=button('Advance',()=>{view='advance';page=0;render();});advanceButton.classList.add('fb-advance-tab');const crown=document.createElementNS('http://www.w3.org/2000/svg','svg');for(const [k,v] of Object.entries({viewBox:'0 0 24 24',width:'11',height:'11',fill:'currentColor','aria-hidden':'true'}))crown.setAttribute(k,v);const crownPath=document.createElementNS('http://www.w3.org/2000/svg','path');crownPath.setAttribute('d','M3 5l5 4 4-6 4 6 5-4-2 13H5L3 5Zm2 15h14v2H5Z');crown.append(crownPath);advanceButton.prepend(crown);advanceButton.setAttribute('aria-label','Advance · Premium');const charactersButton=button('Characters',()=>characterLibrary());charactersButton.setAttribute('aria-haspopup','dialog');const factoryButton=button('🏭 Factory',()=>factoryScreen());factoryButton.title='Overnight Auto-Factory · Pro';const videoButton=button('🎬 Video',()=>videoScreen());videoButton.title='Video → Story: rebuild a Tagalog drama from your video with Gemini';nav.append(templatesButton,projectsButton,charactersButton,factoryButton,videoButton,advanceButton);nav.setAttribute('role','tablist');
    // Compact tool row (owner 2026-11-08): one slim row of 4 tools (Motion locked until it ships), then small Projects / Characters / Advance links, so the first templates stay on screen.
    {const NS='http://www.w3.org/2000/svg',tile=(b,label,paths)=>{const icon=document.createElementNS(NS,'svg');for(const [k,v] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))icon.setAttribute(k,v);for(const d of paths){const p=document.createElementNS(NS,'path');p.setAttribute('d',d);icon.append(p);}b.replaceChildren(icon,el('span',label));b.classList.add('fb-tool-tile');return b;};
     tile(templatesButton,'AI Story',['M3 10h15v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z','M3 10 2.4 6.6 16 4l.6 3.4Z','m6.5 5.9 2.3 3','m11 5 2.3 3','M9 13l4.5 2.5L9 18Z','M20.5 2.5v4M18.5 4.5h4']);templatesButton.title='Start with a template';
     tile(videoButton,'Reverse',['M3 5h18v14H3Z','M7 5v14','M17 5v14','M3 9h4M3 15h4M17 9h4M17 15h4','M10.5 9.5l4 2.5-4 2.5Z']);
     tile(factoryButton,'Factory',['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z','M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z']);
     // Motion Studio (preview build): open it when this build has it (motion-entry.js), otherwise the tile stays locked.
     const motionReady=!!globalThis.OxMotion;const motion=tile(button('',()=>{if(motionReady){globalThis.OxMotion.open().catch(e=>error(e));return;}motion.dataset.soon='1';setTimeout(()=>{delete motion.dataset.soon;},2200);}),'Motion',['M12 3 3 7.5l9 4.5 9-4.5Z','M3 12l9 4.5 9-4.5','M3 16.5 12 21l9-4.5']);if(motionReady){motion.title='Motion Studio · Beta';motion.setAttribute('aria-label','Motion Control · Beta');}else{motion.classList.add('fb-tool-locked');motion.setAttribute('aria-disabled','true');motion.title='Motion Control · coming soon';motion.append(el('small','Soon','fb-tool-soon'));}
     const tools=el('div',undefined,'fb-tool-row'),library=el('div',undefined,'fb-resource-row');for(const [b,c] of [[templatesButton,'story'],[videoButton,'video'],[motion,'motion'],[factoryButton,'factory'],[projectsButton,'projects'],[charactersButton,'characters'],[advanceButton,'advance']])b.dataset.tone=c;tools.append(templatesButton,videoButton,motion,factoryButton);{const p=document.createElementNS(NS,'svg');for(const [k,v] of Object.entries({viewBox:'0 0 24 24',width:'12',height:'12',fill:'none',stroke:'currentColor','stroke-width':'2','stroke-linecap':'round','aria-hidden':'true'}))p.setAttribute(k,v);for(const d of ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z','M2.5 20a6.5 6.5 0 0 1 13 0','M16 4.3a3.5 3.5 0 0 1 0 6.4','M18 14.2a6.5 6.5 0 0 1 3.5 5.8']){const q=document.createElementNS(NS,'path');q.setAttribute('d',d);p.append(q);}charactersButton.prepend(p);}library.append(projectsButton,charactersButton,advanceButton);nav.replaceChildren(tools,library);nav.classList.add('fb-compact-nav');}
    const search=el('input');search.type='search';search.placeholder='Search templates…';search.setAttribute('aria-label','Search templates');
    const discoveryBar=el('div',undefined,'fb-template-discovery'),discoveryButtons=[];discoveryBar.setAttribute('role','group');discoveryBar.setAttribute('aria-label','Template groups');
    const chooseGroup=value=>{discovery=value;page=0;search.value=category.value='';render();};
    for(const {id,label,description} of TEMPLATE_GROUPS){const pick=button(label,()=>chooseGroup(id));pick.title=description||'Browse templates by group';pick.dataset.discovery=id;discoveryButtons.push([pick,id]);discoveryBar.append(pick);}
    const category=el('select');category.setAttribute('aria-label','Niche category');
    const type=el('select');type.setAttribute('aria-label','Output type');for(const [label,value] of [['All types',''],['Image','image'],['Image + Video','video']])type.append(new Option(label,value));
    let recentOnly=false;const recent=button('',()=>{recentOnly=!recentOnly;page=0;render();});recent.classList.add('fb-new-filter');recent.setAttribute('role','switch');recent.setAttribute('aria-label','New templates only');const track=el('span',undefined,'fb-switch-track');track.append(el('span',undefined,'fb-switch-thumb'));recent.append(track,el('span','New only'));const recentLabel=recent;
    const filters=el('div',undefined,'fb-library-filters');filters.append(category,type);
    const secondary=el('div',undefined,'fb-template-secondary');secondary.append(recentLabel);
    const resetFilters=button('Show all projects',()=>{search.value=category.value=type.value='';page=0;render();});
    resetFilters.classList.add('fb-filter-reset');const browseHeading=el('strong','Choose a story template','fb-browse-heading');controls.append(search,discoveryBar,secondary,filters,resetFilters);body.append(nav,controls);
    const draftSlot=el('div');draftSlot.hidden=true;body.append(draftSlot,results);
    for(const input of [search,category,type])input.addEventListener(input===search?'input':'change',()=>{page=0;render();});
    function render(){usagePainters.length=0;results.replaceChildren();search.hidden=false;search.placeholder=view==='projects'?'Search projects…':'Search templates… e.g. drama, UGC, herbal';search.setAttribute('aria-label',view==='projects'?'Search projects':'Search templates');discoveryBar.hidden=view!=='templates';browseHeading.hidden=recentLabel.hidden=view!=='templates';filters.hidden=view!=='projects';secondary.hidden=view!=='templates';recent.setAttribute('aria-checked',String(recentOnly));
      const oldCategory=category.value,groupCards=view==='templates'?templates.filter(t=>discovery==='all'||templateGroup(t)===discovery):templates;
      category.replaceChildren(new Option(view==='templates'?'All topics':'All niches',''));for(const name of [...new Set(groupCards.map(t=>nicheCategory(t.answers.niche)))].sort())category.append(new Option(name,name));category.value=oldCategory;if(!Array.from(category.children).some(o=>o.value===oldCategory))category.value='';
      for(const [pick,value] of discoveryButtons)pick.setAttribute('aria-pressed',String(discovery===value));for(const [b,v] of [[templatesButton,'templates'],[projectsButton,'projects'],[advanceButton,'advance']]){b.setAttribute('role','tab');b.setAttribute('aria-selected',String(view===v));}
      controls.hidden=view==='advance';resetFilters.hidden=view!=='projects';
      if(view==='advance'){
        const card=button('',()=>chrome.tabs.create({url:'https://kaltstein.shop/'}));card.classList.add('fb-advance-card');card.setAttribute('aria-label','Advance Drama Niche — open kaltstein.shop');
        const cover=el('div',undefined,'fb-advance-cover'),image=el('img');image.src='assets/faceless-previews/niche-013.webp';image.alt='Cinematic drama story preview';const lock=el('span',undefined,'fb-advance-lock'),lockSvg=document.createElementNS('http://www.w3.org/2000/svg','svg');for(const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.6','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))lockSvg.setAttribute(key,value);for(const d of ['M7 10V7a5 5 0 0 1 10 0v3','M5 10h14v11H5Z','M12 14v3']){const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',d);lockSvg.append(path);}lock.append(lockSvg);const premium=el('span',undefined,'fb-advance-premium');premium.append(el('span','kaltstein Premium ↗','fb-premium-pill'));cover.append(image,lock,premium,el('span','DRAMA · ADVANCE','fb-advance-badge'),el('span','↗','fb-advance-external'));
        const copy=el('div',undefined,'fb-advance-copy');copy.append(el('strong','Advance Drama Niche'),el('small','Explore advanced drama workflows and story creation.'),el('span','Explore preview ↗','fb-advance-cta'));card.append(cover,copy);results.append(card);return;
      }
      const query=search.value.trim().toLowerCase(),matches=(title,n)=>title.toLowerCase().includes(query)&&(!category.value||nicheCategory(n)===category.value);
      if(view==='templates'){
        const filtered=discoverTemplates(templates,discovery,{query,recent:recentOnly,category:category.value});
        results.append(el('small',filtered.length+' templates'+(' · '+(TEMPLATE_GROUPS.find(g=>g.id===discovery)?.label||'Search results')),'fb-muted'));
        const makeCard=t=>{const card=button('',()=>openTemplate(t,type.value));card.classList.add('fb-template');
          const coverBox=el('div',undefined,'fb-cover-box');if(t.preview){const cover=el('img',undefined,'fb-template-cover');cover.src=t.preview;cover.alt=t.title+' preview';cover.loading='lazy';cover.onerror=()=>{cover.style.visibility='hidden';};coverBox.append(cover);}const usage=templateUsage?.niches?.find(n=>n.niche===String(t.answers.niche));const badges=el('div',undefined,'fb-template-badges');
          const highlight=templateHighlight(t,usage);if(highlight)badges.append(el('span',highlight.label,'fb-card-badge fb-badge-'+highlight.kind));
          if(t.id==='ai-drama'||t.id==='anime-drama'){
            badges.replaceChildren(el('span','Any language','fb-card-badge fb-badge-language'));
            // The example-language strip stays on AI Drama only; it covered the Anime Drama artwork (owner 2026-11-08).
            if(t.id==='ai-drama'){const languages=el('div',undefined,'fb-cover-languages');languages.setAttribute('aria-label','Example languages');
            for(const [name,lang] of [['English','en'],['Español','es'],['Tiếng Việt','vi'],['日本語','ja']]){const label=el('span',name);label.lang=lang;languages.append(label);}coverBox.append(languages);}
          }
          if(badges.childElementCount)coverBox.append(badges);card.append(coverBox,el('span',nicheCategory(t.answers.niche),'fb-template-category'),el('strong',t.title));
          const meta=el('div',undefined,'fb-template-meta');meta.append(el('span',type.value==='image'?'Image':'Image + Video','fb-type-badge'),el('small',t.answers.sceneCount+' scenes · '+t.answers.language));card.append(meta);
          const count=el('small',undefined,'fb-template-usage');
          const paintUsage=()=>{const current=templateUsage?.niches?.find(n=>n.niche===String(t.answers.niche)),completed=Math.max(0,Math.floor(Number(current?.completed)||0)),starCount=Math.floor(completed/100);count.replaceChildren();if(!['ai-drama','anime-drama'].includes(t.id)){const next=templateHighlight(t,current);badges.replaceChildren(...(next?[el('span',next.label,'fb-card-badge fb-badge-'+next.kind)]:[]));if(next&&!badges.parentNode)coverBox.append(badges);}
          count.append(el('span',templateUsage?completed.toLocaleString()+' stories created':'Usage unavailable','fb-template-usage-label'));
          count.title='Recorded completed story/part builds across this niche. Excludes internal tests, suggestions, failures and cancellations. Historical records may be incomplete.';
          if(templateUsage&&starCount){const stars=el('span','★'.repeat(Math.min(10,starCount))+(starCount>10?' +'+(starCount-10):''),'fb-template-stars');stars.title=starCount+' milestone '+(starCount===1?'star':'stars')+' · one for every 100 completed stories';stars.setAttribute('role','img');stars.setAttribute('aria-label',stars.title);count.append(stars);}};paintUsage();usagePainters.push(paintUsage);card.append(count);return card;
        };
        const gallery=el('div',undefined,'fb-gallery');for(const t of filtered)gallery.append(makeCard(t));results.append(gallery);
        if(!filtered.length)results.append(el('p','No matching templates. Try another search, choose All or turn off New only.','fb-muted'));results.append(button('Customize everything',()=>{quick=false;activeTemplate=null;target=null;answers={};step=0;wizard();}));
      }else{
        if(projectsLoading){results.append(el('p','Loading saved projects…','fb-muted'));return;}
        if(projectsError){results.append(el('p',projectsError,'fb-message'),button('Try again',()=>home('projects')));return;}
        const filtered=projects.filter(p=>{const title=p.project?.title||catalog.find(n=>n.id===Number(p.setup?.niche))?.name||'Video project';const image=p.setup?.exportProfile==='Image prompts only'||p.setup?.imageMode==='Prompts only';return matches(title,p.setup?.niche)&&(!type.value||(type.value==='image')===image);});
        const list=el('div',undefined,'fb-project-list');for(const p of filtered.slice(page*5,page*5+5)){const row=el('div',undefined,'fb-project-row'),info=el('div',undefined,'fb-project-info');const title=userText('strong',p.project?.title||catalog.find(n=>n.id===Number(p.setup?.niche))?.name||'Video project');title.title=title.textContent;const status=projectStatus(p,saved),meta=el('div',undefined,'fb-project-meta');meta.append(el('span',status.label,status.completed?'fb-project-completed':'fb-project-state'),el('small',new Date(p.createdAt).toLocaleDateString()));info.append(title,meta);const remove=button('',()=>deleteProject(p));remove.classList.add('fb-project-delete');const trash=document.createElementNS('http://www.w3.org/2000/svg','svg');for(const [key,value] of Object.entries({viewBox:'0 0 24 24',width:'16',height:'16',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))trash.setAttribute(key,value);for(const d of ['M3 6h18','M9 6V4h6v2','M5 6l1 14h12l1-14','M10 10v6','M14 10v6']){const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',d);trash.append(path);}remove.append(trash);remove.title='Delete project';remove.setAttribute('aria-label','Delete '+title.textContent);row.append(info,button('Open →',()=>openProject(seriesParts(saved,p.id).at(-1)||p)),remove);list.append(row);}results.append(list);
        results.append(el('small',filtered.length+' of '+projects.length+' saved projects shown','fb-muted'));
        // Owner 2026-10-29: projects live only in this browser; after every 5 finished stories, offer a backup file.
        const due=helpers?.backupDue(saved,backupState.projectBackupCount)||0;
        if(due){const card=el('div',undefined,'fb-card fb-backup-reminder'),row=el('div',undefined,'fb-actions'),remember=async()=>{backupState.projectBackupCount=due;await chrome.storage.local.set({projectBackupCount:due});card.remove();};
          card.append(el('strong','Back up your '+due+' finished stories'),el('small','They are saved only in this browser. Removing the extension, another Chrome profile or clearing browsing data erases them. Restore later in Settings → Storage.','fb-muted'));
          row.append(button('Back up now',async()=>{const narrations=await import('./lib/story-workspace.mjs').then(W=>W.backupNarrations()).catch(()=>[]);const packed=await (await import('./lib/project-backup.mjs')).packBackup(await store('getAll'),Date.now(),narrations);const url=URL.createObjectURL(new Blob([JSON.stringify(packed)],{type:'application/json'}));await chrome.downloads.download({url,filename:'0xtnp-project-backup.json',saveAs:true});setTimeout(()=>URL.revokeObjectURL(url),60000);await remember();}),button('Later',remember));
          card.append(row);results.append(card);}if(!filtered.length)results.append(el('p',projects.length?'Saved projects are hidden by your filters. Choose Show all projects.':'No saved projects in this Chrome profile. Restore a backup in Settings → Storage, or check your original browser profile.','fb-muted'));
        if(filtered.length>5){const pager=el('div',undefined,'fb-project-pager'),prev=button('←',()=>{page--;render();}),next=button('→',()=>{page++;render();});prev.disabled=page===0;next.disabled=(page+1)*5>=filtered.length;prev.setAttribute('aria-label','Previous projects');next.setAttribute('aria-label','Next projects');pager.append(prev,el('small',(page*5+1)+'–'+Math.min(page*5+5,filtered.length)+' of '+filtered.length),next);results.append(pager);}
      }
    }render();
    const stillHere=()=>revision===projectRenderRevision;
    // One request per panel, sharing in-flight work. Keep cached counts on failure.
    if(initialView!=='projects'&&(templateUsagePending||Date.now()-templateUsageFetched>60000)){
      if(!templateUsagePending){
        templateUsageFetched=Date.now();
        templateUsagePending=request('/builder/usage').then(value=>{templateUsage=value;}).catch(()=>{}).finally(()=>{templateUsagePending=null;});
      }
      templateUsagePending.then(()=>{if(stillHere()&&view==='templates')for(const paint of usagePainters)paint();});
    }
    const loadProjects=(async()=>{
      try{
        const records=await store('getAll');if(!stillHere())return;
        saved=records;draft=saved.find(x=>x.id==='draft');
        const ids=new Set(saved.map(x=>x.id));
        projects=saved.filter(x=>x.id!=='draft'&&(!x.parentProjectId||!ids.has(x.parentProjectId))).sort((a,b)=>b.createdAt-a.createdAt);
        projectsButton.textContent='Projects · '+projects.length;
        if(draft){draftSlot.hidden=false;draftSlot.append(button('Resume setup',()=>{answers=draft.answers;quick=Boolean(draft.quick);activeTemplate=templates.find(t=>t.id===draft.templateId)||null;target=draft.target||null;step=Math.min(draft.step,B.steps(answers).length);if(quick)return completeQuick();wizard();}));}
      }catch(e){if(stillHere()){projectsError='Could not load saved projects. Please try again.';projectsButton.textContent='Projects';console.warn('Project list:',e);}}
      finally{if(stillHere()){projectsLoading=false;if(view==='projects')render();}}
    })();
    Promise.all([
      typeof chrome!=='undefined'&&chrome.storage?.local?chrome.storage.local.get('projectBackupCount').catch(()=>({})):{},
      import('./lib/story-helpers.mjs').catch(()=>null)
    ]).then(([state,module])=>{if(!stillHere())return;backupState=state;helpers=module;if(view==='projects'&&!projectsLoading)render();}).catch(()=>{});
    if(initialView==='projects')await loadProjects;
  }
  async function openTemplate(template,exportType){
    await window.FlowGoogleSignIn?.refresh?.();
    const account=window.FlowGoogleSignIn?.current?.();
    if(account?.signedIn&&account.builder?.remaining===0)throw Error('Daily builder limit reached. Your story allowance is used up. New stories and idea suggestions are unavailable until it resets.');
    quick=true;activeTemplate=template;target={...template.target};answers={...template.answers};
    if(exportType==='image')answers.exportProfile='Image prompts only';step=0;topic();
  }
  async function saveDraft(){await store('put',{id:'draft',answers,step,quick,templateId:activeTemplate?.id,target});}
  async function saveChosenIdea(suggestionId){
    const d=await db();
    await new Promise((resolve,reject)=>{
      const tx=d.transaction('projects','readwrite'),projects=tx.objectStore('projects');
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Could not save your chosen idea.'));
      projects.put({id:'draft',answers,step,quick,templateId:activeTemplate?.id,target});
      projects.delete(suggestionId);
    });
  }
  async function ugcSetup(){
    const U=await import('./lib/ugc-product.mjs');answers=U.defaults(answers);const draftAnswers=answers;quick=true;
    clear();body.append(el('h3','UGC Product Ad'),el('p','Add your product and its real benefits. We build a short ad from your facts.','fb-muted'));
    // Compact layout (owner 2026-10-27: the setup was too long): numbered sections, two-column choices, optional fields folded.
    const section=title=>{const sec=el('section',undefined,'fb-ugc-sec');sec.append(el('h4',title));body.append(sec);return sec;},grid=into=>{const g=el('div',undefined,'fb-ugc-grid');into.append(g);return g;};
    const productSec=section('1 · Product');
    // Upload card (owner 2026-10-27: the bare file input looked unfinished; show the photo once chosen). Click or drop a file.
    const drop=el('label',undefined,'fb-upload'),file=el('input');file.type='file';file.accept='image/png,image/jpeg,image/webp';file.setAttribute('aria-label','Product image');
    const thumb=el('div',undefined,'fb-upload-thumb'),info=el('div',undefined,'fb-upload-info'),title=el('strong','Product image · required'),imageStatus=el('small',answers.ugcProductImage?'Product image saved for this setup.':'PNG, JPG or WEBP · up to 15 MB'),action=el('span','Choose photo','fb-upload-action');
    info.append(title,imageStatus,action);drop.append(file,thumb,info);productSec.append(drop);
    let thumbUrl=null;const showThumb=blob=>{if(thumbUrl)URL.revokeObjectURL(thumbUrl);thumb.textContent='';if(!blob){thumb.textContent='＋';drop.classList.remove('has-image');return;}const img=el('img');img.alt='Uploaded product';thumbUrl=URL.createObjectURL(blob);img.src=thumbUrl;thumb.append(img);drop.classList.add('has-image');action.textContent='Change photo';};
    showThumb(answers.ugcProductImage?.blob||null);
    drop.ondragover=e=>{e.preventDefault();drop.classList.add('drag');};drop.ondragleave=()=>drop.classList.remove('drag');
    drop.ondrop=e=>{e.preventDefault();drop.classList.remove('drag');const f=e.dataTransfer?.files?.[0];if(!f)return;const dt=new DataTransfer();dt.items.add(f);file.files=dt.files;file.onchange();};
    const fields=new Map(),rows=new Map();let uploadingProduct=false;
    const field=(key,label,options=null,into=body)=>{const row=el('label',label),input=el(options?'select':['ugcDescription','ugcPresenter'].includes(key)?'textarea':'input');if(!options&&input.tagName==='INPUT')input.type='text';if(options)for(const option of options)input.append(new Option(...(Array.isArray(option)?option:[option,option])));else{input.rows=key==='ugcDescription'?3:2;input.maxLength=key==='ugcProductName'?120:key==='ugcDescription'?4000:1500;}input.value=answers[key]||'';input.setAttribute('aria-label',label);row.append(input);fields.set(key,input);rows.set(key,row);into.append(row);return input;};
    field('ugcProductName','Product name · required',null,productSec);field('ugcDescription','What does it do? Main benefits · required',null,productSec);
    const videoSec=section('2 · Video'),videoGrid=grid(videoSec);
    field('format','Video format',U.FORMATS,videoGrid);field('ugcVoice','Voice',['Male','Female'],videoGrid);
    field('language','Language',B.LANGUAGES,videoGrid);field('sceneDuration','Scene length',['8','10','15','20','30'],videoGrid);
    field('sceneCount','Scenes',['3','5','6','8','10'],videoGrid);field('customLanguage','Which language?',null,videoGrid);
    field('ugcPresenter','Describe your original adult presenter · optional',null,videoSec);
    // Owner 2026-11-01 (user request): an optional saved character from the library as the presenter. Their picture becomes
    // the presenter reference, so face, age and hair stay; without one, every ad gets a new presenter as before.
    const castBox=el('div',undefined,'fb-card fb-ugc-cast');videoSec.append(castBox);
    const paintCast=async()=>{const ids=(answers.characterIds||[]).slice(0,1);let who=null;if(ids.length)try{who=(await (await import('./lib/character-library.mjs')).castSnapshot(ids))[0];}catch{answers.characterIds=[];}
      castBox.replaceChildren(el('strong','Use your own character · optional'),el('small',who?'Presenter: '+who.name+'. Their face, age and hair come from your saved picture; clothes fit the product. Pick the Voice that matches them.':'Pick a saved character as the presenter. Leave empty for a new presenter in every ad.'));
      const row=el('div',undefined,'fb-actions');row.append(button(who?'Change character':'Choose character',async()=>{const picked=await characterLibrary({mode:'pick',selectedIds:who?[who.id]:[],max:1});if(picked===null)return;collect();answers.characterIds=picked.slice(0,1);delete answers.requestId;await saveDraft();await paintCast();}));
      if(who)row.append(button('Remove',async()=>{collect();answers.characterIds=[];delete answers.requestId;await saveDraft();await paintCast();}));castBox.append(row);};
    paintCast().catch(error);
    const lookSec=section('3 · Look'),lookGrid=grid(lookSec);
    field('ugcTheme','Ad theme',B.steps(answers).find(x=>x.key==='ugcTheme').options,lookGrid);
    field('ugcLocation','Location',B.steps(answers).find(x=>x.key==='ugcLocation').options,lookGrid);field('ugcCustomLocation','Describe the location',null,lookSec);
    const more=el('details',undefined,'fb-ugc-sec fb-ugc-more');more.append(el('summary','4 · Optional: audience, offer, call to action'));body.append(more);
    if(answers.ugcAudience||answers.ugcOffer||answers.ugcCTA)more.open=true;
    field('ugcAudience','Target audience · optional',null,more);field('ugcOffer','Price or offer · optional',null,more);field('ugcCTA','Where to buy / call to action · optional',null,more);
    const updateVisibility=()=>{for(const [key,show] of [['customLanguage',fields.get('language').value==='Custom'],['ugcCustomLocation',fields.get('ugcLocation').value==='Custom'],['ugcPresenter',fields.get('format').value==='Character host and B-roll']]){rows.get(key).hidden=!show;rows.get(key).style.display=show?'':'none';}castBox.hidden=fields.get('format').value!=='Character host and B-roll';};
    const collect=()=>{const before=JSON.stringify([...fields.keys()].map(key=>answers[key]||''));for(const [key,input] of fields)answers[key]=input.value.trim();answers.topic='Product ad: '+(answers.ugcProductName||'your product');if(before!==JSON.stringify([...fields.keys()].map(key=>answers[key]||'')))delete answers.requestId;updateVisibility();};
    for(const input of fields.values())input.onchange=()=>{collect();saveDraft().catch(error);};updateVisibility();
    file.onchange=async()=>{uploadingProduct=true;try{const selected=file.files?.[0];if(!selected)return;U.validateProductImage(selected);const bitmap=await createImageBitmap(selected);bitmap.close();const media=await U.productMedia(selected);if(answers!==draftAnswers)return;answers.ugcProductImage=media;delete answers.requestId;await saveDraft();imageStatus.textContent='Product image saved: '+selected.name;showThumb(media.blob||selected);}catch(e){file.value='';error(e);}finally{uploadingProduct=false;}};
    body.append(el('small','Product appearance follows your image. Exact label lettering may need an editing overlay.','fb-muted'));
    const ugcActions=el('div',undefined,'fb-actions fb-ugc-actions');body.append(ugcActions);ugcActions.append(button('Generation platforms',async()=>{collect();await saveDraft();platformEditor();}),button('Back to templates',async()=>{collect();await saveDraft();await home();}),button('Create video package',async()=>{if(uploadingProduct)throw Error('Wait for the product image to finish saving.');collect();B.validateSetup(answers);if(!answers.ugcProductImage?.blob)throw Error('Upload your product image first.');await saveDraft();await submit();}));
  }
  function isProductReference(p,id){return Number(p.setup?.niche)===56&&id==='asset_001';}
  function topic(){if(Number(answers.niche)===56)return ugcSetup();clear();body.append(el('small',activeTemplate?.title||'Your template'),el('h3','What is the video about?'));const input=el('textarea');input.rows=4;input.maxLength=24000;input.value=answers.topic||'';input.placeholder=Number(answers.niche)===57?'Describe the body concern to explain first, then the food, herbal or everyday wellness tip. Include source notes for health claims and any presenter or setting preferences.':'For example: a small act of kindness changes someone’s day';input.setAttribute('aria-label','What is the video about?');body.append(input);const actions=el('div',undefined,'fb-actions');actions.append(button('Back',home),button('Suggest 5 topics',async()=>{answers.topicMode='Suggest five ideas';answers.topic=input.value.trim()||'Suggest five concrete, engaging ideas for this template.';delete answers.requestId;await completeQuick();if(step===B.steps(answers).length)await submit();}),button('Continue',async()=>{if(!input.value.trim())throw Error('Enter your topic first.');answers.topicMode='Existing topic';answers.topic=input.value.trim();delete answers.requestId;await completeQuick();}));body.append(actions);input.focus();}
  async function completeQuick(){const list=B.steps(answers);step=list.findIndex(s=>!String(answers[s.key]||'').trim()||(s.options&&!s.options.includes(answers[s.key])));if(step<0)step=list.length;await saveDraft();if(step<list.length)wizard();else quickSummary();}
  function editAnswer(key){const list=B.steps(answers);step=list.findIndex(s=>s.key===key);if(step<0)throw Error('This style is locked by the selected niche. Choose another template to change it.');wizard();}
  // Story types (owner 2026-10-25): a long series is 3 or 4 parts of 10-18 scenes, planned as one story by the server.
  // Paid Pro only (Google or Discord with a paid plan; the server checks it too): others see the buttons with a Pro tag
  // and get the Upgrade popup.
  const STORY_TYPES=[['1','Standalone story'],['2','Series · 2 parts'],['3','Series · 3 parts'],['long-3','Long series · 3 parts'],['long-4','Long series · 4 parts']];
  const paidPro=()=>window.FlowGoogleSignIn?.current?.()?.plan==='pro';
  const storyTypeOf=a=>a.seriesLength==='long'?'long-'+(a.partsTotal||3):String(a.partsTotal||1);
  function setStoryType(value){
    const long=value.startsWith('long-');
    if(long&&!paidPro()){if(typeof showUpgradePopup==='function')showUpgradePopup(UPGRADE_POPUPS.series);return false;}
    answers.partsTotal=long?value.slice(5):value;
    if(long)answers.seriesLength='long';else delete answers.seriesLength;
    // Scene choices differ (long: 10-18 per part): keep the count when it still fits, else 12 for long or the template's own.
    const options=B.steps(answers).find(s=>s.key==='sceneCount').options,fallback=activeTemplate?.answers?.sceneCount;
    if(!options.includes(answers.sceneCount))answers.sceneCount=long?'12':options.includes(fallback)?fallback:options.at(-1);
    delete answers.requestId;return true;
  }
  function quickSummary(){if(Number(answers.niche)===56)return ugcSetup();clear();body.append(el('small',activeTemplate?.title||'Your template'),el('h3','Your video, ready to write'),userText('p',answers.topic));const chips=el('div',undefined,'fb-actions');
    if(B.isDrama(answers.niche)){const choice=el('div',undefined,'fb-story-type');choice.append(el('strong','Story type'));const options=el('div',undefined,'fb-actions');for(const [value,label] of STORY_TYPES){const pick=button(label,async()=>{if(!setStoryType(value))return;await saveDraft();quickSummary();});if(value.startsWith('long-')&&!paidPro())pick.append(el('span','PRO','fb-pro-tag'));pick.setAttribute('aria-pressed',String(storyTypeOf(answers)===value));options.append(pick);}choice.append(options,el('small','Standalone: one complete story with an ending. Series: Part 1 ends on a cliffhanger; continue with Part 2 later. Long series: 3 or 4 parts of up to 18 scenes each, planned as one story.','fb-muted'));body.append(choice);}
    // Workflow chip cycles three ways (owner 2026-10-16): Reference images first -> Direct scene frames -> Ingredients to Video.
    // Ingredients to Video = the existing 'Recurring assets + video' mode: only character/location references are made, no
    // scene images, and the rulebook writes Section 7B ingredients (Veo) video prompts.
    const ingredients=answers.exportProfile==='Recurring assets + video',workflowLabel=ingredients?'Ingredients to Video':(answers.imageWorkflow||'Reference images first');
    if(Number(answers.niche)===57)chips.append(el('span','Workflow · Reference images first','fb-muted'));else chips.append(button('Workflow · '+workflowLabel,async()=>{if((answers.characterIds||[]).length&&!ingredients){answers.exportProfile='Recurring assets + video';answers.imageWorkflow='Reference images first';}else if(ingredients){answers.exportProfile='Scene image + video';answers.imageWorkflow='Reference images first';}else if(answers.imageWorkflow==='Direct scene frames'){answers.exportProfile='Recurring assets + video';answers.imageWorkflow='Reference images first';}else{answers.exportProfile=answers.exportProfile==='Image prompts only'?answers.exportProfile:'Scene image + video';answers.imageWorkflow='Direct scene frames';}delete answers.requestId;await saveDraft();quickSummary();}));
    for(const [key,label] of [['language','Language'],['sceneDuration','Scene length'],['sceneCount','Scenes'],['style','Style']])chips.append(button(label+' · '+(answers[key]||'Niche default')+(key==='sceneDuration'?'s':''),()=>editAnswer(key)));
    // AI Drama: the country decides names, faces, places and customs (Auto = the main country of the language).
    if(Number(answers.niche)===61)chips.append(button('Story world · '+(answers.animeStory||'Auto'),()=>editAnswer('animeStory')));   // Anime Drama v2 (owner 2026-11-08)
    if(B.isWorldDrama(answers.niche))chips.append(button('Country · '+(answers.dramaCountry==='Custom'?answers.customCountry||'Custom':answers.dramaCountry==='Auto (match the language)'||!answers.dramaCountry?'Auto · '+B.storyCulture({...answers,dramaCountry:'Auto (match the language)'}):answers.dramaCountry),()=>editAnswer('dramaCountry')));
    // Stick Figure Explainer: switch between the clothed cartoon and the classic white line figure (owner 2026-10-31).
    if(Number(answers.niche)===60)chips.append(button('Stick figure · '+(answers.stickFigure||'Clothed cartoon'),async()=>{answers.stickFigure=answers.stickFigure==='Classic line'?'Clothed cartoon':'Classic line';await saveDraft();quickSummary();}));
    if(Number(answers.niche)===57)for(const [key,label] of [['kitchenMode','Video type'],['kitchenVoice','Presenter voice']])chips.append(button(label+' · '+answers[key],()=>editAnswer(key)));
    if(narrationPilot&&narrationUsedUp&&B.narrationEligible?.(answers))chips.append(el('span','Audio · Original video audio (AI narration is used up this month)','fb-muted'));
    if(narrationPilot&&B.narrationEligible?.(answers))checkNarration().then(changed=>{if(changed&&chips.isConnected)quickSummary();});
    if(narrationOn(answers))chips.append(button('Audio · '+(answers.narration==='AI narrator'?'AI narrator':'Original video audio'),async()=>{answers.narration=answers.narration==='AI narrator'?'Original video audio':'AI narrator';delete answers.requestId;await saveDraft();quickSummary();}));
    chips.append(button('Platforms · '+B.generationTargets(target,settings).imagePlatform+' images · '+B.generationTargets(target,settings).videoPlatform+' videos',()=>platformEditor()));body.append(chips,el('p',`${answers.seriesLength==='long'?`${answers.sceneCount} scenes per part · ${answers.partsTotal} parts · about ${Math.round(Number(answers.sceneCount)*Number(answers.sceneDuration)*Number(answers.partsTotal)/60)} minutes in all. Part 1 is written first; continue with the next part when it is finished.`:`${Number(answers.sceneCount)*Number(answers.sceneDuration)} seconds · ${answers.sceneCount} scenes.`} ${ingredients?'Ingredients to Video: character and location references only, no scene images; each video uses them as ingredients. ':''}Creates prompts first; generation starts only when you choose to run it.`,'fb-muted'));
    body.append(castSetupButton());{const hooks=hookCard();if(hooks)body.append(hooks);}const actions=el('div',undefined,'fb-actions');actions.append(button('Edit topic',topic),button(answers.topicMode==='Suggest five ideas'?'Suggest 5 topics':'Create video package',submit),button('Customize everything',()=>{quick=false;step=0;wizard();}));body.append(actions);
  }
  // Google Vids makes story videos only (owner 2026-11-14): its images cannot follow a character picture.
  // Higgsfield makes story videos too (owner 2026-11-17), with each scene's own length.
  const STORY_VIDEO_PLATFORMS=['flow','gemini','grok','vids','higgsfield'],platformIcon=x=>'assets/platforms/'+x+(x==='vids'?'.svg':'.png');
  const PLATFORM_NAMES={flow:'Flow',gemini:'Gemini',chatgpt:'ChatGPT',grok:'Grok',vids:'Google Vids',higgsfield:'Higgsfield'};
  // Owner 2026-11-14: platform boxes stay one line, the same size; the Vids box says "Vids" (full name on hover).
  const PILL_NAMES={...PLATFORM_NAMES,vids:'Vids',higgsfield:'Higgs'};
  // Lengths each video engine can make for this story (B.videoPlan checks the same when videos are loaded).
  function storyLengthCheck(platform,p,model){const n=Number(p?.setup?.sceneDuration);
    if(n>15&&platform!=='higgsfield')throw Error('This story uses '+n+'s scenes. Only Higgsfield makes videos that long.');
    if(platform==='vids'&&!(Number.isInteger(n)&&n>=3&&n<=15))throw Error('Google Vids makes 3–15 second videos. This story uses '+n+'s scenes.');
    if(n===15&&platform==='gemini')throw Error('This story uses 15s scenes. Choose Flow with Omni 1.2 Flash, Grok, Google Vids or Higgsfield.');
    if(n===15&&platform==='flow'&&B.currentFlowModel(model||'')!=='Omni 1.2 Flash')throw Error('This story uses 15s scenes. In Flow choose Omni 1.2 Flash, or pick Grok, Google Vids or Higgsfield.');}
  async function higgsStoryAccess(platform){if(platform==='higgsfield'&&typeof ensureHiggsAccess==='function'&&!await ensureHiggsAccess())throw Error('Allow Higgsfield access before choosing Higgsfield.');}
  function quickPlatforms(p,images,videos,onChange){
    const chosen=B.generationTargets(p.target,settings),box=el('div',undefined,'fb-quick-platforms');box.setAttribute('aria-label','Generation platforms');
    const names=PLATFORM_NAMES;
    const save=async change=>{
      if(running)throw Error('Stop generation before changing platforms.');
      const picked={...chosen,...change};
      if(change.videoPlatform==='grok'&&typeof ensureGrokAccess==='function'&&!await ensureGrokAccess())throw Error('Allow Grok access before choosing Grok.');
      await higgsStoryAccess(change.videoPlatform);
      if('videoPlatform' in change||'model' in change)storyLengthCheck(picked.videoPlatform,p,picked.model);
      const duration=Number(p.setup?.sceneDuration);
      if(picked.videoPlatform==='flow'&&/^veo/i.test(picked.model||'')&&duration!==8)throw Error('This story uses '+duration+'s scenes. Select Flow Omni, Gemini or Grok; Veo needs 8s scenes.');
      p.target=picked;Object.assign(chosen,picked);await store('put',p);paint();onChange?.();
    };
    let modelPick=null;const paint=()=>{for(const b of box.querySelectorAll('button[data-key]'))b.setAttribute('aria-pressed',String(chosen[b.dataset.key]===b.dataset.platform));for(const b of box.querySelectorAll('button[data-shape]'))b.setAttribute('aria-pressed',String((b.dataset.shape==='16:9')===!!globalThis.StoryShape?.isLandscape(p)));if(modelPick)modelPick.hidden=chosen.videoPlatform!=='flow';};
    // Shape (owner 2026-11-10): vertical 9:16 or wide 16:9 for this story's pictures and videos.
    const saveShape=async value=>{
      if((value==='16:9')===!!globalThis.StoryShape?.isLandscape(p))return;
      if(running)throw Error('Stop generation before changing the shape.');
      if(value==='16:9'){p.aspect='16:9';if(p.sceneImageMode==='sheets')p.sceneImageMode='single';}else delete p.aspect;
      await store('put',p);body.classList.toggle('fb-wide',!!globalThis.StoryShape?.isLandscape(p));paint();onChange?.();
      message.textContent=Object.keys(p.media||{}).length?'Pictures and videos already made keep their shape. Use Redo to make them again in the new shape.':'';
    };
    const rows=[];if(images)rows.push(['imagePlatform','Images',['gemini','chatgpt','flow','grok']]);if(videos)rows.push(['videoPlatform','Videos',STORY_VIDEO_PLATFORMS]);
    for(const [key,label,platforms] of rows){
      const row=el('div',undefined,'fb-quick-row'),group=el('div',undefined,'fb-quick-pills');row.append(el('span',label,'fb-quick-label'),group);group.setAttribute('role','group');group.setAttribute('aria-label',label+' platform');
      for(const platform of platforms){const pick=button('',()=>chosen[key]===platform?null:save({[key]:platform}));pick.dataset.key=key;pick.dataset.platform=platform;const icon=el('img');icon.src=platformIcon(platform);icon.alt='';pick.append(icon,el('span',PILL_NAMES[platform]));pick.title=names[platform];pick.disabled=running;group.append(pick);}
      if(key==='videoPlatform'){
        const model=el('select');model.setAttribute('aria-label','Flow video model');for(const name of B.flowVideoModels())model.append(new Option(B.flowModelLabel(name),name));
        if(chosen.model&&!Array.from(model.options).some(x=>x.value===chosen.model))model.append(new Option(chosen.model,chosen.model));
        model.value=chosen.model||B.currentFlowModel('Omni 1.1 Flash');model.disabled=running;
        model.onchange=()=>save({model:model.value}).catch(e=>{model.value=chosen.model||B.currentFlowModel('Omni 1.1 Flash');error(e);});modelPick=model;group.append(model);
      }
      box.append(row);
    }
    {const row=el('div',undefined,'fb-quick-row'),group=el('div',undefined,'fb-quick-pills');row.append(el('span','Shape','fb-quick-label'),group);group.setAttribute('role','group');group.setAttribute('aria-label','Picture and video shape');
      for(const [value,label] of [['9:16','Vertical 9:16'],['16:9','Wide 16:9']]){const pick=button(label,()=>saveShape(value));pick.dataset.shape=value;pick.disabled=running;group.append(pick);}
      box.append(row);}
    paint();return box;
  }
  function platformEditor(p=null){
    if(running)throw Error('Finish or stop generation before changing platforms.');
    clear();body.append(el('h3','Generation platforms'));const chosen=B.generationTargets(p?p.target:target,settings),panel=el('div',undefined,'fb-platform-panel');
    const models=el('label','Flow video model'),model=el('select');for(const name of B.flowVideoModels())model.append(new Option(B.flowModelLabel(name),name));if(chosen.model&&!Array.from(model.options).some(x=>x.value===chosen.model))model.append(new Option(chosen.model,chosen.model));model.value=chosen.model||B.currentFlowModel('Omni 1.1 Flash');models.append(model);
    for(const [key,label,platforms] of [['imagePlatform','Images',['gemini','chatgpt','flow','grok']],['videoPlatform','Videos',STORY_VIDEO_PLATFORMS]]){
      const row=el('div',undefined,'fb-platform-row'),group=el('div',undefined,'fb-platform-options');row.append(el('strong',label),group);group.setAttribute('role','group');group.setAttribute('aria-label',label+' platform');
      for(const platform of platforms){const pick=button('',()=>{chosen[key]=platform;for(const b of group.children)b.setAttribute('aria-pressed',String(b===pick));models.hidden=chosen.videoPlatform!=='flow';});const icon=el('img');icon.src=platformIcon(platform);icon.alt='';pick.append(icon,el('span',PILL_NAMES[platform]));pick.title=PLATFORM_NAMES[platform];pick.setAttribute('aria-pressed',String(chosen[key]===platform));group.append(pick);}panel.append(row);
    }
    models.hidden=chosen.videoPlatform!=='flow';panel.append(models);const hint=el('small','Images and videos use separate platforms. Your saved story and images stay unchanged.','fb-muted');panel.append(hint);body.append(panel);
    const actions=el('div',undefined,'fb-actions');actions.append(button('Cancel',()=>p?openProject(p):quickSummary()),button('Save platforms',async()=>{if(running)throw Error('Stop generation before changing platforms.');if(chosen.videoPlatform==='grok'&&typeof ensureGrokAccess==='function'&&!await ensureGrokAccess())throw Error('Allow Grok access before saving this platform.');await higgsStoryAccess(chosen.videoPlatform);chosen.model=model.value;const duration=Number((p?p.setup:answers).sceneDuration);storyLengthCheck(chosen.videoPlatform,{setup:{sceneDuration:duration}},chosen.model);if(chosen.videoPlatform==='flow'&&/^veo/i.test(chosen.model)&&duration!==8)throw Error('This story uses '+duration+'s scenes. Select Flow Omni, Gemini or Grok; Veo needs 8s scenes.');if(p){p.target={...chosen};await store('put',p);await openProject(p);}else{target={...chosen};delete answers.requestId;await saveDraft();quickSummary();}}));body.append(actions);
  }
  // Tagalog Drama lists only Tagalog and English; a setup saved earlier with another language keeps it as a choice.
  const languageChoices=(niche,current)=>{const list=B.languagesFor(niche);return current&&!list.includes(current)&&B.LANGUAGES.includes(current)?[...list,current]:list;};
  function wizard(){
    if(Number(answers.niche)===56)return ugcSetup();
    clear();const steps=B.steps(answers),s=steps[step];if(!s)return reviewSetup();
    body.append(el('small',quick?'A detail for '+(activeTemplate?.title||'your template'):`Guided setup · ${step+1} of ${steps.length}`),el('h3',s.label));
    let input;
    if(s.type==='text'){input=el('textarea');input.rows=6;input.maxLength=24000;input.placeholder='Enter your answer…';}
    else {input=el('select');input.append(new Option('Choose…',''));for(const option of s.type==='niche'?catalog.map(n=>[n.name,String(n.id)]):s.key==='partsTotal'?STORY_TYPES.map(([value,label])=>[label+(value.startsWith('long-')&&!paidPro()?' (Pro)':''),value]):s.key==='language'?languageChoices(answers.niche,answers.language).map(x=>[x,x]):s.options.map(x=>[x,x]))input.append(new Option(...option));}
    input.value=s.key==='partsTotal'?storyTypeOf(answers):answers[s.key]||(s.key==='topic'&&answers.topicMode==='Suggest five ideas'?'Suggest five beginner-friendly ideas for this niche.':'');input.setAttribute('aria-label',s.label);body.append(input);
    // AI Drama: a chosen country also switches the language to its main one; the Language button still changes it after.
    if(s.key==='dramaCountry'){const note=el('p','','fb-muted'),show=()=>{const language=B.countryLanguage(input.value);note.textContent=language?'The language switches to '+language+'. You can still change it after with the Language button.':input.value==='Custom'?'Type the country next. The language stays '+(answers.language==='Custom'?answers.customLanguage||'Custom':answers.language)+'; change it with the Language button.':'Auto: the story is set in the main country of the language you chose.';};input.addEventListener('change',show);show();body.append(note);}
    if(s.key==='format')body.append(el('p','Hands-only works well for processes. Use B-roll for explainers, a host for character niches, or cinematic story for narratives.','fb-muted'));
    const actions=el('div',undefined,'fb-actions');actions.append(button('Back',async()=>{if(s.key!=='partsTotal')answers[s.key]=input.value;if(step>0){step--;await saveDraft();wizard();}else home();}),button('Continue',async()=>{if(!input.value.trim())throw Error('Choose an answer to continue.');
      // Story type also sets seriesLength and may change the scene choices (long series: 10-18 per part).
      if(s.key==='partsTotal'){if(storyTypeOf(answers)!==input.value&&!setStoryType(input.value))return;}
      else{if(answers[s.key]!==input.value.trim()){delete answers.requestId;if(s.key==='topicMode')delete answers.topic;if(s.key==='dramaCountry'&&B.countryLanguage(input.value.trim()))answers.language=B.countryLanguage(input.value.trim());}answers[s.key]=input.value.trim();}const remaining=B.steps(answers);step++;while(quick&&step<remaining.length&&answers[remaining[step].key]&&(!remaining[step].options||remaining[step].options.includes(answers[remaining[step].key])))step++;await saveDraft();wizard();}));body.append(actions);input.focus();
  }
  function reviewSetup(){
    if(quick)return quickSummary();
    clear();body.append(el('h3','Ready to write your video?'));
    for(const s of B.steps(answers)){const row=el('div',undefined,'fb-card');row.append(el('small',s.label),el('p',s.key==='niche'?catalog.find(n=>String(n.id)===answers.niche)?.name:answers[s.key]),button('Edit',()=>{step=B.steps(answers).findIndex(x=>x.key===s.key);wizard();}));body.append(row);}
    body.append(castSetupButton());{const hooks=hookCard();if(hooks)body.append(hooks);}body.append(el('p','Creates prompts only. Image and video generation starts when you load and run a queue.','fb-muted'),button('Build scene prompts',submit));
  }
  // A story's setup notes without what earlier requests added: the idea request's avoid list, and the image, hook and cast-name
  // lines submit() adds again. Picking a suggested idea carried the avoid list (up to 1,500 characters) into the story, so a
  // saved character no longer fit ("Cast notes exceed the story setup space", user report 2026-11-03).
  function storyContext(text){return String(text||'').split('\nSuggest genuinely new stories')[0].split('\n').filter(l=>!/^(Image workflow: |OPENING HOOK chosen by the user: |Use these recurring character names for the suggested ideas: )/.test(l)).join('\n').trim();}
  async function submit(){if(busy)return;if(!narrationOn(answers))delete answers.narration;const setup=B.validateSetup(answers),productImage=answers.ugcProductImage;if(setup.topicMode!=='Suggest five ideas')setup.presetContext=storyContext(setup.presetContext);if(Number(setup.niche)===56){const U=await import('./lib/ugc-product.mjs');U.validateProductImage(answers.ugcProductImage?.blob);}
    if(setup.topicMode==='Suggest five ideas'){
      const history=await ideaHistory(),projects=await store('getAll');
      const previous=avoidIdeas([...projects.flatMap(x=>x.topics||[x.setup?.topic||'']),...history.flatMap(x=>x.topics||[])]);
      setup.presetContext=[(setup.presetContext||'').slice(0,500),'Suggest genuinely new stories. Avoid these previously received ideas, including paraphrases or the same plot with renamed characters: '+previous].join('\n').slice(0,1500);
    }
    {const hook=answers.openingHook,line=typeof hook==='string'?hook:hook?.line,action=typeof hook==='object'?hook?.action:'';
     if(line&&answers.hookTopic===answers.topic&&setup.topicMode!=='Suggest five ideas')setup.presetContext=[setup.presetContext||'','OPENING HOOK chosen by the user: '+(action?'Scene 1 opens on this visible action: '+action+' (in a niche with a required silent opening, this action is that silent opening). Then ':'')+'the first spoken line of Scene 1 is exactly "'+line+'"'+(action?'':' (after any required silent opening)')+'. Build the story to follow from it.'].filter(Boolean).join('\n');}
    const castIds=Number(setup.niche)===56&&setup.format!=='Character host and B-roll'?[]:answers.characterIds||[];if(castIds.length)setup.imageWorkflow='Reference images first';
    if(setup.imageWorkflow)setup.presetContext=[setup.presetContext||'',setup.imageWorkflow==='Direct scene frames'&&setup.exportProfile!=='Recurring assets + video'?'Image workflow: direct scene frames. Return no reusable assets and no scene references. Describe all subjects and settings fully inside each scene image prompt.':'Image workflow: reference images first. Include only assets actually needed for recurring visual identity; omit unused references.'].filter(Boolean).join('\n');
    const C=await import('./lib/character-library.mjs'),libraryCast=await C.castSnapshot(castIds),libraryBaseContext=setup.presetContext||'';
    if(Number(setup.niche)===56&&libraryCast.length)setup.ugcPresenter=('The presenter is the saved character '+libraryCast[0].name+': keep their face, age, hair and skin exactly as in the saved reference picture; ugcPresenterLook only chooses the outfit colours. '+(setup.ugcPresenter||'')).trim().slice(0,1500);
    if(libraryCast.length){setup.imageWorkflow='Reference images first';setup.presetContext=setup.topicMode==='Suggest five ideas'?[libraryBaseContext,'Use these recurring character names for the suggested ideas: '+libraryCast.map(c=>c.name).join(', ')].filter(Boolean).join('\n'):C.castContext(libraryBaseContext,libraryCast,answers.characterWardrobe||'saved');B.validateSetup(setup);}
    if(libraryCast.length){const key=JSON.stringify([answers.characterWardrobe||'saved',...libraryCast.map(c=>[c.id,c.updatedAt,c.image.sha256])]);if(answers.characterSnapshotKey!==key){delete answers.requestId;answers.characterSnapshotKey=key;}}
    busy=true;message.textContent='Sending your setup…';
    try{const requestId=answers.requestId ||= crypto.randomUUID();await saveDraft();const j=await request('/builder/jobs',{setup,requestId,templateId:activeTemplate?.id,kind:setup.topicMode==='Suggest five ideas'?'topics':'project'});selected={...j,setup,requestId,target,templateId:activeTemplate?.id,templateVersion:activeTemplate?.version,libraryCast,libraryBaseContext,libraryWardrobe:answers.characterWardrobe||'saved',libraryCastReview:libraryCast.length>0,media:Number(setup.niche)===56?{asset_001:productImage}:{}};if(Number(setup.niche)===56&&j.project){selected.project=B.validateProject(j.project,setup);selected.state='prompts_ready';}await store('put',selected);await store('delete','draft');await chrome.storage.local.set({facelessActiveProjectId:selected.id,facelessDismissedProjectId:''});scheduleBuildWatch();await showContinuation();await openProject(selected);}finally{busy=false;}}
  function buildProgress(p,now=Date.now()){
    if(p.project||p.topics)return 100;
    if(p.state!=='running')return 0;
    const elapsed=Math.max(0,now-(p.createdAt||now));
    return Math.min(95,Math.floor(5+90*(1-Math.exp(-elapsed/180000))));
  }
  function progressCard(p){
    const percent=buildProgress(p),ideas=p.kind==='topics'||p.setup?.topicMode==='Suggest five ideas';
    if(percent===100&&p.state!=='videos_finished'){
      const ready=el('div',undefined,'fb-package-ready'),icon=el('span',undefined,'fb-package-icon'),copy=el('div',undefined,'fb-package-copy');icon.setAttribute('aria-hidden','true');
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');for(const [k,v] of Object.entries({viewBox:'0 0 24 24',width:'19',height:'19',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round'}))svg.setAttribute(k,v);for(const d of ['M4 7l8-4 8 4v10l-8 4-8-4Z','M4 7l8 4 8-4','M12 11v10','M8 5l8 4']){const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',d);svg.append(path);}icon.append(svg);
      copy.append(el('strong','Package ready'),el('small','Your prompts are prepared. Follow the next step below.'));ready.append(icon,copy,el('span','READY','fb-package-badge'));return ready;
    }
    const card=el('div',undefined,'fb-build-progress'),row=el('div',undefined,'fb-progress-label');
    row.append(el('strong',p.state==='videos_finished'?'✓ Videos complete':percent===100?'Package ready':p.state==='queued'?'Waiting to start':ideas?'Finding five story ideas':'Creating your scenes'),el('span',percent+'%'));
    const track=el('div',undefined,'fb-progress-track'),fill=el('div',undefined,'fb-progress-fill');fill.style.width=percent+'%';
    track.setAttribute('role','progressbar');track.setAttribute('aria-label','Estimated build progress');track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');track.setAttribute('aria-valuenow',String(percent));track.append(fill);
    card.append(row,track,el('small',p.state==='videos_finished'?'Your video generation is finished.':percent===100?'Your prompts are ready.':ideas?'Estimated progress · Generating ideas only, not a story.':'Estimated progress · AI writing time varies.'));return card;
  }
  async function openProject(p){
    if(p.kind==='manual')return openManualProject(p);
    selected=p;clearTimeout(pollTimer);const revision=++projectRenderRevision;
    if(p.libraryCast?.length){(await import('./lib/character-library-ui.mjs')).ensureCharacterStyles();if(revision!==projectRenderRevision)return;}
    if(p.project&&p.libraryCastReview){try{p=await autoApplySavedCast(p);}catch(e){p.libraryCastIssue='Your selected cast could not be applied: '+e.message;}if(revision!==projectRenderRevision)return;selected=p;}
    if(p.project){const normalized=B.healFlowTags(B.normalizeLegacySceneHeadings(p.project,p.setup));if(normalized!==p.project){p.project=normalized;await store('put',p);if(revision!==projectRenderRevision)return;}}
    if(p.reverseBatchId&&p.project){const shared=await shareReverseSheets(p);if(revision!==projectRenderRevision)return;if(shared)message.textContent='Using '+shared+' character sheet(s) already made in another part of this video story.';}
    const parts=B.isDrama(p.setup?.niche)?seriesParts(await store('getAll'),p.parentProjectId||p.id):[];
    if(revision!==projectRenderRevision)return;
    // Keep the old view painted during database reads, then replace synchronously.
    body.replaceChildren();message.textContent='';body.classList.toggle('fb-wide',!!globalThis.StoryShape?.isLandscape(p));
    // Which niche (the template the user picked, else the niche itself) and visual style this story was built with (shown first, above the Standalone / Part tabs).
    const nicheName=templates.find(t=>t.id===p.templateId)?.title||catalog.find(n=>n.id===Number(p.setup?.niche))?.name;
    const style=p.setup?.style==='Custom'?p.setup?.customStyle:p.setup?.style;
    if(nicheName){const tag=el('p',undefined,'fb-niche-tag');tag.append(el('span','Niche','fb-niche-label'),el('span',nicheName+(style?' · '+style:'')));body.append(tag);}
    // Idea suggestions are not a story yet: Standalone vs Series is chosen after an idea is picked ("Your video, ready
    // to write"), so the idea list never shows the template's default "Standalone story" label (owner 2026-10-15).
    const ideaStage=p.kind==='topics'||p.setup?.topicMode==='Suggest five ideas'||Boolean(p.topics);
    if(B.isDrama(p.setup?.niche)&&!ideaStage){const tabs=el('div',undefined,'fb-actions fb-part-tabs');
      // Series stories get Part tabs; a standalone story has no parts, so it shows a label instead (older stories with extra parts keep their tabs).
      if(Number(p.setup?.partsTotal||1)>1||parts.length>1)for(const part of parts){const b=button('Part '+(part.setup.partNumber||1),()=>openProject(part));b.setAttribute('aria-pressed',String(part.id===p.id));if(part.id===p.id)b.classList.add('fb-primary');tabs.append(b);}
      else tabs.append(el('span',Number(p.setup?.season||1)>1?'Episode':'Standalone story','fb-standalone-tag'));
      if(Number(p.setup?.season||1)>1)tabs.prepend(el('span','Season '+p.setup.season,'fb-standalone-tag'));
      body.append(tabs);
    }
    if(p.topics){body.append(el('h3','Choose your video idea'));for(const topic of p.topics)body.append(button(topic,async()=>{if(busy)return;busy=true;try{answers={...p.setup,presetContext:storyContext(p.libraryBaseContext??p.setup.presetContext),characterIds:(p.libraryCast||[]).map(c=>c.id),characterWardrobe:p.libraryWardrobe||'story',topicMode:'Existing topic',topic};target=p.target||null;activeTemplate=templates.find(t=>t.id===p.templateId)||null;quick=Boolean(activeTemplate);step=B.steps(answers).length;await saveChosenIdea(p.id);reviewSetup();}finally{busy=false;}}));body.append(button('Projects',home));return;}
    if(!p.project){const ideas=p.kind==='topics'||p.setup?.topicMode==='Suggest five ideas';body.append(el('h3',['failed','cancelled'].includes(p.state)?'Build '+p.state:ideas?'Suggesting five story ideas':'Writing your scene package'));
      if(['queued','running'].includes(p.state))body.append(progressCard(p));else body.append(el('p',p.error||p.state));
      if(['failed','cancelled'].includes(p.state)){const actions=el('div',undefined,'fb-actions');actions.append(button('Try again',()=>retryBuild(p)),button('Delete this part',()=>deleteFailedPart(p)));body.append(actions);}
      body.append(button('Back to projects',home));
      if(['queued','running'].includes(p.state)){body.append(button(ideas?'Cancel suggestions':'Cancel build',async()=>{const j=await request('/builder/jobs/'+(p.jobId||p.id)+'/cancel',{});Object.assign(p,j,{id:p.id});await store('put',p);openProject(p);}));scheduleBuildWatch();}
      return;
    }
    body.append(userText('h3',p.project.title),el('p',`${p.project.scenes.length} scenes · ${p.project.durationSeconds}s · ${p.state==='videos_finished'?'Completed':p.state.replaceAll('_',' ')}`,'fb-muted'));if(p.state!=='videos_finished')body.append(progressCard(p));
    const partAction=B.partAction(p.setup),partFinished=p.state==='videos_finished'||(p.setup.exportProfile==='Image prompts only'&&p.state==='images_reviewed'&&p.imagesReviewed);

    if(p.project.layoutReview?.remainingFindings?.length)body.append(el('p',p.project.layoutReview.warning+' Flagged scenes: '+[...new Set(p.project.layoutReview.remainingFindings.map(x=>x.sceneId))].join(', '),'fb-message'));
    if(p.libraryCastReview){const review=await castReviewCard(p);if(revision!==projectRenderRevision)return;body.append(review);}else if(p.libraryReferenceMode==='applied'){const confirmation=el('div',undefined,'cl-cast-confirmation');confirmation.append(el('strong',(p.libraryCast||[]).map(c=>c.name).join(', ')+' · in this story'),el('small',p.libraryWardrobe==='saved'?'Keep saved outfit':p.libraryWardrobe==='story'?'Outfits follow the scene · identity uses your saved references':'Identity uses your saved references'));body.append(confirmation);}
    const missingAssets=p.project.assets.some(x=>(!p.media?.[x.id]||(p.redoIds||[]).includes(x.id))),missingScenes=p.setup.exportProfile!=='Recurring assets + video'&&p.project.scenes.some(x=>(!p.media?.[x.id]||(p.redoIds||[]).includes(x.id)));
    const imageOnly=p.setup.exportProfile==='Image prompts only';
    if(!imageOnly)body.append(button('↗ Open Story Workspace',()=>openStoryWorkspace(p)));
    if(p.state==='videos_finished'){const done=el('div',undefined,'fb-complete-panel'),icon=el('span','✓','fb-complete-icon'),copy=el('div',undefined,'fb-complete-copy');copy.append(el('strong','Videos complete'),el('small','All '+p.project.scenes.length+' clips generated · Project finished'));done.append(icon,copy,button('Open Control →',()=>dialog.close()));body.append(done);}else{
    const H=await import('./lib/story-helpers.mjs');if(revision!==projectRenderRevision)return;
    const next=el('div',undefined,'fb-card');next.append(el('strong','Next step'));
    // Owner 2026-11-10: the platforms sit right above Auto, one tap each (users struggled with the separate platform screen).
    // Changes are painted in place (no page re-render: that flickered).
    let sheetRow=null;const accountSlot=el('div',undefined,'fb-account-slot'),onPlatform=()=>{paintEstimate();if(sheetRow)paintSheetRow();paintAccount();};
    if(missingAssets||missingScenes||p.imagesReviewed)next.append(quickPlatforms(p,true,!imageOnly,onPlatform));
    // Owner 2026-10-29: say what the run will make before Start (counts, not credit prices: Flow changes those).
    const estimate=el('small','','fb-muted fb-run-estimate'),paintEstimate=()=>{const t=B.generationTargets(p.target,settings);estimate.textContent=H.estimateText(H.runEstimate(p,{sheets:p.sceneImageMode==='sheets'&&sheetsAvailable(p).ok}),{imagePlatform:missingAssets||missingScenes?t.imagePlatform:'',videoPlatform:t.videoPlatform,model:t.model,resolution:settings.videoGenerationResolution||'720p'});};
    const action=missingAssets?['1 · Load reference images',()=>loadImages(p,'assets')]:missingScenes?['2 · Load scene images',()=>loadImages(p,'scenes')]:!p.imagesReviewed?['3 · Approve reviewed images',()=>approve(p)]:imageOnly?['4 · Save finished images',()=>exportImages(p)]:['4 · Load video prompts',()=>loadVideos(p)];
    // Start right here (owner 2026-10-15): "Auto" runs every remaining step by itself, "This step only" runs one step;
    // both load the queue AND press Start, so nobody has to go to Control first.
    if(missingScenes){
      if(typeof featureAllowance==='function'&&!(typeof usageState!=='undefined'&&usageState?.unlimited))await Promise.race([featureAllowance().catch(()=>null),new Promise(r=>setTimeout(r,1500))]);if(revision!==projectRenderRevision)return;
      sheetRow=el('div',undefined,'fb-sheet-choice');next.append(sheetRow);paintSheetRow();
    }
    function paintSheetRow(){
      const avail=sheetsAvailable(p),row=sheetRow,pick=document.createElement('select');row.replaceChildren();
      pick.innerHTML='<option value="single">One image per scene</option><option value="sheets">Storyboard sheets · 4 scenes per image · '+(avail.trial?avail.left+' free left this month':'Pro')+(avail.platform==='chatgpt'?' · slightly softer':'')+'</option>';
      pick.value=avail.ok&&p.sceneImageMode==='sheets'?'sheets':'single';pick.disabled=running||!avail.ok;pick.setAttribute('aria-label','Scene images');
      pick.onchange=async()=>{p.sceneImageMode=pick.value;if(pick.value==='sheets'){p.sheetTriedIds=[];p.sheetMisses={};}await store('put',p);paintEstimate();};   // choosing sheets again gives every scene a fresh try
      // Owner 2026-10-30: a PRO badge (opens Upgrade) when sheets are locked for this plan.
      const label=el('span','Scene images','fb-sheet-label');if(!avail.pro){const chip=button('PRO',()=>{if(typeof showUpgradePopup==='function'&&typeof UPGRADE_POPUPS!=='undefined')showUpgradePopup(UPGRADE_POPUPS.sheets);});chip.className='fb-pro-chip';chip.title='Storyboard sheets: unlimited with Pro';label.append(chip);row.onclick=e=>{if(pick.disabled&&!running&&e.target!==chip&&typeof showUpgradePopup==='function'&&typeof UPGRADE_POPUPS!=='undefined')showUpgradePopup(UPGRADE_POPUPS.sheets);};}else row.onclick=null;
      row.append(label,pick,el('small',!avail.flow?'Storyboard sheets need Flow or ChatGPT images.':avail.noCast?'ChatGPT storyboard sheets need known characters: create the story with "Reference images first", or use Flow.':avail.trial?(avail.left?'Free: '+avail.left+' of '+avail.limit+' storyboard sheets left this month (each sheet = 4 scenes, about 70% fewer image credits). Unlimited with Pro.':'This month\'s '+avail.limit+' free storyboard sheets are used. Unlimited with Pro.'):!avail.pro?'Pro: about 70% fewer image credits and more consistent characters.':avail.ok?'Sheets: about 70% fewer image credits. Scenes with 4+ people still get their own image.':'Not available for Ingredients projects.'));
    }
    // The account switch for the engines this story still uses (owner 2026-11-14: a Gemini story showed the Flow switch):
    // image engine only while images are missing, video engine unless the story is images only.
    function paintAccount(){const tg=B.generationTargets(p.target,settings),uses=new Set([...(missingAssets||missingScenes?[tg.imagePlatform]:[]),...(imageOnly?[]:[tg.videoPlatform])]);
      accountSlot.replaceChildren(...(uses.has('flow')&&window.manualAccountSwitch?.storyRow?[window.manualAccountSwitch.storyRow()]:[]),...(uses.has('gemini')&&window.geminiAccountSwitch?.storyRow?[window.geminiAccountSwitch.storyRow()]:[]),...(uses.has('vids')&&window.vidsAccountSwitch?.storyRow?[window.vidsAccountSwitch.storyRow()]:[]));}
    const startable=missingAssets||missingScenes||(p.imagesReviewed&&!imageOnly);
    if(startable){
      const stage=missingAssets?'1 · Reference images':missingScenes?'2 · Scene images':'4 · Videos';
      next.append(el('div',stage+(running?' · wait for the current run to finish':''),'fb-next-stage'));
      const row=el('div',undefined,'fb-start-choice'),auto=button('▶ Auto: run all steps',()=>startFromProject(p,true,action[1])),one=button('Run this step only',()=>startFromProject(p,false,action[1]));
      auto.classList.add('fb-primary');auto.title='Runs every remaining step by itself, straight through to the videos (no image review stop). Stops on any failure or a credit limit.';one.title='Runs only this step, so you can review the images before the videos.';
      auto.disabled=one.disabled=running||p.libraryCastReview===true;row.append(auto,one);next.append(row);
      paintEstimate();if(estimate.textContent)next.append(estimate);
      // Owner 2026-11-01: the Control account switch, shown here too when this story runs on Flow (same setting).
      next.append(accountSlot);paintAccount();
    }else{
      const nextButton=button(...action);nextButton.classList.add('fb-primary');next.append(nextButton);
      if(!p.imagesReviewed&&!imageOnly){const go=button('Approve & generate videos',async()=>{await approve(p);await startFromProject(p,autoRun.on,()=>loadVideos(p));});go.disabled=running||p.libraryCastReview===true;next.append(go);}
      next.append(el('small',!p.imagesReviewed?'Review the images below before approving.':'Your images are ready to save.'));
    }
    body.append(next);
    }
    if(partFinished&&partAction){
      // Owner 2026-10-29: a clear "what's next" card with how this part ended, so more stories continue as a series.
      const follow=el('div',undefined,'fb-follow-up fb-card'),part=Number(p.setup.partNumber||1),total=Number(p.setup.partsTotal||1),ending=(await import('./lib/story-helpers.mjs')).partEnding(p);
      follow.append(el('strong','Part '+part+(total>1?' of '+total:'')+' is finished'));if(ending)follow.append(el('p','Ends with: “'+ending+'”','fb-muted'));
      // Owner 2026-10-29: what viewers said about this part goes into the next part's brief.
      const notes=el('textarea');notes.rows=2;notes.maxLength=600;notes.value=p.nextPartNotes||'';notes.placeholder='Optional notes for Part '+(part+1)+': what viewers liked or skipped (e.g. "more of the mother-in-law", "faster start", "end with a twist")';notes.setAttribute('aria-label','Notes for the next part');notes.className='fb-next-notes';
      notes.onchange=async()=>{const value=notes.value.trim().slice(0,600);if(value===(p.nextPartNotes||''))return;p.nextPartNotes=value;delete p.nextPartRequestId;await store('put',p);};
      follow.append(notes);
      const action=button(partAction.label,async()=>{await notes.onchange();return continuePart(p);});action.classList.add('fb-primary');follow.append(action);
      follow.append(el('small',partAction.hint||'Same characters and story; it continues from this ending.','fb-muted'));body.append(follow);}
    // "Continue the story" (owner 2026-11-11, Pro): a finished drama goes on as a new season with the same cast.
    const seasonAction=partFinished&&!partAction&&p.imagesReviewed?B.seasonAction(p.setup):null;
    if(seasonAction){
      const records=await store('getAll'),root=p.parentProjectId||p.id,nextSeason=records.filter(x=>x.previousSeasonRootId===root&&!x.parentProjectId).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))[0];
      const follow=el('div',undefined,'fb-follow-up fb-card fb-season-card'),ending=(await import('./lib/story-helpers.mjs')).partEnding(p);
      follow.append(el('strong',(Number(p.setup.season||1)>1?'Season '+p.setup.season+' is finished':'Your story is finished')));if(ending)follow.append(el('p','Ends with: “'+ending+'”','fb-muted'));
      if(nextSeason){
        const open=button('Open Season '+(nextSeason.setup?.season||seasonAction.season)+' →',async()=>{switchTab(dialog.id,$('builderTabBtn'));await openProject(nextSeason);});open.classList.add('fb-primary');follow.append(open);
      }else{
        follow.append(el('p','Keep it going: the same characters, outfits and places start a new chapter after this ending. Your approved images are reused.','fb-muted'));
        const long=B.isLong?B.isLong(p.setup):p.setup.seriesLength==='long',choices=long?[['3','3 parts'],['4','4 parts']]:[['1','1 episode'],['2','2 parts'],['3','3 parts']];
        const size=el('select');size.setAttribute('aria-label','Length of the next season');size.className='fb-season-size';for(const [value,label] of choices){const o=el('option',label);o.value=value;size.append(o);}
        size.value=choices.some(([v])=>v===String(p.nextSeasonParts||''))?String(p.nextSeasonParts):choices[0][0];
        size.onchange=async()=>{if(String(p.nextSeasonParts||'')===size.value)return;p.nextSeasonParts=size.value;delete p.nextSeasonRequestId;await store('put',p);};
        const sizeRow=el('label',undefined,'fb-season-size-row');sizeRow.append(el('span','Season '+seasonAction.season+' length'),size);follow.append(sizeRow);
        const notes=el('textarea');notes.rows=2;notes.maxLength=600;notes.value=p.nextSeasonNotes||'';notes.placeholder='Optional: what should happen next, or what viewers asked for (e.g. "Rosa opens her own shop", "the ex comes back")';notes.setAttribute('aria-label','Notes for the next season');notes.className='fb-next-notes';
        notes.onchange=async()=>{const value=notes.value.trim().slice(0,600);if(value===(p.nextSeasonNotes||''))return;p.nextSeasonNotes=value;delete p.nextSeasonRequestId;await store('put',p);};
        follow.append(notes);
        const action=button(seasonAction.label+(paidPro()?'':' · Pro'),async()=>{await notes.onchange();await size.onchange();return continueStory(p,{partsTotal:size.value});});action.classList.add('fb-primary');follow.append(action);
        follow.append(el('small','Pro · Same characters and looks, a new conflict that starts after this ending.','fb-muted'));
      }
      body.append(follow);}
    if(partAction&&!partFinished&&p.imagesReviewed&&!imageOnly&&['images_reviewed','video_ready'].includes(p.state)){
      const external=el('div',undefined,'fb-card'),nextNumber=Number(p.setup.partNumber||1)+1;
      // Owner 2026-11-15 (member report): this path skipped the next-part notes, so the member could not steer Part 2.
      const notes=el('textarea');notes.rows=2;notes.maxLength=600;notes.value=p.nextPartNotes||'';notes.placeholder='Optional notes for Part '+nextNumber+': what viewers liked or skipped (e.g. "more of the mother-in-law", "faster start", "end with a twist")';notes.setAttribute('aria-label','Notes for the next part');notes.className='fb-next-notes';
      notes.onchange=async()=>{const value=notes.value.trim().slice(0,600);if(value===(p.nextPartNotes||''))return;p.nextPartNotes=value;delete p.nextPartRequestId;await store('put',p);};
      external.append(notes,button('Videos finished elsewhere · Continue to Part '+nextNumber+' →',async()=>{await notes.onchange();return continuePart(p,{videosFinishedElsewhere:true});}),el('small','Use this if you generated this part’s videos in another browser profile or outside the extension.','fb-muted'));body.append(external);
    }
    // Redo images (owner 2026-10-25, everyone): marks every reference or every scene image for a new version. Nothing starts
    // by itself: Next step above then offers the usual run (scene images: one per scene or storyboard sheets). Current images
    // stay until each new one is saved; Cancel redo keeps them. Small pills like the NICHE tag, under "Download prompts & images".
    // An image is needed when missing OR in p.redoIds; that rule is written inline wherever the next images are chosen.
    let redoBar=null;
    if(p.setup.imageMode!=='Prompts only'){
      const sceneList=p.setup.exportProfile==='Recurring assets + video'?[]:p.project.scenes,pending=(p.redoIds||[]).length;
      // Shown as soon as one image of the stage exists (owner 2026-10-25: "redo all, even if others are already made").
      const refsDone=p.project.assets.some(x=>p.media[x.id]),scenesDone=sceneList.some(x=>p.media[x.id]);
      const pill=(text,tip,fn)=>{const b=button('',fn),tag=el('span','Redo','fb-niche-label');b.className='fb-niche-tag fb-redo-pill';b.title=tip;b.append(tag,document.createTextNode(text));b.disabled=running;return b;};
      const mark=async(kind,list)=>{
        if(running)throw Error('Wait for the current run to finish.');
        if(!confirm('Make new '+(kind==='assets'?'reference':'scene')+' images for all '+list.length+'? Your current images stay until each new one is saved. This uses image credits.'+(kind==='assets'?' Scenes made with the old references will be marked to review or regenerate.':'')))return;
        const latest=(await store('getAll')).find(x=>x.id===p.id)||p;
        if(!latest.redoIds?.length)latest.redoPrevState=latest.state;
        latest.redoIds=[...new Set([...(latest.redoIds||[]),...list.map(x=>x.id)])];if(kind==='scenes')latest.sheetTriedIds=[];if(kind==='scenes')latest.sheetMisses={};
        latest.imagesReviewed=false;latest.state='prompts_ready';await store('put',latest);await openProject(latest);
      };
      if(refsDone||scenesDone||pending){
        redoBar=el('div',undefined,'fb-redo-bar');
        if(refsDone&&p.project.assets.some(x=>!isProductReference(p,x.id)))redoBar.append(pill('All reference images','Make a new version of every reference image. Current images stay until each new one is saved.',()=>mark('assets',p.project.assets.filter(x=>!isProductReference(p,x.id)))));
        if(scenesDone)redoBar.append(pill('All scene images','Make a new version of every scene image (one per scene or storyboard sheets). Current images stay until each new one is saved.',()=>mark('scenes',sceneList)));
        if(pending)redoBar.append(pill(pending+' marked · Cancel redo','Unmark them and keep the current images.',async()=>{
          if(running)throw Error('Wait for the current run to finish.');
          const latest=(await store('getAll')).find(x=>x.id===p.id)||p;latest.redoIds=[];
          if(latest.redoPrevState&&reviewImages(latest).every(x=>latest.media[x.id])){latest.state=latest.redoPrevState;latest.imagesReviewed=['images_reviewed','video_ready','videos_finished'].includes(latest.state);}
          delete latest.redoPrevState;await store('put',latest);await openProject(latest);
        }));
      }
    }
    const actions=el('div',undefined,'fb-actions');actions.append(button('All projects',()=>home('projects')));body.append(actions);
    // Owner 2026-11-06: a Video → Story project can be remade as 3D, 2D anime, flat 2D or painterly (or back to photoreal) as a copy.
    const looks=B.restyleOptions?.(p.setup)||[];
    if(p.reverseBatchId&&p.reverseParts>1){const differ=Object.keys(B.reverseShared?.(p,await store('getAll'),{replace:true})||{}).length;
      if(differ){const use=button('👥 Use the characters from the other part ('+differ+')',async()=>{if(busy||running)throw Error('Finish the current action first.');const n=await shareReverseSheets(p,{replace:true});await openProject(p);message.textContent='This part now uses '+n+' character sheet(s) from the other part of this video story. Scene images made with the old sheets stay until you regenerate them.';});use.title='Replace this part\'s character sheets with the ones another part of this video story already made, so the people look the same in every part.';actions.append(use);}}
    if(looks.length){const lookCard=el('div',undefined,'fb-card fb-look-card'),row=el('div',undefined,'fb-actions');lookCard.hidden=true;
      lookCard.append(el('strong','Make this story in another look'),el('small','Makes a copy with the same story, lines and shots in the new look. This project stays as it is. The copy starts without pictures: all character sheets, scene images and videos are made again (uses Flow credits). Other parts copied to the same look reuse these character sheets.','cl-note'));
      for(const o of looks)row.append(button(o.label,async()=>{if(busy||running)throw Error('Finish the current action first.');
        const r=B.restyleProject(p.project,p.setup,o.value),now=Date.now();
        const copy={id:crypto.randomUUID(),kind:'project',state:'prompts_ready',origin:p.origin||'video-reverse',reverseBatchId:crypto.randomUUID(),reversePart:p.reversePart,reverseParts:p.reverseParts,createdAt:now,day:new Date(now).toISOString().slice(0,10),requestId:crypto.randomUUID(),setup:r.setup,project:r.project,media:{},imagesReviewed:false,restyledFrom:p.id,...(p.aspect?{aspect:p.aspect}:{}),...(p.target?{target:structuredClone(p.target)}:{}),...(p.templateId?{templateId:p.templateId}:{})};
        await store('put',copy);await openProject(copy);message.textContent='Made a '+r.label+' copy: '+r.project.title+'. Press Auto: run all steps to make its character sheets, scene images and videos.'+(r.missing?' '+r.missing+' prompt(s) had no style line, so the new look was added at their start.':'');}));
      lookCard.append(row);const toggle=button('🎨 Change look',()=>{lookCard.hidden=!lookCard.hidden;});toggle.disabled=running;toggle.setAttribute('aria-expanded','false');toggle.onclick=()=>{lookCard.hidden=!lookCard.hidden;toggle.setAttribute('aria-expanded',String(!lookCard.hidden));};actions.append(toggle);actions.after(lookCard);}
    const exports=el('details',undefined,'fb-card');exports.append(el('summary','Download prompts & images'));const exportActions=el('div',undefined,'fb-actions');exportActions.append(button('JSON project',()=>download(p)),button('Character / reference prompts',()=>exportText(p,'references')),button('Scene image prompts',()=>exportText(p,'scenes')),button('Video prompts',()=>exportText(p,'videos')),button('CSV prompts',()=>exportCsv(p)),button('Save images',()=>exportImages(p)));exports.append(exportActions);body.append(exports);if(redoBar)body.append(redoBar);
    for(const x of [...p.project.assets,...p.project.scenes]){const card=el('article',undefined,'fb-card fb-media-card'),visual=el('div',undefined,'fb-visual');visual.append(el('strong',x.id));card.append(visual);
      if(p.media[x.id]){const img=el('img');img.alt=x.id;img.src=URL.createObjectURL(p.media[x.id].blob);img.onload=()=>URL.revokeObjectURL(img.src);visual.append(img);}
      const upload=el('input');upload.type='file';upload.accept='image/png,image/jpeg,image/webp';upload.setAttribute('aria-label','Upload '+x.id);
      upload.onchange=async()=>{try{const f=upload.files[0];if(isProductReference(p,x.id)){const U=await import('./lib/ugc-product.mjs');U.validateProductImage(f);}if(!f||!/^image\/(png|jpeg|webp)$/.test(f.type)||f.size>20*1024*1024)throw Error('Choose a PNG, JPEG or WebP below 20MB.');await attach(p,x.id,f,f.type.split('/')[1]);await openProject(p);}catch(e){error(e);}};visual.append(upload);
      const regenerate=button(p.media[x.id]?'↻ Regenerate':'＋ Generate image',async()=>{if(busy)throw Error('Wait for the current Builder action.');busy=true;try{await mediaWrites;await startFromProject(p,false,()=>loadImages(p,x.id.startsWith('asset_')?'assets':'scenes',[x.id]));}finally{busy=false;}});regenerate.classList.add('fb-regenerate');regenerate.setAttribute('aria-label',(p.media[x.id]?'Regenerate ':'Generate ')+x.id);regenerate.disabled=running||isProductReference(p,x.id);if(isProductReference(p,x.id)){regenerate.textContent='Uploaded product · replace with Choose File';regenerate.title='Your original product is never regenerated.';}visual.append(regenerate);
      if(x.id.startsWith('asset_')&&!isProductReference(p,x.id)){const use=button('Use saved character',()=>useReferenceCharacter(p,x)),save=button('Save to Character Library',()=>saveReferenceCharacter(p,x));use.disabled=running;if(p.restyledFrom){use.disabled=true;use.title='Saved characters are in the original look; this copy makes its own';}save.disabled=!p.media[x.id]?.blob;visual.append(use,save);}
      if(p.staleSceneIds?.includes(x.id))visual.append(el('small','Reference changed · review or regenerate','fb-stale-image'));
      const editor=el('div',undefined,'fb-editors');card.append(editor);const fields={};
      for(const key of ['speech','caption','imagePrompt','videoPrompt'])if(key in x){const label=el('label',({speech:'Narration / dialogue',caption:'Caption',imagePrompt:'Image prompt',videoPrompt:'Video prompt'})[key]);const t=el('textarea');t.rows=key.endsWith('Prompt')?7:3;t.value=x[key];t.setAttribute('aria-label',x.id+' '+label.textContent);t.spellcheck=true;fields[key]=t;t.onchange=async()=>{const before=x[key];try{x[key]=t.value;B.validateProject(p.project,p.setup);p.imagesReviewed=false;p.state='prompts_ready';await store('put',p);message.textContent='Changes saved. Review images again before loading videos.';}catch(e){x[key]=before;t.value=before;error(e);}};label.append(t);editor.append(label);}
      // Owner 2026-11-06: narration is locked until Edit; Save also rewrites the spoken lines in the video prompt.
      if(fields.speech){const t=fields.speech,bar=el('div',undefined,'fb-actions fb-speech-actions');t.readOnly=true;t.onchange=null;
        const done=()=>{t.readOnly=true;edit.hidden=false;save.hidden=cancel.hidden=true;};
        const edit=button('✎ Edit',()=>{t.readOnly=false;edit.hidden=true;save.hidden=cancel.hidden=false;t.focus();});
        const cancel=button('Cancel',()=>{t.value=x.speech;done();});
        const save=button('Save',async()=>{const before={speech:x.speech,videoPrompt:x.videoPrompt};
          try{const r=B.speechEditPrompt(x,t.value);x.speech=t.value.trim();x.videoPrompt=r.videoPrompt;B.validateProject(p.project,p.setup);p.imagesReviewed=false;p.state='prompts_ready';await store('put',p);
            t.value=x.speech;if(fields.videoPrompt)fields.videoPrompt.value=x.videoPrompt;done();
            message.textContent=r.changed?'Narration saved and the spoken lines in the video prompt updated. Review images again before loading videos.':'Narration saved. This video prompt has no spoken lines, so it stays as it was.';}
          catch(e){Object.assign(x,before);t.value=before.speech;if(fields.videoPrompt)fields.videoPrompt.value=before.videoPrompt;error(e);}});
        save.hidden=cancel.hidden=true;edit.disabled=running;edit.setAttribute('aria-label','Edit '+x.id+' narration');save.setAttribute('aria-label','Save '+x.id+' narration');bar.append(edit,save,cancel);t.parentElement.after(bar);}
      body.append(card);
    }
  }
  async function retryBuild(p){
    if(busy)return;if(running)throw Error('Finish the current generation first.');if(!['failed','cancelled'].includes(p.state))throw Error('Only failed or cancelled builds can be retried.');busy=true;
    try{
      const requestId=p.retryRequestId||crypto.randomUUID();p.retryRequestId=requestId;await store('put',p);
      const j=await request('/builder/jobs',{setup:B.validateSetup(p.setup),kind:p.kind||'project',requestId,templateId:p.templateId});
      const replacement={...p,...j,id:p.id,jobId:j.id,requestId,createdAt:j.createdAt||Date.now(),media:p.media||{}};delete replacement.retryRequestId;delete replacement.error;delete replacement.project;delete replacement.topics;if(j.project){replacement.project=B.validateProject(j.project,p.setup);replacement.state='prompts_ready';}if(j.topics)replacement.topics=j.topics;
      await store('put',replacement);await chrome.storage.local.set({facelessActiveProjectId:p.id,facelessDismissedProjectId:''});scheduleBuildWatch();await showContinuation();switchTab(dialog.id,$('builderTabBtn'));await openProject(replacement);
    }finally{busy=false;}
  }
  async function deleteFailedPart(p){
    if(!p.parentProjectId)return deleteProject(p);
    if(!['failed','cancelled'].includes(p.state))throw Error('Only failed or cancelled parts can be removed here.');
    if(!confirm('Delete this failed part? Earlier parts and their approved images will stay saved.'))return;
    deletedProjects.add(p.id);await store('delete',p.id);
    const parent=(await store('getAll')).find(x=>x.id===p.parentProjectId);if(parent){delete parent.nextPartRequestId;await store('put',parent);}
    await chrome.storage.local.set({facelessActiveProjectId:parent?.id||'',facelessDismissedProjectId:''});await showContinuation();await home('projects');
  }
  function confirmContinuation(text,number,labels={}){
    return new Promise((resolve,reject)=>{
      const popup=el('dialog',undefined,'fb-limit-dialog'),actions=el('div',undefined,'fb-limit-actions');let accepted=false;
      const title=el('h3',labels.title||'Continue to Part '+number+'?');title.id='fb-continue-title';popup.setAttribute('aria-labelledby',title.id);
      const cancel=button('Cancel',()=>popup.close()),proceed=button(labels.action||'Write Part '+number,()=>{accepted=true;popup.close();});proceed.classList.add('fb-primary');
      actions.append(cancel,proceed);popup.append(title,el('p',text),actions);
      popup.addEventListener('close',()=>{popup.remove();resolve(accepted);},{once:true});
      document.body.append(popup);try{popup.showModal();cancel.focus();}catch(e){popup.remove();reject(e);}
    });
  }
  async function continuePart(p,options={}){
    if(busy)throw Error('Wait for the current Builder action to finish, then try Continue again.');if(running)throw Error('Finish the active generation first.');busy=true;
    try{await mediaWrites;const all=await store('getAll'),root=p.parentProjectId||p.id,parts=seriesParts(all,root);
      const number=Number(p.setup.partNumber||1)+1,existing=parts.find(x=>Number(x.setup.partNumber||1)===number);
      // options.factory: the overnight Factory writes the next part itself (no confirm box, no screen change) and gets the record back.
      if(existing&&options.factory){if(['failed','cancelled'].includes(existing.state))throw Error('Part '+number+' could not be written: '+(existing.error||existing.state));return existing;}
      if(existing&&['failed','cancelled'].includes(existing.state)){busy=false;return await retryBuild(existing);}if(existing){switchTab(dialog.id,$('builderTabBtn'));return await openProject(existing);}
      const setup=B.nextPartSetup(p,parts.filter(x=>Number(x.setup.partNumber||1)<number),{...options,notes:options.factory?'':p.nextPartNotes});
      const confirmation=options.videosFinishedElsewhere===true
        ? 'Confirm you finished Part '+(number-1)+' videos outside this extension. Write Part '+number+' using the saved story and approved references? This uses one Builder allowance. Local clips will not be marked as saved.'
        : ('Write Part '+number)+'? This uses one Builder allowance. Approved asset images will be reused.';
      if(!options.factory&&!await confirmContinuation(confirmation,number))return;
      const requestId=p.nextPartRequestId||crypto.randomUUID();p.nextPartRequestId=requestId;await store('put',p);
      const j=await request('/builder/jobs',{setup,kind:'project',requestId,templateId:p.templateId});const inherited=Object.fromEntries(setup.continuation.assets.map(x=>[x.id,p.media[x.id]]));
      const child={...j,setup,parentProjectId:root,requestId,target:p.target,...(p.sceneImageMode?{sceneImageMode:p.sceneImageMode}:{}),...(p.aspect?{aspect:p.aspect}:{}),templateId:p.templateId,templateVersion:p.templateVersion,libraryCast:p.libraryCast||[],libraryBindings:p.libraryBindings||{},libraryWardrobe:p.libraryWardrobe||'story',libraryReferenceMode:p.libraryReferenceMode,libraryCastReview:false,media:inherited,imagesReviewed:false};if(j.project){child.project=B.validateProject(j.project,setup);child.state='prompts_ready';}await store('put',child);if(options.factory)return child;await chrome.storage.local.set({facelessActiveProjectId:child.id,facelessDismissedProjectId:''});scheduleBuildWatch();await showContinuation();switchTab(dialog.id,$('builderTabBtn'));await openProject(child);
    }finally{busy=false;}
  }
  // "Continue the story" (owner 2026-11-11, Pro): Part 1 of a new season, its own series (previousSeasonRootId links it).
  async function continueStory(p,options={}){
    if(busy)throw Error('Wait for the current Builder action to finish, then try again.');if(running)throw Error('Finish the active generation first.');
    if(!paidPro()){if(typeof showUpgradePopup==='function'&&typeof UPGRADE_POPUPS!=='undefined')showUpgradePopup(UPGRADE_POPUPS.series);else throw Error('Continue the story is part of paid Pro.');return;}
    busy=true;
    try{await mediaWrites;const all=await store('getAll'),root=p.parentProjectId||p.id,parts=seriesParts(all,root);
      const existing=all.filter(x=>x.previousSeasonRootId===root&&!x.parentProjectId).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))[0];
      if(existing&&['failed','cancelled'].includes(existing.state)){busy=false;return await retryBuild(existing);}if(existing){switchTab(dialog.id,$('builderTabBtn'));return await openProject(existing);}
      const setup=B.nextSeasonSetup(p,parts,{partsTotal:options.partsTotal,notes:p.nextSeasonNotes});
      const total=Number(setup.partsTotal);
      if(!await confirmContinuation('Write Season '+setup.season+(total>1?', Part 1 of '+total:'')+'? This uses one Builder allowance. The same characters and approved images are reused, and the story starts after this ending.',1,{title:'Continue the story?',action:'Write Season '+setup.season}))return;
      const requestId=p.nextSeasonRequestId||crypto.randomUUID();p.nextSeasonRequestId=requestId;await store('put',p);
      const j=await request('/builder/jobs',{setup,kind:'project',requestId,templateId:p.templateId});const inherited=Object.fromEntries(setup.continuation.assets.map(x=>[x.id,p.media[x.id]]));
      const child={...j,setup,previousSeasonRootId:root,requestId,target:p.target,...(p.sceneImageMode?{sceneImageMode:p.sceneImageMode}:{}),...(p.aspect?{aspect:p.aspect}:{}),templateId:p.templateId,templateVersion:p.templateVersion,libraryCast:p.libraryCast||[],libraryBindings:p.libraryBindings||{},libraryWardrobe:p.libraryWardrobe||'story',libraryReferenceMode:p.libraryReferenceMode,libraryCastReview:false,media:inherited,imagesReviewed:false};if(j.project){child.project=B.validateProject(j.project,setup);child.state='prompts_ready';}
      await store('put',child);await chrome.storage.local.set({facelessActiveProjectId:child.id,facelessDismissedProjectId:''});scheduleBuildWatch();await showContinuation();switchTab(dialog.id,$('builderTabBtn'));await openProject(child);
    }finally{busy=false;}
  }
  function scheduleBuildWatch(){if(buildWatchTimer||buildWatchBusy)return;buildWatchTimer=setTimeout(async()=>{buildWatchTimer=null;buildWatchBusy=true;let active=[];try{active=(await store('getAll')).filter(p=>['queued','running'].includes(p.state)&&p.id!=='draft');for(const p of active)await refresh(p);}catch(e){console.warn('Builder status:',e);}finally{buildWatchBusy=false;if(active.length)scheduleBuildWatch();}},3000);}
  async function refresh(p){try{const j=await request('/builder/jobs/'+(p.jobId||p.id));if(deletedProjects.has(p.id))return;if(j.topics)await rememberIdeas(j);Object.assign(p,j,{id:p.id});if(j.state==='failed')delete p.topics;if(j.project){p.project=B.validateProject(B.normalizeLegacySceneHeadings(j.project,p.setup),p.setup);p.state='prompts_ready';}await store('put',p);await showContinuation();if(dialog.open&&selected?.id===p.id)await openProject(p);}catch(e){error(e);}}
  function download(p){const {media,...data}=p;data.media=Object.fromEntries(Object.entries(media).map(([id,m])=>[id,{name:m.name,sha256:m.sha256}]));const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=el('a');a.href=url;a.download='faceless-'+p.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function saveFile(name,content,type='text/plain'){const url=URL.createObjectURL(content instanceof Blob?content:new Blob([content],{type}));const a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  function exportText(p,kind){
    const groups={references:[p.project.assets,'imagePrompt'],scenes:[p.project.scenes,'imagePrompt'],videos:[p.project.scenes,'videoPrompt']};
    const group=groups[kind];if(!group)throw Error('Choose a prompt type to download.');
    // Owner 2026-11-04: readable file with a "SCENE n — VIDEO PROMPT" heading over each prompt and its own line breaks kept.
    // The prompt importer (lib/parsers.js) skips the heading blocks, so the file still loads as one prompt per scene.
    const rule='═'.repeat(40),title={references:'REFERENCE',scenes:'SCENE',videos:'SCENE'}[kind],what={references:'IMAGE PROMPT',scenes:'START FRAME IMAGE PROMPT',videos:'VIDEO PROMPT'}[kind];
    const prompts=group[0].map(x=>String(x[group[1]]||'').replace(/\r\n?/g,'\n').split('\n').map(l=>l.replace(/[ \t]+/g,' ').trim()).filter(Boolean).join('\n')).filter(Boolean);
    if(!prompts.length)throw Error('No '+({references:'character or reference',scenes:'scene image',videos:'video'}[kind])+' prompts in this project.');
    const head=(p.project.title?p.project.title+'\n':'')+prompts.length+' '+what.toLowerCase()+(prompts.length===1?'':'s');
    saveFile('faceless-'+p.id+'-'+kind+'.txt',head+'\n\n'+prompts.map((x,i)=>rule+'\n'+title+' '+(i+1)+' — '+what+'\n'+rule+'\n\n'+x).join('\n\n\n')+'\n');
  }
  function exportCsv(p){const rows=[['scene','duration_seconds','speech','caption','image_prompt','video_prompt','references'],...p.project.scenes.map(s=>[s.id,s.durationSeconds,s.speech,s.caption,s.imagePrompt,s.videoPrompt,s.references.join(';')])];const cell=v=>{let text=String(v);if(/^\s*[=+\-@]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};saveFile('faceless-'+p.id+'.csv','\uFEFF'+rows.map(r=>r.map(cell).join(',')).join('\r\n'),'text/csv');}
  function exportImages(p){const records=Object.values(p.media);if(!records.length)throw Error('No generated or uploaded images to save yet.');for(const m of records)saveFile(m.name,m.blob);}
  // quietLoad: the blocked-start-image fix replaces its own finished queue (it still lists the blocked scene as an error)
  // without asking (owner 2026-10-24: "Replace the current prompt queue?" stopped the automatic new image).
  let quietLoad=false;
  // A native confirm() from the panel stalls phone browsers (2026-10-31 finding D: the sheet freezes and the
  // queue never starts), so phones get this in-page dialog instead; desktop keeps window.confirm.
  function mobileQueueConfirm(text){
    return new Promise((resolve,reject)=>{
      const popup=el('dialog',undefined,'fb-limit-dialog'),actions=el('div',undefined,'fb-limit-actions');let accepted=false;
      const title=el('h3','Replace the queue?');title.id='fb-replace-title';popup.setAttribute('aria-labelledby',title.id);
      const cancel=button('Keep current',()=>popup.close()),proceed=button('Replace queue',()=>{accepted=true;popup.close();});proceed.classList.add('fb-primary');
      actions.append(cancel,proceed);popup.append(title,el('p',text),actions);
      popup.addEventListener('close',()=>{popup.remove();resolve(accepted);},{once:true});
      document.body.append(popup);try{popup.showModal();cancel.focus();}catch(e){popup.remove();reject(e);}
    });
  }
  async function guard(){if(globalThis.MobileFlowPilot?.isActive?.())throw Error('Stop the mobile background queue first.');if(running)throw Error('Stop the active run before loading a builder queue.');
    if(!quietLoad&&queue.some(x=>x.status==='pending'||x.status==='error')){
      const question='Replace the current prompt queue with this project?';
      if(typeof mobileOverlayDevice==='function'&&mobileOverlayDevice()){if(!await mobileQueueConfirm(question))return false;}
      else if(!confirm(question))return false;
    }if(running)throw Error('Stop the active run before loading a builder queue.');return true;}
  async function imageData(m){const dataUrl=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(m.blob);});return {name:globalThis.FacelessBuilder?.flowName?.(m)??m.name,type:m.blob.type,size:m.blob.size,dataUrl};}
  // Google Vids accepts only PNG or JPEG references: other saved formats (WebP, AVIF) are redrawn as PNG; the name stays.
  async function vidsImageData(m){
    if(/^image\/(png|jpeg)$/i.test(m.blob?.type||''))return imageData(m);
    const bitmap=await createImageBitmap(m.blob),canvas=new OffscreenCanvas(bitmap.width,bitmap.height);canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close?.();
    return imageData({...m,blob:await canvas.convertToBlob({type:'image/png'})});
  }
  // Builder references are attached by validated IDs, not by AI-written @ aliases.
  function builderQueueText(text){return String(text).replace(/@(?=[\p{L}\p{N}_-])/gu,'');}
  // Wide 16:9 stories (owner 2026-11-10): the prompts are written for 9:16; story-shape.js (globalThis.StoryShape) rewords
  // the frame when a queue is loaded. Vertical stories are untouched.
  const SAFER_LOOK='Every person is a clearly adult, ordinary-looking original fictional character with a mature face; no celebrity likeness, no idol styling, no youthful or teenage appearance.';
  // Video → Story parts share their character sheets (owner 2026-11-07); see B.reverseShared.
  async function shareReverseSheets(p,options){
    if(!p?.reverseBatchId||!B.reverseShared)return 0;
    const all=await store('getAll'),found=B.reverseShared(p,all,options),byId=new Map(all.map(x=>[x.id,x]));
    const ids=Object.keys(found);if(!ids.length)return 0;
    p.media={...p.media};for(const id of ids)p.media[id]=byId.get(found[id]).media[id];
    if(p.redoIds?.length)p.redoIds=p.redoIds.filter(id=>!ids.includes(id));
    p.imagesReviewed=false;await store('put',p);return ids.length;
  }
  async function loadImages(p,stage,selectedIds=null){
    if(stage==='assets'&&!selectedIds&&p.reverseBatchId)await shareReverseSheets(p);
    const folderName=typeof storyFolder==='function'?await storyFolder(p):'';
    if(p.libraryCastReview)throw Error('Review and apply or skip your saved character references in AI Story first.');
    if(!await guard())return;p.project=B.validateProject(p.project,p.setup);
    if(p.setup.imageMode==='Prompts only')throw Error('This project is set to prompts only. Export its prompts or create a project with image generation enabled.');
    if(stage==='scenes'&&p.project.assets.some(x=>(!p.media?.[x.id]||(p.redoIds||[]).includes(x.id))))throw Error('Generate or upload every recurring asset first.');
    if(selectedIds&&(!selectedIds.length||selectedIds.some(id=>!p.project[stage].some(x=>x.id===id))))throw Error('Choose a valid image to regenerate.');
    if(stage==='assets'&&p.project.assets.some(x=>isProductReference(p,x.id)&&(!p.media?.[x.id]||(p.redoIds||[]).includes(x.id))))throw Error('Upload the original product image in its reference card. It cannot be AI-regenerated.');
    if(stage==='assets'&&selectedIds?.some(id=>isProductReference(p,id)))throw Error('Your product image cannot be AI-regenerated. Replace it with an uploaded image.');
    let entries=p.project[stage].filter(x=>selectedIds?selectedIds.includes(x.id):(!p.media?.[x.id]||(p.redoIds||[]).includes(x.id)));if(!entries.length)throw Error('All images in this stage are already saved.');
    const usesRefs=stage==='scenes'&&Boolean(entries[0].references.length);
    if(stage==='scenes')entries=entries.filter(x=>Boolean(x.references.length)===usesRefs);
    // Five-view character sheets (Tagalog Drama, DramaFactory standard) are square; every other card stays 9:16. One aspect
    // per queue, so the sheets run as their own batch first (Auto then starts the rest by itself).
    const isSheet=x=>/character reference sheet/i.test(x.imagePrompt||'');
    if(stage==='assets'&&entries.some(isSheet)&&!entries.every(isSheet))entries=entries.filter(isSheet);
    const aspect=!!globalThis.StoryShape?.isLandscape(p)?'landscape':stage==='assets'&&entries.every(isSheet)?'square':'portrait';
    // A new image for a blocked scene copies the people from the nearest frames whose videos PASSED (owner 2026-10-24: a new
    // image from the text alone changed every face). Used only when every chosen scene has such neighbours.
    const lookRefs=new Map(),passed=new Set(p.videoDoneIds||[]),safeIds=p.imageSafeIds||[];
    if(stage==='scenes'&&selectedIds)for(const x of entries){
      if(!safeIds.includes(x.id))continue;
      const at=p.project.scenes.findIndex(s=>s.id===x.id);
      const near=p.project.scenes.map((s,j)=>({id:s.id,d:Math.abs(j-at),after:j>at})).filter(c=>c.id!==x.id&&p.media[c.id]&&passed.has(c.id)&&!safeIds.includes(c.id)).sort((a,b)=>a.d-b.d||a.after-b.after).slice(0,2).map(c=>c.id);
      if(near.length)lookRefs.set(x.id,near);
    }
    if(lookRefs.size!==entries.length)lookRefs.clear();
    const lookIds=[...new Set([...lookRefs.values()].flat())],withRefs=usesRefs||lookIds.length>0;
    const loaded=[...(usesRefs?await Promise.all(p.project.assets.map(x=>imageData(p.media[x.id]))):[]),...await Promise.all(lookIds.map(id=>imageData(p.media[id])))];
    // Grok images in AI Story (owner 2026-11-01): Grok is an optional site permission, asked once like Grok videos.
    if(B.generationTargets(p.target,settings).imagePlatform==='grok'&&typeof ensureGrokAccess==='function'&&!await ensureGrokAccess())throw Error('Allow Grok access before loading images.');
    if(running)throw Error('Stop the active run before loading a builder queue.');images=loaded;
    settings.platform=B.generationTargets(p.target,settings).imagePlatform;
    settings.mode=withRefs?'image-to-image':'text-to-image';settings.aspectRatio=aspect;loadSettingsIntoForm();
    // Storyboard sheets (Pro, owner 2026-10-23): four scenes per Flow image, cut into frames when saved. Crowded scenes,
    // a short remainder and scenes whose sheet already ran once (refused or not a clean grid) get single images.
    let groups=entries.map(x=>[x]),sheetText=null;
    // Pro status may not be loaded yet right after the panel opens: fetch it before deciding (owner 2026-10-25).
    if(stage==='scenes'&&!selectedIds&&p.sceneImageMode==='sheets'&&typeof usageRefresh==='function'&&!(typeof usageState!=='undefined'&&usageState?.unlimited))await usageRefresh(true).catch(()=>{});
    if(stage==='scenes'&&!selectedIds&&p.sceneImageMode==='sheets'&&!sheetsAvailable(p).ok&&typeof log==='function')log('Builder: storyboard sheets are selected but not available here ('+(sheetsAvailable(p).pro?'platform or project type':sheetsAvailable(p).trial?'this month\'s free sheets are used':'Pro status not confirmed')+'); making single images.');
    if(stage==='scenes'&&!selectedIds&&sheetsAvailable(p).ok&&p.sceneImageMode==='sheets'){
      const S=await import('./lib/storyboard-sheets.mjs'),byId=new Map(entries.map(x=>[x.id,x]));
      groups=S.planSheets(entries,p.project.assets,{tried:p.sheetTriedIds||[]}).map(g=>g.ids.map(id=>byId.get(id)));
      // Discord Pro: storyboard sheets per day (usage-limit.js, owner 2026-10-25); sheets past the allowance run as singles.
      const planned=groups.filter(g=>g.length>1).length,cap=planned&&typeof sheetsAllowed==='function'?await sheetsAllowed(planned):planned;
      if(cap<planned){let k=0;groups=groups.flatMap(g=>g.length>1&&++k>cap?g.map(x=>[x]):[g]);if(typeof sheetsLimitReached==='function')sheetsLimitReached(cap,sheetsNudge(cap).replace('the other prompts','the other scenes'));}
      const sheets=groups.filter(g=>g.length>1);
      // Scenes are marked "sheet tried" only when their sheet FAILED (end of run, below). Marking them here at load time left
      // them marked after an extension reload, a stop or a rebuild, so later runs quietly made single images until the
      // owner switched to one-per-scene and back (owner report 2026-10-25).
      if(!sheets.length&&typeof log==='function')log('Builder: storyboard sheets selected, but every scene is crowded (4+ people) or already had a failed sheet; making single images.');
      sheetText=g=>S.sheetPrompt(g,p.project.assets,{platform:settings.platform,story:p.project.scenes,voice:p.project.voice,castLooks:p.project.castLooks||[],wide:!!globalThis.StoryShape?.isLandscape(p)});
    }
    if(running)throw Error('Stop the active run before loading a builder queue.');
    // A scene whose start image was blocked by the video model gets a safer new image (also from ↻ Regenerate).
    // A scene with children (owner 2026-10-26: refused twice for 'content related to minors', kids in a sando/undershirt)
    // gets a child-safe note instead of "All characters are adults", and the kids' clothes are not copied from the frames.
    const kids=g=>/\b(?:girl|boy|child|children|kid|kids|toddler|baby|infant|daughter|son)\b|\b(?:[1-9]|1[0-7])\s*-?\s*years?\s*old\b/i.test(g[0].imagePrompt+' '+(p.project.scenes.find(s=>s.id===g[0].id)?.videoPrompt||''));
    const KIDS_SAFE='The children wear plain, fully covering t-shirts and everyday clothes and are safe in a calm, ordinary moment; the adults are clearly adult; all are original fictional characters with no celebrity likeness.';
    const safer=g=>g.length!==1||!safeIds.includes(g[0].id)?'':lookRefs.has(g[0].id)
      ?' Keep exactly the same people as in the attached frames '+lookRefs.get(g[0].id).map(id=>globalThis.FacelessBuilder?.flowName?.(p.media[id])??p.media[id].name).join(' and ')+' (the scenes around this one): the same faces, hair'+(kids(g)?', room and adult clothes. '+KIDS_SAFE:', clothes and room. All characters are adults.')
      :' '+(kids(g)?KIDS_SAFE:SAFER_LOOK);
    let SS=null;if(stage==='scenes')try{SS=await import('./lib/storyboard-sheets.mjs');}catch{}const clothes=g=>SS&&g.length===1?SS.sceneClothesLine({...g[0],videoPrompt:p.project.scenes.find(x=>x.id===g[0].id)?.videoPrompt||g[0].videoPrompt}):'';   // single scene images name the scene's clothes (owner 2026-10-26)
    const prompts=groups.map(g=>({text:(t=>globalThis.StoryShape?globalThis.StoryShape.text(p,t):t)(builderQueueText(g.length>1?sheetText(g):g[0].imagePrompt)+clothes(g)+safer(g)),imageName:''}));$('promptText').value=prompts.map(x=>x.text).join('\n\n');applyPromptsToQueue(prompts);
    queue.forEach((item,i)=>{const g=groups[i],refs=[...new Set([...g.flatMap(x=>x.references||[]),...(g.length===1?lookRefs.get(g[0].id)||[]:[])])];Object.assign(item,{builderProjectId:p.id,builderFolder:folderName,builderImageId:g[0].id,builderPartNumber:Number(p.setup.partNumber||1),plannedOutputName:g.length>1?'sheet_'+g[0].id+'-'+g.at(-1).id.slice(-3)+'.png':g[0].id+'.png',referenceNames:refs.map(id=>globalThis.FacelessBuilder?.flowName?.(p.media[id])??p.media[id].name)},g.length>1?{builderSheetIds:g.map(x=>x.id)}:{});});
    renderImages();renderQueue();schedulePersist();dialog.close();await chrome.storage.local.set({facelessActiveProjectId:p.id,facelessDismissedProjectId:''});await showContinuation();return true;
  }
  function reviewImages(p){return p.setup.exportProfile==='Recurring assets + video'?p.project.assets:[...p.project.assets,...p.project.scenes];}
  async function attach(p,id,blob,ext){const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());p.media[id]={blob,name:'p'+String(p.setup.partNumber||1).padStart(2,'0')+'_'+id+'.'+ext,sha256:Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('')};if(id.startsWith('asset_')&&p.project.scenes.some(s=>s.references.includes(id)&&p.media[s.id]))p.staleSceneIds=[...new Set([...(p.staleSceneIds||[]),...p.project.scenes.filter(s=>s.references.includes(id)&&p.media[s.id]).map(s=>s.id)])];else if(id.startsWith('scene_'))p.staleSceneIds=(p.staleSceneIds||[]).filter(x=>x!==id);p.videoDoneIds=id.startsWith('asset_')?[]:(p.videoDoneIds||[]).filter(sceneId=>sceneId!==id);p.imagesReviewed=false;if(p.redoIds?.length){p.redoIds=p.redoIds.filter(x=>x!==id);if(!p.redoIds.length)delete p.redoPrevState;}p.state=reviewImages(p).every(x=>!(!p.media?.[x.id]||(p.redoIds||[]).includes(x.id)))?'images_generated':'prompts_ready';await store('put',p);}
  // Pro only. Flow sheets are downloaded in 2K (frames ~765x1373); ChatGPT sheets come as 941x1672 (frames ~468x834,
  // slightly softer; owner tested the video and accepted it 2026-10-24). Gemini and Grok are not supported yet.
  function sheetsAvailable(p){
    const pro=typeof usageState!=='undefined'&&!!usageState?.unlimited,platform=B.generationTargets(p.target,settings).imagePlatform,supported=['flow','chatgpt'].includes(platform);
    // ChatGPT draws a consistent 2x2 only when it knows the people: with character pictures it works; a direct-scene story
    // (no characters, names only) got "the image tool requires an image reference" / "couldn't generate" (owner 2026-10-24).
    const noCast=platform==='chatgpt'&&!p.project?.assets?.length&&!(p.project?.scenes||[]).some(s=>/CHARACTERS\s*[—–-][\s\S]*?Screen side/.test(s.videoPrompt||''));   // drama video prompts name the looks
    // Owner 2026-10-30: signed-in Free accounts may use their monthly free sheets (the same 5 as Control) in AI Story too;
    // sheetsAllowed() caps the run at what is left and featureRecord() counts each sheet that worked.
    const f=typeof featureState!=='undefined'?featureState:null,trial=!pro&&f?.plan==='free'&&!!f.sheets?.included&&!f.sheets?.unlimited&&!!globalThis.FlowGoogleSignIn?.current?.()?.signedIn,left=trial?Math.max(0,Number(f.sheets.remaining)||0):0;
    const wide=!!globalThis.StoryShape?.isLandscape(p);   // wide stories get 16:9 sheets (owner 2026-11-11)
    return {ok:(pro||left>0)&&supported&&!noCast&&p.setup.exportProfile!=='Recurring assets + video',wide,pro,trial,left,limit:trial?Number(f.sheets.limit)||0:0,flow:supported,platform,noCast};
  }
  function captureSheet(item,buf){
    const write=mediaWrites.catch(()=>{}).then(async()=>{
      const p=(await store('getAll')).find(x=>x.id===item.builderProjectId),ids=item.builderSheetIds;
      if(!p||!ids.every(id=>p.project.scenes.some(x=>x.id===id)))throw Error('Builder project no longer exists.');
      const S=await import('./lib/storyboard-sheets.mjs'),bitmap=await createImageBitmap(new Blob([buf]));
      const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0);
      const grid=S.findGrid(ctx.getImageData(0,0,bitmap.width,bitmap.height),{wide:!!globalThis.StoryShape?.isLandscape(p)});
      const say=m=>{if(typeof log==='function')log(item.id+': '+m);};
      if(grid.ok&&typeof featureRecord==='function')featureRecord('sheets',1);   // a sheet that worked uses one of the day's sheets
      if(!grid.ok){item.sheetUnusable=true;const again=!ids.some(id=>(p.sheetMisses||{})[id]);say('storyboard sheet not usable ('+grid.reason+'); '+ids.join(', ')+(again?' will be asked once more as a sheet next.':' will be made as single images next.'));return;}
      let upscaled=0;const each=[];
      for(const [i,box] of grid.boxes.entries()){
        const frame=new OffscreenCanvas(box.w,box.h);frame.getContext('2d').drawImage(bitmap,box.x,box.y,box.w,box.h,0,0,box.w,box.h);
        // Small ChatGPT frames are AI-upscaled 2x first (control.js upscaleSheetFrame; owner 2026-10-25).
        const up=typeof upscaleSheetFrame==='function'?await upscaleSheetFrame(frame,{type:'image/jpeg',quality:0.93}):null;if(up){upscaled++;each.push(up.seconds.toFixed(1));}
        const blob=up?.blob||await frame.convertToBlob({type:'image/jpeg',quality:0.93});
        await attach(p,ids[i],blob,'jpg');   // PNG frames were ~2 MB each
        // Also saved in the user's output folder next to the sheet, named like a single scene image (p01_scene_001.jpg;
        // owner 2026-10-25). skipBuilderCapture: the frame is already attached above (capturing again inside this write
        // chain would wait on itself).
        if(typeof saveOutput==='function')await saveOutput({...item,builderSheetIds:null,builderImageId:ids[i],skipBuilderCapture:true,text:p.project.scenes.find(x=>x.id===ids[i])?.imagePrompt||''},await blob.arrayBuffer(),'jpg').catch(e=>say('scene frame '+ids[i]+' is in the story but could not be saved to the folder ('+e.message+').'));
      }
      // Each frame's time and, once, the graphics chip, like the manual queue log (owner 2026-10-25: ~13 s per frame here
      // where an idle RTX 4050 takes ~2 s).
      let timing='';
      if(upscaled){const first=typeof upscaleEngineStarted!=='undefined'&&!upscaleEngineStarted,gpu=typeof upscaleGpuLogged!=='undefined'&&!upscaleGpuLogged?(upscaleGpuLogged=true,(await import('./lib/upscale.mjs')).graphicsName()):'';
        timing='; upscale '+each.join(' + ')+' s'+(first?', the first includes the engine start':'')+(gpu?'; graphics: '+gpu:'');if(typeof upscaleEngineStarted!=='undefined')upscaleEngineStarted=true;}
      say('storyboard sheet cut into '+ids.length+' scene frames ('+grid.boxes[0].w+'x'+grid.boxes[0].h+(upscaled?', AI-upscaled to '+grid.boxes[0].w*2+'x'+grid.boxes[0].h*2+timing:grid.boxes[0].w<600?', smaller than a normal scene image':'')+').');
    });mediaWrites=write;return write;
  }
  function captureImage(item,buf,ext){if(item.builderCoverRequestId)return captureCover(item,buf,ext);if(item.builderSheetIds)return captureSheet(item,buf);const write=mediaWrites.catch(()=>{}).then(async()=>{const p=(await store('getAll')).find(x=>x.id===item.builderProjectId);if(!p||![...p.project.assets,...p.project.scenes].some(x=>x.id===item.builderImageId))throw Error('Builder project no longer exists.');await attach(p,item.builderImageId,new Blob([buf],{type:'image/'+(ext==='jpg'?'jpeg':ext)}),ext);});mediaWrites=write;return write;}
  function captureCover(item,buf,ext){
    const write=mediaWrites.catch(()=>{}).then(async()=>{
      if(!(await store('getAll')).some(p=>p.id===item.builderProjectId))throw Error('This story no longer exists.');
      const workspace=await import('./lib/story-workspace.mjs');
      await workspace.saveGeneratedCover(item.builderProjectId,item.builderCoverRequestId,new Blob([buf],{type:'image/'+(ext==='jpg'?'jpeg':ext)}),{headline:item.builderCoverHeadline,position:item.builderCoverPosition});
      item.workspaceCoverCaptured=true;
    });mediaWrites=write;return write;
  }
  async function generateCover(projectId,options){
    if(busy||running)throw Error('Wait for the current run to finish.');
    if(queue.some(item=>['pending','error','running'].includes(item.status)))throw Error('Finish or clear the current queue in Control before generating a cover.');
    busy=true;
    try{
      await mediaWrites.catch(()=>{});
      const p=(await store('getAll')).find(x=>x.id===projectId);if(!p?.project)throw Error('This story no longer exists.');
      const kit=await import('./lib/publish-kit.mjs'),workspace=await import('./lib/story-workspace.mjs');
      if(!['flow','gemini','chatgpt'].includes(options?.platform))throw Error('Choose Flow, Gemini or ChatGPT for the cover.');
      if(typeof options.requestId!=='string'||!/^[a-zA-Z0-9-]{10,80}$/.test(options.requestId))throw Error('Invalid cover request.');
      const text=kit.coverPrompt(p,options),refs=options.referenceIds;
      const loaded=await Promise.all(refs.map(id=>imageData(p.media[id])));
      if(running)throw Error('Wait for the current run to finish.');
      await saveAutoRun({on:false});
      await workspace.requestCover(p.id,options.requestId);
      images=loaded;settings.platform=options.platform;settings.mode=refs.length?'image-to-image':'text-to-image';settings.aspectRatio=globalThis.StoryShape?globalThis.StoryShape.aspect(p,'portrait'):'portrait';settings.flowOutputCount=1;loadSettingsIntoForm();
      $('promptText').value=builderQueueText(text);applyPromptsToQueue([{text:builderQueueText(text),imageName:''}]);
      Object.assign(queue[0],{builderProjectId:p.id,builderFolder:typeof storyFolder==='function'?await storyFolder(p):'',builderImageId:'cover',builderCoverRequestId:options.requestId,builderCoverHeadline:kit.coverTitle(p,options.headline),builderCoverPosition:options.position==='top'?'top':'bottom',builderPartNumber:Number(p.setup.partNumber||1),referenceNames:refs.map(id=>globalThis.FacelessBuilder?.flowName?.(p.media[id])??p.media[id].name)});
      renderImages();renderQueue();schedulePersist();dialog.close();
      await startQueue();if(!running&&!queue[0]?.workspaceCoverCaptured)throw Error('Check Control for the pre-start requirements, then press Start. Your previous cover is kept.');
    }finally{busy=false;}
  }
  async function savedVideoIds(p,workspace=null){
    const valid=new Set(p.project.scenes.map(s=>s.id));
    const done=new Set((p.state==='videos_finished'?[...valid]:p.videoDoneIds||[]).filter(id=>valid.has(id)));
    try{
      workspace ||= await import('./lib/story-workspace.mjs');
      for(const clip of await workspace.clips(p.id))if(valid.has(clip.sceneId)&&clip.blob?.size&&clip.sourceVersion===workspace.sceneVersion(p,clip.sceneId))done.add(clip.sceneId);
    }catch(e){console.warn('Builder saved video recovery:',e);}
    return [...done];
  }
  // A repair may swap a few spoken words as a last resort (owner 2026-10-23). Keep the scene's speech (subtitles) and prompt
  // in step with the video that was actually generated; only when the old speech is exactly the original quoted lines.
  function repairedDialogue(p,item){
    const quotes=t=>[...String(t||'').matchAll(/"([^"\n]+)"|“([^”\n]+)”/g)].map(m=>m[1]||m[2]);
    const scene=p.project?.scenes?.find(s=>s.id===item.builderSceneId),before=quotes(item.originalText),after=quotes(item.text);
    if(!scene||!item.originalText||Number(p.setup?.partNumber||1)!==Number(item.builderPartNumber||1))return;
    if(!before.length||before.length!==after.length||before.join('\n')===after.join('\n')||scene.speech!==before.join(' '))return;
    // Only the spoken lines go back into the saved prompt. The queue text also carries Flow's @picture tags, the wide-story
    // wording and the pronunciation line; copying it whole saved "@" into the story (user report 2026-11-18).
    if(after.some(q=>q.includes('@')))return;
    let prompt=String(scene.videoPrompt||''),from=0;
    for(let i=0;i<before.length;i++){const at=prompt.indexOf(before[i],from);if(at<0)return;prompt=prompt.slice(0,at)+after[i]+prompt.slice(at+before[i].length);from=at+after[i].length;}
    scene.speech=after.join(' ');scene.videoPrompt=prompt;return true;
  }
  function captureVideo(item,buf,ext='mp4'){
    const write=mediaWrites.catch(()=>{}).then(async()=>{
      const workspace=await import('./lib/story-workspace.mjs');
      // A repaired scene gets its new dialogue BEFORE the clip is saved: a clip is marked with the scene version it was made
      // from, so saving first made Story Workspace treat a repaired scene's video as outdated (owner 2026-10-28, scene 4).
      const p=(await store('getAll')).find(x=>x.id===item.builderProjectId);
      if(p&&repairedDialogue(p,item))await store('put',p);
      await workspace.putClip(item.builderProjectId,item.builderSceneId,new Blob([buf],{type:'video/'+ext}),`p${String(item.builderPartNumber||1).padStart(2,'0')}_${item.builderSceneId}.${ext}`);item.workspaceVideoCaptured=true;
      if(p){p.videoDoneIds=await savedVideoIds(p,workspace);await store('put',p);}
    });mediaWrites=write;return write;
  }
  const manualModule=()=>import('./lib/manual-projects.mjs');
  let manualPreparing=false;
  async function manualInput(item){
    const M=await manualModule();let chosen=imagesForItem(item);
    if(settings.mode==='frame-to-video')chosen=chosen.slice(0,1);
    return M.snapshotInput(item,settings,chosen);
  }
  async function prepareManualQueue(){
    if(!['text-to-video','frame-to-video','ingredients-to-video'].includes(settings.mode)||queue.some(x=>x.builderProjectId))return;
    if(manualPreparing)throw Error('The manual project is still being saved.');manualPreparing=true;
    try{
      const M=await manualModule(),items=queue.filter(x=>!x.groupParent),list=queue;
      if(!items.length)return;
      if(items.every(x=>x.manualProjectId===items[0].manualProjectId)&&items[0].manualProjectId){
        const p=(await store('getAll')).find(x=>x.id===items[0].manualProjectId);if(M.isManual(p)){await saveAutoRun({on:false});return;}
      }
      if(items.length<5)return;
      const inputs=await Promise.all(items.map(manualInput)),carry=[];
      const S=await import('./lib/story-workspace.mjs');
      for(let i=0;i<items.length;i++)if(items[i].status==='done'&&items[i].manualProjectId){
        const old=(await store('getAll')).find(p=>p.id===items[i].manualProjectId),scene=old?.project.scenes.find(s=>s.id===items[i].manualSceneId);
        const clip=scene&&(await S.clips(old.id)).find(c=>c.sceneId===scene.id&&c.blob?.size&&c.sourceVersion===S.sceneVersion(old,scene.id));
        if(clip){inputs[i]={...inputs[i],text:scene.videoPrompt,references:scene.references.map(id=>old.media[id]),duration:scene.durationSeconds};carry.push({index:i,clip});}
      }
      const p=M.createProject(items,settings,inputs);
      if(typeof outputDir!=='undefined'&&outputDir){p.manual.outputDirectory=outputDir;p.manual.outputDirectoryName=outputDirName;}
      await store('put',p);if(queue!==list)throw Error('The queue changed while saving. Press Start again.');
      items.forEach((item,i)=>Object.assign(item,{manualProjectId:p.id,manualSceneId:p.project.scenes[i].id}));
      for(const {index,clip} of carry)await S.putClip(p.id,p.project.scenes[index].id,clip.blob,clip.name);
      if(carry.length)await store('put',M.reconcile(p,items,await S.clips(p.id),S.sceneVersion));
      await saveAutoRun({on:false});await chrome.storage.local.set({facelessActiveProjectId:p.id,facelessDismissedProjectId:''});
      log('Manual project saved locally: '+p.project.title);queueChanged();
    }finally{manualPreparing=false;}
  }
  async function rememberManualInput(item){
    if(!item.manualProjectId)return;
    const input=await manualInput(item),write=mediaWrites.catch(()=>{}).then(async()=>{
      const p=(await store('getAll')).find(x=>x.id===item.manualProjectId);if(!p)throw Error('The manual project was deleted.');
      p.manual.inputs[item.manualSceneId]=input;await store('put',p);
    });mediaWrites=write;await write;
  }
  function captureManualVideo(item,buf,ext='mp4'){
    const write=mediaWrites.catch(()=>{}).then(async()=>{
      const M=await manualModule(),S=await import('./lib/story-workspace.mjs'),p=(await store('getAll')).find(x=>x.id===item.manualProjectId);
      if(!M.isManual(p))throw Error('The manual project was deleted.');
      const input=p.manual.inputs[item.manualSceneId],next=input?M.commitInput(p,item.manualSceneId,input):p;
      await store('put',next);
      try{await S.putClip(p.id,item.manualSceneId,new Blob([buf],{type:'video/'+ext}),'p01_'+item.manualSceneId+'.'+ext);}
      catch(e){await store('put',p);throw e;}
      item.workspaceVideoCaptured=true;
      await store('put',M.reconcile(next,queue,await S.clips(p.id),S.sceneVersion));
    });mediaWrites=write;return write;
  }
  async function finishManualQueue({clean=false}={}){
    if(!['text-to-video','frame-to-video','ingredients-to-video'].includes(settings.mode))return false;
    const ids=[...new Set(queue.map(x=>x.manualProjectId).filter(Boolean))];if(!ids.length)return false;
    await mediaWrites.catch(()=>{});const M=await manualModule(),S=await import('./lib/story-workspace.mjs'),queueNow=queue;
    for(const id of ids){const p=(await store('getAll')).find(x=>x.id===id);if(!M.isManual(p))continue;
      const next=M.reconcile(p,queue,await S.clips(id),S.sceneVersion);
      if(settings.chainLastFrame&&typeof chainedFrame!=='undefined'&&chainedFrame?.b64){const input=await M.snapshotInput({text:''},settings,[{name:'manual-last-frame.png',dataUrl:'data:image/png;base64,'+chainedFrame.b64}]);next.manual.resumeFrame=input.references[0];}
      await store('put',next);
      if(clean&&ids.length===1&&next.state==='videos_finished'&&queue===queueNow&&!running){
        if(typeof hideMiniProgress==='function')await hideMiniProgress();
        if(queue===queueNow&&!running)await openStoryWorkspace(next,{auto:true});
      }
    }
    await showContinuation();return true;
  }
  async function loadManualVideos(p,ids=null){
    if(running)throw Error('Wait for the active generation to finish.');if(!await guard())return false;
    const M=await manualModule(),S=await import('./lib/story-workspace.mjs');p=M.reconcile(p,[],await S.clips(p.id),S.sceneVersion);
    const wanted=ids||p.project.scenes.filter(s=>!p.videoDoneIds.includes(s.id)&&p.manual.scenes[s.id]?.status!=='done').map(s=>s.id);if(!wanted.length){await openStoryWorkspace(p,{auto:true});return false;}
    const entries=M.restoredEntries(p,wanted),snapshot=ids?.length===1?p.manual.inputs[ids[0]]?.settings:null;
    settings=sanitizeSettings(snapshot||p.manual.settings);settings.chainLastFrame=ids?false:Boolean(p.manual.settings.chainLastFrame);
    const resume=!ids&&settings.chainLastFrame&&!p.manual.inputs[entries[0].manualSceneId]&&p.manual.resumeFrame;
    if(resume)entries[0].referenceNames=[resume.name];
    const sources=entries.flatMap((e,i)=>{if(i===0&&resume)return [resume];const scene=p.project.scenes.find(s=>s.id===e.manualSceneId),input=p.manual.inputs[scene.id];return input?.references||scene.references.map(id=>p.media[id]);});
    const unique=new Map();for(const image of sources){const prior=unique.get(image.name);if(prior&&prior.sha256!==image.sha256)throw Error('Saved references share a name with different images. Restore these scenes separately.');unique.set(image.name,image);}
    if(typeof outputDir!=='undefined'){outputDir=p.manual.outputDirectory||null;outputDirName=p.manual.outputDirectoryName||'';}
    images=await Promise.all([...unique.values()].map(imageData));loadSettingsIntoForm();$('promptText').value=entries.map(e=>e.text).join('\n\n');applyPromptsToQueue(entries);
    // A saved frame wins over last-frame chaining only where the scene really has one: it was attempted before, or it is the
    // first scene of a resumed chain (the saved last frame). Later never-attempted scenes of a resumed chain keep chaining from
    // the video made just before them (Claude 2026-10-23: scene 3 restarted from the story's first image).
    queue.forEach((item,i)=>Object.assign(item,{manualProjectId:p.id,manualSceneId:entries[i].manualSceneId,referenceNames:entries[i].referenceNames,videoMode:entries[i].videoMode,manualRestoreFrame:Boolean(!settings.chainLastFrame||(i===0&&resume)||p.manual.inputs[entries[i].manualSceneId])}));
    renderImages();renderQueue();schedulePersist();await saveAutoRun({on:false});await chrome.storage.local.set({facelessActiveProjectId:p.id,facelessDismissedProjectId:''});return true;
  }
  async function runManualVideos(p,ids=null){if(await loadManualVideos(p,ids)){dialog.close();await startQueue();}}
  async function openManualProject(p){
    selected=p;clearTimeout(pollTimer);projectRenderRevision++;body.replaceChildren();message.textContent='';
    const M=await manualModule(),S=await import('./lib/story-workspace.mjs');p=M.reconcile(p,[],await S.clips(p.id),S.sceneVersion);await store('put',p);
    body.append(el('span','MANUAL','fb-standalone-tag'),userText('h3',p.project.title),el('p',p.videoDoneIds.length+'/'+p.project.scenes.length+' clips saved on this device. Prompts and reference images are kept with this project.','fb-muted'));
    const name=el('input');name.value=p.project.title;name.maxLength=100;name.setAttribute('aria-label','Manual project name');const rename=button('Save name',async()=>{if(running)throw Error('Wait for the active run to finish.');const latest=(await store('getAll')).find(x=>x.id===p.id);if(!latest)throw Error('This project was deleted.');latest.project.title=name.value.trim()||latest.project.title;await store('put',latest);await openManualProject(latest);});name.disabled=rename.disabled=running;body.append(name,rename);
    if(p.project.scenes.some(s=>!p.videoDoneIds.includes(s.id)&&p.manual.scenes[s.id]?.status==='done'))body.append(el('p','Some videos finished without a workspace copy. Add their existing clips in Story Workspace. Retry unfinished will not regenerate those videos.','fb-muted'));
    body.append(button('↗ Open Story Workspace',()=>openStoryWorkspace(p)),button('Retry unfinished videos',()=>runManualVideos(p)),button('Delete project',()=>deleteProject(p)),button('Back to projects',()=>home('projects')));
    for(const scene of p.project.scenes){const card=el('details'),status=p.manual.scenes[scene.id];card.append(el('summary',scene.id+' · '+(p.videoDoneIds.includes(scene.id)?'Saved':status?.detail||'Not saved')),el('p',p.manual.inputs[scene.id]?.text||scene.videoPrompt));body.append(card);}
  }
  async function approve(p){if(p.libraryCastReview)throw Error('Review your saved cast first.');const needed=reviewImages(p);if(!needed.length||needed.some(x=>(!p.media?.[x.id]||(p.redoIds||[]).includes(x.id))))throw Error('Generate or upload all required images, then review them first.');p.imagesReviewed=true;p.staleSceneIds=[];p.state='images_reviewed';await store('put',p);await showContinuation();dialog.close();}
  // 'Image 3' -> '@p01_asset_004' (the scene's 3rd reference, file extension dropped); numbers beyond the references stay text.
  function flowReferenceTags(text,names){return String(text).replace(/\bImage\s+(\d+)\b/g,(all,n)=>{const name=names?.[Number(n)-1];return name?'@'+String(name).replace(/\.[a-z0-9]+$/i,''):all;});}
  async function loadVideos(p,selectedSceneIds=null){
    const folderName=typeof storyFolder==='function'?await storyFolder(p):'';
    if(p.libraryCastReview)throw Error('Review and apply or skip your saved character references in AI Story first.');
    const chosen=B.generationTargets(p.target,settings),platform=chosen.videoPlatform,model=chosen.model;
    if(platform==='grok'&&typeof ensureGrokAccess==='function'&&!await ensureGrokAccess())throw Error('Allow Grok access before loading videos.');
    if(platform==='higgsfield')await higgsStoryAccess(platform);
    const plan=B.videoPlan(p.project,p.media,p.imagesReviewed,platform,model);
    if(selectedSceneIds&&(!selectedSceneIds.length||selectedSceneIds.some(id=>!plan.entries.some(e=>e.sceneId===id))))throw Error('Choose a valid video scene.');
    const completed=await savedVideoIds(p);
    const selectedEntries=plan.entries.filter(e=>selectedSceneIds?selectedSceneIds.includes(e.sceneId):!completed.includes(e.sceneId));
    if(!selectedEntries.length){p.videoDoneIds=completed;p.state='videos_finished';await store('put',p);await showContinuation();return false;}
    const selectedImages=plan.ids.filter(id=>selectedEntries.some(e=>e.referenceNames.includes(globalThis.FacelessBuilder?.flowName?.(p.media[id])??p.media[id].name)));
    // Higgsfield uses the member's own credits (owner 2026-11-17): say the most it can use before anything is loaded.
    if(platform==='higgsfield'){const n=selectedEntries.length,cap=Number(settings.higgsMaxCredits)||0;
      if(!confirm('Higgsfield will make '+n+' video'+(n===1?'':'s')+' with your own Higgsfield credits.'+(cap?' A video that costs more than '+cap+' credits is not sent (at most '+n*cap+' credits in all).':' There is no credit limit set (Settings → Higgsfield).')+' Continue?'))return false;}
    if(!await guard())return;
    const loaded=await Promise.all(selectedImages.map(id=>platform==='vids'||platform==='higgsfield'?vidsImageData(p.media[id]):imageData(p.media[id])));if(running)throw Error('Stop the active run before loading a builder queue.');images=loaded;settings.platform=platform;settings.flowModel=model;settings.mode=plan.mode;settings.flowDurationSeconds=Number(p.setup.sceneDuration);settings.aspectRatio=!!globalThis.StoryShape?.isLandscape(p)?'landscape':'portrait';
    // Google Vids takes one length and shape for the whole run, from its own settings.
    if(platform==='vids'){settings.vidsDurationSeconds=Number(p.setup.sceneDuration);settings.vidsAspectRatio=settings.aspectRatio;}
    loadSettingsIntoForm();
    // Flow Ingredients to Video: 'Image N' becomes an @ tag for the scene's N-th reference file (owner 2026-10-16), so Flow
    // binds each name to exactly one uploaded photo (native @ chips) instead of relying on the attachment order.
    const flowTags=platform==='flow'&&plan.mode==='ingredients-to-video';
    const say=p.pronunciations?await import('./lib/story-helpers.mjs').catch(()=>null):null,sayPairs=say?say.parsePronunciations(p.pronunciations):[];
    const entries=(selectedSceneIds?selectedEntries:plan.entries).map(x=>{const raw=builderQueueText(x.text),text=globalThis.StoryShape?globalThis.StoryShape.text(p,raw):raw;const line=sayPairs.length?say.pronunciationLine(sayPairs,p.project.scenes.find(s=>s.id===x.sceneId)?.speech):'',said=line?text+'\n'+line:text;return {...x,text:flowTags?flowReferenceTags(said,x.referenceNames):said};});$('promptText').value=entries.map(x=>x.text).join('\n\n');applyPromptsToQueue(entries);
    queue.forEach((item,i)=>{
      // Mixed scene lengths (Video → Story, owner 2026-11-05): each Flow prompt runs at its scene's own length.
      // 3-15 s scenes (flex, owner 2026-11-07): B.videoPlan already rounds them up to 4/6/8/10 for Omni 1.1 Flash.
      const mixed=['mixed','flex'].includes(p.setup.sceneLengths)&&platform==='flow';
      // Higgsfield sets each video's length itself (higgsfield-engine.js reads builderDurationSeconds).
      Object.assign(item,{builderProjectId:p.id,builderFolder:folderName,builderSceneId:entries[i].sceneId,builderPartNumber:Number(p.setup.partNumber||1),builderDurationSeconds:mixed||platform==='higgsfield'?entries[i].durationSeconds:Number(p.setup.sceneDuration),referenceNames:entries[i].referenceNames},mixed?{videoMode:String(entries[i].durationSeconds)}:{});
      // Retain the complete story and original numbering; the scheduler only runs pending items.
      if(!selectedSceneIds&&completed.includes(item.builderSceneId))Object.assign(item,{status:'done',progressPercent:100,detail:'Already saved · kept from the previous run'});
    });
    p.videoDoneIds=selectedSceneIds?completed.filter(id=>!selectedSceneIds.includes(id)):completed;p.state='video_ready';await store('put',p);renderImages();renderQueue();schedulePersist();dialog.close();await chrome.storage.local.set({facelessActiveProjectId:p.id,facelessDismissedProjectId:''});await showContinuation();return true;
  }
  async function regenerateScene(projectId,sceneId){
    if(busy||running)throw Error('Wait for the current run to finish.');
    const manual=(await store('getAll')).find(x=>x.id===projectId&&x.kind==='manual');
    if(manual){await runManualVideos(manual,[sceneId]);return;}
    if(queue.some(item=>['pending','error','running'].includes(item.status)))throw Error('Finish or clear the current queue in Control before regenerating a scene.');
    busy=true;
    try{
      await mediaWrites.catch(()=>{});
      const p=(await store('getAll')).find(x=>x.id===projectId);
      if(!p?.project?.scenes.some(s=>s.id===sceneId))throw Error('This scene no longer exists.');
      if(!p.imagesReviewed)throw Error('Review and approve the project images in AI Story first.');
      await saveAutoRun({on:false});
      if(!await loadVideos(p,[sceneId]))throw Error('Video regeneration was not started.');
      await startQueue();
      if(!running)throw Error('Check Control for the pre-start requirements, then press Start. Your current clip is kept.');
    }finally{busy=false;}
  }
  let continuation,continuationTimer,reviewProjectId=null,continuationRevision=0;
  async function viewContinuationProject(p){
    if(p.state==='videos_finished'||(p.setup.exportProfile==='Image prompts only'&&p.imagesReviewed)){
      const active=await chrome.storage.local.get(['facelessActiveProjectId']);
      await chrome.storage.local.set({facelessDismissedProjectId:active.facelessActiveProjectId||p.id});
      continuationRevision++;if(continuation)continuation.hidden=true;
    }
    switchTab(dialog.id,$('builderTabBtn'));await openProject(p);
  }
  function queueChanged(){clearTimeout(continuationTimer);continuationTimer=setTimeout(()=>showContinuation().catch(e=>console.warn('Builder continuation:',e)),120);}
  function continuationActivity(items,projectId,isRunning){
    const active=items.filter(x=>x.builderProjectId===projectId);if(!isRunning||!active.length)return null;
    const videos=active.some(x=>x.builderSceneId),references=!videos&&active.some(x=>String(x.builderImageId).startsWith('asset_'));
    return {label:videos?'Generating videos':references?'Generating reference images':'Generating scene images',done:active.filter(x=>x.status==='done').length,total:active.length};
  }
  async function queueEnded(result={}){
    if(queue.some(x=>x.manualProjectId)&&await finishManualQueue(result))return;
    autoMessage='';
    await mediaWrites.catch(()=>{});
    // A sheet counts as tried only when it failed or was not a clean grid, recorded here at the end of the run. Stopped,
    // never-started or reloaded-away sheets are never marked (owner 2026-10-24/25), so the next run tries them as sheets again.
    const failedTried=queue.filter(x=>x.builderSheetIds&&(x.status==='error'||x.sheetUnusable));
    for(const pid of new Set(failedTried.map(x=>x.builderProjectId))){
      // Owner 2026-11-10: a sheet that came back in the wrong shape (ChatGPT answered 3:4) is asked once more before
      // single images; a failed sheet (error) still goes straight to single images.
      const p=(await store('getAll')).find(x=>x.id===pid),misses={...(p?.sheetMisses||{})},add=[];
      for(const x of failedTried.filter(x=>x.builderProjectId===pid)){const first=x.status!=='error'&&!x.builderSheetIds.some(id=>misses[id]);for(const id of x.builderSheetIds){if(first)misses[id]=1;else add.push(id);}}
      if(p){p.sheetMisses=misses;p.sheetTriedIds=[...new Set([...(p.sheetTriedIds||[]),...add])];await store('put',p);}
    }
    const ids=[...new Set(queue.filter(x=>x.builderProjectId).map(x=>x.builderProjectId))];
    if(ids.length===1){await chrome.storage.local.set({facelessActiveProjectId:ids[0]});const p=(await store('getAll')).find(x=>x.id===ids[0]);
      if(p&&queue.some(x=>x.builderProjectId===p.id&&x.builderSceneId)){p.videoDoneIds=[...new Set([...(p.videoDoneIds||[]),...queue.filter(x=>x.builderProjectId===p.id&&x.builderSceneId&&x.status==='done').map(x=>x.builderSceneId)])];if(queue.length&&queue.every(x=>x.builderProjectId===p.id&&x.builderSceneId&&x.status==='done')&&p.project.scenes.every(s=>p.videoDoneIds.includes(s.id)))p.state='videos_finished';await store('put',p);}}
    // The new image(s) for blocked scenes are saved: run just those videos now, Auto on or off.
    const fixP=ids.length===1&&queue.some(x=>String(x.builderImageId||'').startsWith('scene_'))&&!queue.some(x=>x.builderSceneId)?(await store('getAll')).find(x=>x.id===ids[0]):null;
    if(fixP?.imageFixIds?.length){
      const made=fixP.imageFixIds.filter(id=>fixP.media[id]&&queue.some(x=>x.builderImageId===id&&x.status==='done'));
      fixP.imageFixIds=null;fixP.imageAutoMade={...(fixP.imageAutoMade||{}),...Object.fromEntries(made.map(id=>[id,fixP.media[id].sha256]))};await store('put',fixP);
      if(made.length&&!result.stopped&&!result.quota){
        autoNotice('New scene image'+(made.length>1?'s are':' is')+' ready. Making the video'+(made.length>1?'s':'')+' again for '+made.join(', ')+'…');
        setTimeout(()=>{(async()=>{const p2=(await store('getAll')).find(x=>x.id===fixP.id);if(!p2.imagesReviewed)await approve(p2);quietLoad=true;let ok;try{ok=await loadVideos(p2,made);}finally{quietLoad=false;}if(ok)await startQueue();})().catch(e=>{endAutoBackground();autoNotice(e.message);});},1500);
        return;
      }
    }
    // A storyboard sheet that failed (ChatGPT answered with text, refused, or timed out): its scenes are made as single
    // images right away, Auto on or off (owner run 2026-10-25: sheet 9-12 failed and those four scenes stayed without images).
    const failedSheets=ids.length===1?queue.filter(x=>x.builderSheetIds?.length&&x.status==='error'):[];
    if(failedSheets.length&&!result.stopped&&!result.quota){
      const p=(await store('getAll')).find(x=>x.id===ids[0]),singles=p?[...new Set(failedSheets.flatMap(x=>x.builderSheetIds))].filter(id=>!p.media?.[id]):[];
      if(p&&singles.length){
        autoNotice('A storyboard sheet did not work. Making '+singles.join(', ')+' as single images…');
        if(typeof log==='function')log('Builder: storyboard sheet failed for '+singles.join(', ')+'; making them as single images now.');
        setTimeout(()=>{(async()=>{quietLoad=true;let ok;try{ok=await loadImages(p,'scenes',singles);}finally{quietLoad=false;}if(ok)await startQueue();})().catch(e=>{endAutoBackground();autoNotice(e.message);});},1500);
        return;
      }
    }
    // Start image blocked (repair found the prompt text was not the cause): a new image for those scenes ONCE, with a
    // clearly-adult, no-likeness note, then their videos run again (owner 2026-10-24: automatic, Auto on or off, also when
    // other scenes failed). A second block on the same scene, Stop or a credit stop end with the message on the card.
    const blocked=queue.filter(x=>x.imageSuspect&&x.builderSceneId&&x.status==='error');
    if(ids.length===1&&blocked.length){
      const p=(await store('getAll')).find(x=>x.id===ids[0]),sceneIds=[...new Set(blocked.map(x=>x.builderSceneId))];
      if(p&&p.setup.exportProfile!=='Recurring assets + video'){
        // One new image per blocked IMAGE: only the image this fix made (same fingerprint) being blocked again stops (owner
        // 2026-10-24: an older image put back on a scene that had its new image earlier was not replaced).
        // Softer retry (owner 2026-11-10: "Dante — handcuffed man" was locked into every scene and every video was refused):
        // once per story, restraint wording leaves the descriptions (never the spoken lines), and the other unfinished
        // scenes drawn from those words get new pictures in the same pass instead of failing one by one.
        let softened=[];
        if(!p.lookSoftened){
          const soft=await import('./lib/soft-look.mjs').then(m=>m.softenProject(p.project,{done:p.videoDoneIds||[]})).catch(()=>null);
          if(soft?.changed){
            p.lookSoftened=true;softened=soft.imageIds.filter(id=>p.media?.[id]);
            if(typeof log==='function')log('Builder: Flow keeps refusing how a character is described'+(soft.example?' ("'+soft.example.from+'" is now "'+soft.example.to+'")':'')+'. The restraint wording was taken out of '+soft.prompts+' prompt(s) of this story (spoken lines are unchanged)'+(softened.length?'; '+softened.length+' scene picture(s) will be made again.':'.')+(soft.assetIds.length?' Character picture(s) '+soft.assetIds.join(', ')+' were made from the old words: use Redo on them if scenes are still refused.':''));
          }
        }
        const fresh=[...new Set([...sceneIds,...softened])].filter(id=>!p.media[id]?.sha256||(p.imageAutoMade||{})[id]!==p.media[id].sha256);
        p.imageSafeIds=[...new Set([...(p.imageSafeIds||[]),...sceneIds])];
        if(fresh.length&&!result.stopped&&!result.quota){
          p.imageFixIds=fresh;await store('put',p);
          autoNotice('Flow blocked '+fresh.length+' scene'+(fresh.length>1?'s':'')+' because of the start image. Making new scene image'+(fresh.length>1?'s':'')+', then the video'+(fresh.length>1?'s':'')+'…');
          if(typeof log==='function')log('Builder: start image blocked for '+fresh.join(', ')+'; regenerating '+(fresh.length>1?'those scene images':'that scene image')+' once (clearly adult, no celebrity likeness), then the videos.');
          // Started a moment later, like the other Auto stages, so the ended run finishes first.
          setTimeout(()=>{(async()=>{quietLoad=true;let ok;try{ok=await loadImages(p,'scenes',fresh);}finally{quietLoad=false;}if(ok)await startQueue();})().catch(e=>{endAutoBackground();autoNotice(e.message);});},1500);
          return;
        } else await store('put',p);
      }
    }
    // Auto continuing: the countdown starts first, so the continue box does not flash between stages.
    if(!result.clean)await factoryQueueEnded(result,ids).catch(e=>console.warn('Factory:',e));
    if(autoRun.on&&result.clean&&ids.length===1&&queue.every(x=>x.builderProjectId===ids[0]))scheduleAutoNext(ids[0],{stage:stageOf(queue),ids:queue.filter(x=>!x.sheetUnusable).map(x=>x.builderImageId).filter(Boolean)});   // an unusable storyboard sheet continues with single images
    else await showContinuation();
  }
  // ---- Auto run (owner request 2026-10-15, like TobyFlow's auto submit) ----
  // When a Builder stage finishes with EVERY item saved, the next stage loads and starts by itself after a short
  // countdown: references → scene images → videos. Auto approves the images itself (owner 2026-10-15: whoever picks
  // Auto wants it to go all the way; "Run this step only" is the way to review first). It never moves on after a
  // failure, a credit/usage stop or a Stop. Part 2+ always needs a click (it uses a Builder allowance).
  let autoRun={on:false},autoPending=null,autoTick=null;
  let autoCompletion=null,autoCompletionTimer=null,autoRunEpoch=0;
  const AUTO_DELAY_MS=5000,AUTO_CLOSE_MS=8000;
  function stageOf(items){return items.some(x=>x.builderSceneId)?'videos':items.some(x=>String(x.builderImageId||'').startsWith('asset_'))?'assets':'scenes';}
  function autoRunOn(){return autoRun.on;}
  // Read-only project snapshot for the Auto window. Blobs stay in the panel; mini-progress makes tiny thumbnails.
  async function autoProgress(items=queue){
    if(!autoRun.on)return null;
    const ids=[...new Set(items.filter(x=>x.builderProjectId&&!x.groupParent).map(x=>x.builderProjectId))];
    if(ids.length!==1)return null;
    await mediaWrites.catch(()=>{});
    const p=(await store('getAll')).find(x=>x.id===ids[0]);if(!p?.project)return null;
    const assets=p.project.assets||[],scenes=p.project.scenes||[],media=p.media||{};
    const sceneImages=p.setup.exportProfile==='Recurring assets + video'?[]:scenes;
    const videoScenes=p.setup.exportProfile==='Image prompts only'?[]:scenes;
    const videoIds=new Set(videoScenes.length?await savedVideoIds(p):[]);
    for(const item of items)if(item.builderProjectId===p.id&&item.builderSceneId&&item.status==='done')videoIds.add(item.builderSceneId);
    const saved=list=>list.filter(x=>media[x.id]?.blob).length;
    const stages=[{id:'assets',label:'Reference images',done:saved(assets),total:assets.length},{id:'scenes',label:'Scene images',done:saved(sceneImages),total:sceneImages.length},{id:'videos',label:'Videos',done:videoScenes.filter(x=>videoIds.has(x.id)).length,total:videoScenes.length}];
    const current=items.find(x=>x.builderProjectId===p.id&&typeof activeRuns!=='undefined'&&activeRuns.has(x.id));
    const scene=scenes.find(x=>x.id===current?.builderSceneId);
    const frameId=scene&&(media[scene.id]?.blob?scene.id:(scene.references||[]).find(id=>media[id]?.blob));
    const available=[...assets,...sceneImages].filter(x=>media[x.id]?.blob);
    const selected=available.filter(x=>x.id!==frameId).slice(-5);
    if(frameId)selected.push([...assets,...scenes].find(x=>x.id===frameId));
    return {projectId:p.id,title:p.project.title||'AI Story',stages,previews:selected.filter(Boolean).map(x=>({id:x.id,label:x.name||x.title||x.id,blob:media[x.id].blob,version:media[x.id].sha256||media[x.id].name+':'+media[x.id].blob.size,current:x.id===frameId,kind:x.id===frameId&&x.id.startsWith('asset_')?'reference':'frame'}))};
  }
  // Start a stage straight from the project page: choose Auto or one step, load the queue and press Start.
  // Owner 2026-10-30: Control's sheets switch shows "on" while this AI Story run uses storyboard sheets (display only).
  async function startFromProject(p,auto,load){if(globalThis.MobileFlowPilot?.isActive?.())throw Error('Wait for the mobile background queue.');if(auto&&globalThis.MobileFlowPilot?.supportsStory?.(p)&&!(await factoryOwns(p.id))){await globalThis.MobileFlowPilot.startStory(p.id);return;}if(running)throw Error('Wait for the current run to finish.');autoMessage='';await saveAutoRun({on:auto});globalThis.aiStorySheetsRun=p.sceneImageMode==='sheets'&&sheetsAvailable(p).ok?p.id:null;if(await load())await startQueue();}
  async function saveAutoRun(next){cancelAutoCompletion();autoRun={...autoRun,...next};await chrome.storage.local.set({facelessAutoRun:autoRun});if(!autoRun.on)cancelAutoNext();await showContinuation();}
  function cancelAutoCompletion(){clearTimeout(autoCompletionTimer);autoCompletionTimer=null;autoCompletion=null;autoRunEpoch++;}
  function scheduleAutoCompletion(p){
    if(autoCompletion?.id===p.id&&autoCompletion.epoch===autoRunEpoch)return;
    clearTimeout(autoCompletionTimer);
    const completion={id:p.id,epoch:autoRunEpoch,queueIds:queue.map(x=>x.id).join('|')};autoCompletion=completion;
    const current=()=>autoCompletion===completion&&autoRunEpoch===completion.epoch&&autoRun.on&&!running&&queue.map(x=>x.id).join('|')===completion.queueIds&&queue.every(x=>x.builderProjectId===p.id&&x.status==='done');
    autoCompletionTimer=setTimeout(async()=>{
      autoCompletionTimer=null;if(!current())return;
      try{
        await mediaWrites.catch(()=>{});if(!current())return;
        const latest=(await store('getAll')).find(x=>x.id===p.id);if(!latest?.project||!current())return;
        const imageOnly=latest.setup.exportProfile==='Image prompts only';
        if(imageOnly?!autoNextStep(latest).done:latest.state!=='videos_finished')return;
        const active=await chrome.storage.local.get(['facelessActiveProjectId']);if(active.facelessActiveProjectId!==p.id||!current())return;
        if(typeof hideMiniProgress==='function')await hideMiniProgress();if(!current())return;
        if(imageOnly)return;
        if(onPhone()){autoNotice('Videos are saved. Open Story Workspace from AI Story to edit or export the story.');return;}
        await openStoryWorkspace(latest);
        if(!current())return;
        await chrome.storage.local.set({facelessDismissedProjectId:p.id});
        continuationRevision++;if(continuation){continuation.hidden=true;continuation.replaceChildren();}
      }catch(e){console.warn('Builder finished workspace:',e);if(current())autoNotice('Videos are saved. Open Story Workspace from AI Story.');}
    },p.setup?.exportProfile==='Image prompts only'?AUTO_CLOSE_MS:0);
  }
  function cancelAutoNext(){if(autoPending){clearTimeout(autoPending.timer);autoPending=null;}}
  // control.js keeps Background Mode on between Auto stages; it ends here when Auto stops or the whole run is done.
  function endAutoBackground(){if(!running&&typeof stopBackgroundMode==='function')stopBackgroundMode('');}
  // What Auto would run next for this project, or why it stops.
  function autoNextStep(p){
    if(p.libraryCastReview)return {stop:'Review the saved character references in AI Story first.'};
    const assets=p.project.assets.filter(x=>(!p.media?.[x.id]||(p.redoIds||[]).includes(x.id))),scenes=p.setup.exportProfile==='Recurring assets + video'?[]:p.project.scenes.filter(x=>(!p.media?.[x.id]||(p.redoIds||[]).includes(x.id)));
    if(assets.length)return {stage:'assets',label:'reference images',missing:assets.map(x=>x.id),run:()=>loadImages(p,'assets')};
    if(scenes.length)return {stage:'scenes',label:'scene images',missing:scenes.map(x=>x.id),run:()=>loadImages(p,'scenes')};
    // New reference images (e.g. Redo all reference images): scenes made from the old ones are not turned into videos.
    if(p.staleSceneIds?.length&&!p.imagesReviewed)return {stop:'Reference images changed. Review the scenes marked "Reference changed" (regenerate them, or use Redo all scene images), then continue.'};
    if(p.setup.exportProfile==='Image prompts only')return {stop:'Images are ready. Review them, then save the finished images.',done:true};
    if(p.state==='videos_finished')return {stop:B.partAction(p.setup)?'Videos are done. Start the next part when you are ready.':'Videos are done.',done:true};
    return {stage:'videos',label:'videos',run:async()=>{if(!p.imagesReviewed)await approve(p);return loadVideos(p);}};
  }
  function scheduleAutoNext(id,finished){
    cancelAutoNext();
    // Completed video runs have no next stage: finish now, without the inter-stage countdown.
    if(finished.stage==='videos'){runAutoNext(id,finished).catch(e=>{endAutoBackground();autoNotice(e.message);});return;}
    const at=Date.now()+AUTO_DELAY_MS;
    autoPending={id,finished,at,timer:setTimeout(()=>runAutoNext(id,finished).catch(e=>{endAutoBackground();autoNotice(e.message);}),AUTO_DELAY_MS)};
    showContinuation().catch(()=>{});
  }
  let autoMessage='';
  let autoMessageDone=false;
  function autoNotice(text,done=false){autoMessage=text;autoMessageDone=done;if(typeof log==='function')log('Builder Auto: '+text);showContinuation().catch(()=>{});if(typeof pushMiniProgress==='function')pushMiniProgress().catch(()=>{});}
  // Shown in the page progress window when Auto stops and waits for the user (e.g. the image review).
  function autoStatus(){return autoRun.on&&autoMessage?(autoMessageDone?'All done: ':'Waiting for you: ')+autoMessage:'';}
  async function runAutoNext(id,finished){
    autoPending=null;
    if(running)return;
    if(!autoRun.on){endAutoBackground();return;}
    const p=(await store('getAll')).find(x=>x.id===id);if(!p?.project){endAutoBackground();return;}
    const next=autoNextStep(p);
    if(next.stop){endAutoBackground();autoNotice(next.stop,Boolean(next.done));
      // Finished videos go straight to Workspace; notifications never delay the handoff.
      // Failures, credit stops and Stop keep their progress explanation visible.
      if(next.done&&!await factoryStoryDone(p))scheduleAutoCompletion(p);
      else if(!next.done)await factoryStoryProblem(p.id,next.stop);
      if(typeof notifyUser==='function'&&!await factoryOwns(p.id))await notifyUser('0xFlow Builder',next.stop);
      return;}
    // An image that the finished run made is still missing: it was not saved. Stop instead of looping.
    // (A second scene batch — scenes without references — is new work and does continue.)
    if(next.missing?.some(x=>finished.ids.includes(x))){endAutoBackground();autoNotice('Some '+next.label+' were not saved. Check the project, then continue.');await factoryStoryProblem(p.id,'some '+next.label+' were not saved');return;}
    if(next.stage==='videos'&&finished.stage==='videos'){endAutoBackground();await factoryStoryProblem(p.id,'some videos were not saved');return;}
    if(next.stage==='videos'&&globalThis.MobileFlowPilot?.supportsStory?.(p)&&!(await factoryOwns(p.id))){
      endAutoBackground();await saveAutoRun({on:false});
      autoNotice('Starting Flow videos in the mobile background queue…');
      await globalThis.MobileFlowPilot.startStory(p.id);return;
    }
    autoNotice('Starting '+next.label+'…');
    // Auto replaces the finished stage's queue without the "Replace the current prompt queue?" box: a browser confirm()
    // freezes the panel until someone clicks (owner 2026-10-26: the overnight Factory waited all night on it).
    quietLoad=true;let loaded;try{loaded=await next.run();}finally{quietLoad=false;}
    if(loaded){autoMessage='';await startQueue();}
    else if(next.stage==='videos'){const completed=(await store('getAll')).find(x=>x.id===id);if(completed?.state==='videos_finished'){endAutoBackground();autoNotice(autoNextStep(completed).stop,true);if(!await factoryStoryDone(completed))scheduleAutoCompletion(completed);}}
  }
  function writingProject(records,current){if(!current)return null;const root=current.parentProjectId||current.id;return records.filter(p=>(p.id===root||p.parentProjectId===root)&&['queued','running'].includes(p.state)).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))[0]||null;}
  function renderWritingStatus(p,records){
    continuation.replaceChildren();continuation.hidden=false;
    const ideas=p.kind==='topics'||p.setup?.topicMode==='Suggest five ideas';const active=['queued','running'].includes(p.state),number=Number(p.setup?.partNumber||1),series=Number(p.setup?.partsTotal||1)>1,parent=records.find(x=>x.id===p.parentProjectId),label=ideas?'Your story ideas':series?'Part '+number:'Your story';
    const row=el('div',undefined,'fb-writing-row'),icon=el('span','✎','fb-writing-pencil'),copy=el('div',undefined,'fb-writing-copy');icon.setAttribute('aria-hidden','true');
    copy.append(el('strong',active?(p.state==='queued'?label+' is queued':ideas?'Finding five story ideas…':label+' is writing…'):'Build '+p.state),el('small',parent?.project?.title||p.setup?.topic||'Preparing your scene package'));row.append(icon,copy);icon.classList.toggle('is-writing',active);continuation.append(el('small',ideas?'BUILDER · IDEA SUGGESTIONS':'BUILDER · STORY CREATION','fb-continue-label'),row);
    if(active){const track=el('div',undefined,'fb-writing-track'),fill=el('div');fill.style.width=buildProgress(p)+'%';track.append(fill);track.setAttribute('aria-label',ideas?'Estimated idea suggestion progress':'Estimated story writing progress');continuation.append(track,el('small',buildProgress(p)+(ideas?'% estimated · Ideas only. Your daily story allowance is unchanged.':'% estimated · Prompts are being prepared. Images and videos start later.')));scheduleBuildWatch();}else{continuation.append(el('small',p.error||'Open the build to review its status.'));if(['failed','cancelled'].includes(p.state)){const actions=el('div',undefined,'fb-actions');actions.append(button('Try again',()=>retryBuild(p)),button('Delete this part',()=>deleteFailedPart(p)));continuation.append(actions);}}
    const links=el('div',undefined,'fb-continue-links');links.append(button(active?(ideas?'View suggestion progress ↗':'View writing progress ↗'):'View build ↗',async()=>{switchTab(dialog.id,$('builderTabBtn'));await openProject(p);}),button('Open projects →',async()=>{switchTab(dialog.id,$('builderTabBtn'));await home('projects');}));continuation.append(links);
  }
  // Countdown and Auto messages only; Auto itself is chosen on the project page (Auto: run all steps / Run this step only).
  function autoControls(id){
    const box=el('div',undefined,'fb-auto');
    if(autoPending?.id===id){const wait=el('div',undefined,'fb-auto-wait');const secs=Math.max(1,Math.ceil((autoPending.at-Date.now())/1000));wait.append(el('span','Next step starts in '+secs+' s'),button('Cancel',()=>{cancelAutoNext();endAutoBackground();autoNotice('Auto run cancelled for this step.');}));box.append(wait);clearTimeout(autoTick);autoTick=setTimeout(()=>{if(autoPending?.id===id)showContinuation().catch(()=>{});},1000);}
    else if(autoMessage&&autoRun.on)box.append(el('small',autoMessage,'fb-auto-note'));
    return box;
  }
  async function showContinuation(){
    if(!continuation)return;
    const revision=++continuationRevision;
    const {facelessActiveProjectId:id,facelessDismissedProjectId:dismissed}=await chrome.storage.local.get(['facelessActiveProjectId','facelessDismissedProjectId']);
    if(dismissed===id&&!running){if(revision===continuationRevision)continuation.hidden=true;return;}
    const records=await store('getAll');let p=records.find(x=>x.id===id);p=writingProject(records,p)||p;if(revision!==continuationRevision)return;
    if(p&&!p.project){renderWritingStatus(p,records);return;}
    if(p?.kind==='manual'){continuation.replaceChildren();continuation.hidden=false;continuation.append(el('strong','Manual project'),userText('small',p.project.title),button('Open Story Workspace',()=>openStoryWorkspace(p)),button('View project / retry unfinished',()=>openManualProject(p).then(()=>switchTab(dialog.id,$('builderTabBtn')))));return;}
    if(!p?.project)return;continuation.replaceChildren();continuation.hidden=false;
    const assets=p.project.assets.filter(x=>(!p.media?.[x.id]||(p.redoIds||[]).includes(x.id))),scenes=p.setup.exportProfile==='Recurring assets + video'?[]:p.project.scenes.filter(x=>(!p.media?.[x.id]||(p.redoIds||[]).includes(x.id)));
    const imageOnly=p.setup.exportProfile==='Image prompts only',failed=queue.some(x=>x.builderProjectId===id&&x.status==='error');
    let status,help,label,run;
    if(assets.length){status=failed?'Reference images need attention':'Reference images in progress';help=assets.length+' reference images still needed. Saved images are kept.';label='Generate '+assets.length+' missing references →';run=()=>loadImages(p,'assets');}
    else if(scenes.length){status=failed?'Scene images need attention':p.project.assets.length?'✓ Reference images ready':'Your scene frames are next';help='Next: create '+scenes.length+' scene frames using your saved images.';label=failed?'Retry '+scenes.length+' missing scene images →':'Generate scene images →';run=()=>loadImages(p,'scenes');}
    else if(!p.imagesReviewed){status='✓ Scene images ready';help='Review your images before generating videos.';label='Review & approve images →';}
    else if(imageOnly){status='✓ Images approved';help='Your images are ready to save.';label='Save finished images →';}
    else if(p.state==='videos_finished'){status='✓ Video generation complete';help='Your clips were saved by the generation queue.';label=B.partAction(p.setup)?B.partAction(p.setup).label:'View project →';}
    else if(queue.some(x=>x.builderProjectId===id&&x.builderSceneId&&x.status!=='done')&&queue.some(x=>x.builderProjectId===id&&x.builderSceneId&&['done','error','skipped'].includes(x.status))){status='Videos need attention';help='Retry only failed or unfinished clips; saved clips are kept.';label='Retry unfinished videos →';run=async()=>{if(running)throw Error('Wait for the active run to finish.');const completed=await savedVideoIds(p);p.videoDoneIds=completed;await store('put',p);for(const item of queue)if(item.builderProjectId===id){if(completed.includes(item.builderSceneId))item.status='done';else if(item.status!=='done'){item.status='pending';item.attempts=0;}}renderQueue();schedulePersist();return true;};}
    else{status='✓ Images reviewed and approved';help='Next: generate videos from your approved images.';label='Generate videos →';run=()=>loadVideos(p);}
    const activity=continuationActivity(queue,id,running);
    // Auto on and working (a stage running, or the countdown to the next one): nothing to click here, the page window
    // and the Run card show the progress. The box comes back when Auto stops: review, failure, Stop, finished, next Part.
    if(autoRun.on&&(activity||autoPending?.id===id)){continuation.hidden=true;continuation.replaceChildren();return;}
    if(activity){status=activity.label+'…';help=activity.done+' / '+activity.total+' saved. The next step unlocks when this run finishes.';label=activity.label+'… '+activity.done+'/'+activity.total;}
    else if(!p.imagesReviewed&&!assets.length&&!scenes.length&&reviewProjectId===id)label='Approve reviewed images →';
    continuation.append(el('small','CONTINUE YOUR BUILDER PROJECT','fb-continue-label'),userText('strong',p.project.title),el('div',status,'fb-continue-status'),el('small',help));
    const actions=el('div',undefined,'fb-actions');const next=button(label,async()=>{try{if(running)throw Error('Wait for the active generation to finish.');next.disabled=true;if(p.state==='videos_finished'&&B.partAction(p.setup)){await continuePart(p);}else if(run){if(await run())await startQueue();}else if(!p.imagesReviewed){if(reviewProjectId===id)await approve(p);else{reviewProjectId=id;await showContinuation();}}else if(imageOnly&&p.imagesReviewed)await exportImages(p);else{await viewContinuationProject(p);}}catch(e){notice.textContent=e.message;}finally{next.disabled=running;}});next.classList.add('fb-primary');next.disabled=running;next.classList.toggle('fb-stage-running',Boolean(activity));next.setAttribute('aria-busy',String(Boolean(activity)));
    const partAction=B.partAction(p.setup);if(imageOnly&&p.imagesReviewed&&partAction)actions.append(button(partAction.label,()=>continuePart(p)));
    actions.append(next);continuation.append(actions);
    const auto=autoControls(id);if(auto.childElementCount)continuation.append(auto);
    if(!activity&&reviewProjectId===id&&!p.imagesReviewed&&!assets.length&&!scenes.length){const previews=el('div',undefined,'fb-inline-review');for(const item of reviewImages(p)){const image=el('img');image.alt=item.id;image.src=URL.createObjectURL(p.media[item.id].blob);image.onload=()=>URL.revokeObjectURL(image.src);const card=el('div');card.append(image,el('small',item.id));previews.append(card);}continuation.append(el('small','Check faces, outfits and each scene before approving.'),previews);}
    const links=el('div',undefined,'fb-continue-links');links.append(button('View project ↗',()=>viewContinuationProject(p)),button('Open projects →',async()=>{switchTab(dialog.id,$('builderTabBtn'));await home('projects');}));continuation.append(links);
    const notice=el('small','','fb-message');notice.setAttribute('aria-live','polite');continuation.append(notice);
  }
  // ---- Overnight Auto-Factory (owner 2026-10-23/24, docs/AUTO-FACTORY-PLAN.md; decisions in lib/factory.mjs) ----
  // Gmail-signed-in Pro only. Up to five stories, one after another: build -> Auto (images, videos) -> plain MP4 export.
  const FACTORY_KEY='facelessFactory',factoryModule=()=>import('./lib/factory.mjs');
  let factoryBusy=false,factoryFlowPreparing=false,factoryTimer=null,factoryLock=null,factoryShown=false,factoryWrites=Promise.resolve();
  async function factoryGet(){return (await chrome.storage.local.get([FACTORY_KEY]))[FACTORY_KEY]||null;}
  async function factoryPut(f,requireRunning=false){
    const snapshot=structuredClone(f),write=factoryWrites.catch(()=>{}).then(async()=>{
      if(requireRunning){const current=await factoryGet();if(!current||current.id!==snapshot.id||current.status!=='running')throw Error('Factory stopped or changed; unfinished work is kept.');}
      await chrome.storage.local.set({[FACTORY_KEY]:snapshot});
    });factoryWrites=write;await write;if(factoryShown&&dialog.open)factoryScreen().catch(()=>{});
  }
  async function restoreFactory(){
    const f=await factoryGet();if(f?.status!=='running')return;
    if(Number.isFinite(f.retryAt)&&!f.stories.some(x=>['building','running','exporting'].includes(x.status))){await factoryAwake(true);factoryLater(250);return;}
    f.status='stopped';f.stopReason='The panel was closed while the Factory was running. Press Resume Factory to continue.';
    for(const x of f.stories)if(['building','running','exporting'].includes(x.status)){x.status='paused';x.reason='interrupted';}
    await factoryPut(f);
  }
  function factorySay(text){if(typeof log==='function')log('Factory: '+text);}
  async function factoryWaitHourly(f,index,reason){
    const latest=await factoryGet();if(!latest||latest.id!==f.id||latest.status!=='running')return;f=latest;
    const F=await factoryModule(),wait=F.scheduleHourlyRetry(f,index,reason);await factoryPut(f,true);
    factorySay('Hourly limit: retrying automatically at '+new Date(f.retryAt).toLocaleTimeString()+'.');factoryLater(wait.ms);
  }
  async function factoryWaitMaintenance(f,index,reason){
    const latest=await factoryGet();if(!latest||latest.id!==f.id||latest.status!=='running')return;f=latest;
    const F=await factoryModule(),wait=F.scheduleMaintenanceRetry(f,index,reason);await factoryPut(f,true);
    factorySay('System maintenance: the next story waits and is tried again at '+new Date(f.retryAt).toLocaleTimeString()+'.');factoryLater(wait.ms);
  }
  async function factoryOwns(projectId){const f=await factoryGet();return !!f&&f.status==='running'&&f.stories.some(x=>x.projectId===projectId&&['running','building','exporting'].includes(x.status));}
  function factoryLater(ms=1500){clearTimeout(factoryTimer);factoryTimer=setTimeout(()=>factoryStep().catch(e=>factorySay(e.message||String(e))),ms);}
  async function factoryAwake(on){
    // Keeps the screen (and so the PC) awake while the panel is open; no extra permission needed.
    try{if(on&&!factoryLock&&navigator.wakeLock)factoryLock=await navigator.wakeLock.request('screen');if(!on&&factoryLock){await factoryLock.release();factoryLock=null;}}catch{}
  }
  async function pollJob(id,until,assertCurrent=async()=>{}){
    for(let i=0;i<300;i++){
      await assertCurrent();const j=await request('/builder/jobs/'+id);await assertCurrent();if(until(j))return j;
      if(['failed','cancelled'].includes(j.state))throw Object.assign(Error(j.error||'AI Story could not write this story.'),{job:j});
      await new Promise(r=>setTimeout(r,4000));
    }
    throw Error('AI Story took more than 20 minutes to write this story.');
  }
  async function factoryHalt(f,reason){const current=await factoryGet();if(!current||current.id!==f.id)return;if(current.status!=='running'){if(current.status==='stopped')await factoryAwake(false);return;}f.status='stopped';f.stopReason=reason;f.endedAt=Date.now();await factoryPut(f,true);await factoryAwake(false);factorySay('stopped: '+reason);if(typeof notifyUser==='function')await notifyUser('0xFlow Factory stopped',reason);}
  async function factoryStart(options){
    const F=await factoryModule(),allowed=await factoryAllowedNow();if(!allowed.ok)throw Error(allowed.reason);
    const existing=await factoryGet();if(existing?.status==='running')throw Error('A Factory run is already in progress.');
    // Discord Pro trial (owner 2026-10-25): one full Factory run (up to 5 stories) per month, counted by the server. Nothing
    // is shown before; starting a second run that month opens the Upgrade popup instead.
    if(allowed.trial){
      const trial=(typeof featureAllowance==='function'?await featureAllowance(true):null)?.factory;
      if(trial?.included&&!trial.unlimited&&trial.remaining<1){
        if(typeof upgradeNudge==='function')upgradeNudge('Discord Pro: this month\'s free Factory run is used. '+(typeof PRO_PITCH==='string'?PRO_PITCH:''),'factory');
        return false;
      }
    }
    // Discord Pro switches between 2 Flow accounts; paid Pro up to 10 (owner 2026-11-13).
    if(allowed.trial&&options?.switchAccounts&&(options.accounts||[]).length>2)throw Error('Discord Pro switches between 2 Flow accounts. Upgrade to paid Pro for up to 10.');
    const f=F.createFactory(options);
    if(f.switching)await factoryUseAccount(f.switching.accounts[0]);
    await factoryPut(f);
    if(allowed.trial&&typeof featureRecord==='function')featureRecord('factory',1);
    factorySay('started: '+(f.series?(F.seriesTotal(f)>1?F.seriesTotal(f)+' series of '+f.parts+' parts.':'a series of '+f.stories.length+' parts.'):f.stories.length+(f.stories.length===1?' story.':' stories.')));await factoryAwake(true);factoryLater(200);
    return true;
  }
  // Moves the Flow tab the queue will reuse (the most recently used one) to account n and checks that Flow stayed
  // on it: a Google account that is not signed in redirects away from /u/n/.
  async function factoryUseAccount(n){
    const F=await factoryModule(),url=F.flowAccountUrl(n);
    const open=(await chrome.tabs.query({url:['https://flow.google.com/*','https://flow.google/*','https://labs.google/fx/*']}).catch(()=>[]))
      .filter(t=>/^https:\/\/(?:flow\.google(?:\.com)?(?:\/|$)|labs\.google\/fx\/(?:[a-z-]+\/)?tools\/flow(?:\/|$))/i.test(t.url||''))
      .sort((a,b)=>(b.lastAccessed||0)-(a.lastAccessed||0));
    const tab=open[0]?await chrome.tabs.update(open[0].id,{url}):await chrome.tabs.create({url,active:false});
    for(let i=0;i<45;i++){
      await new Promise(r=>setTimeout(r,1000));
      const t=await chrome.tabs.get(tab.id).catch(()=>null);if(!t)throw Error('the Flow tab was closed');
      if(t.status==='complete'&&/^https:\/\/(?:flow\.google|labs\.google)/i.test(t.url||'')&&F.flowAccountOf(t.url)===Number(n))return t;
    }
    throw Error('Flow did not open on that account');
  }
  async function factoryAllowedNow(){await window.FlowGoogleSignIn?.refresh?.();return (await factoryModule()).factoryAllowed(window.FlowGoogleSignIn?.current?.());}
  async function factoryFlowTab(items){
    const f=await factoryGet();if(!f||f.status!=='running')return null;
    const ids=new Set(items.filter(x=>x.status==='pending').map(x=>x.builderProjectId).filter(Boolean));
    const owned=f.stories.map((s,i)=>({s,i})).filter(x=>ids.has(x.s.projectId)&&['running','building'].includes(x.s.status));
    if(!owned.length)return null;
    if(owned.length!==1||ids.size!==1)throw Error('Factory must generate one saved part at a time');
    if(factoryFlowPreparing)throw Error('Factory is already opening this part’s Flow project. Wait for it to finish.');
    factoryFlowPreparing=true;
    const {s:story,i:index}=owned[0];
    const active=async()=>{const current=await factoryGet();if(!current||current.id!==f.id||current.status!=='running'||current.stories[index]?.projectId!==story.projectId)throw Error('Factory stopped or changed while opening Flow');};
    try{
      const F=await factoryModule(),P=await import('./lib/factory-flow-project.mjs');
      // Phones with chrome.debugger press New project with a real click too (owner 2026-11-10); the old script click is the
      // fallback if that opens no project.
      const realClick=!!chrome.debugger&&typeof flowCdpClick==='function',phone=typeof flowMobileUa==='function'&&flowMobileUa();
      const tab=await P.ensureFactoryFlowProject(f,index,{tabs:chrome.tabs,account:F.currentAccount(f),inspect:id=>exec(id,P.factoryFlowPage,[!realClick]),click:realClick?(id,at)=>flowCdpClick(id,at.x,at.y):null,scriptClick:realClick&&phone?id=>{factorySay('the tap on New project opened no project; pressing it the old way.');return exec(id,P.factoryFlowPage,[true]);}:null,sleep:ms=>new Promise(r=>setTimeout(r,ms)),assertActive:active,save:async()=>{await active();const current=await factoryGet();current.stories[index].flowProjects=story.flowProjects;await factoryPut(current,true);}});
      factorySay('part '+(index+1)+' uses its own Flow project.');return tab;
    }catch(error){
      const current=await factoryGet();
      if(current?.id===f.id&&current.status==='running'){current.stories[index].status='paused';current.stories[index].reason=error.message;await saveAutoRun({on:false});await factoryHalt(current,'Flow project setup: '+error.message);}
      throw error;
    }finally{factoryFlowPreparing=false;}
  }
  async function factoryStep(){
    if(factoryBusy||running){const waiting=await factoryGet();if(waiting?.status==='running'&&Number.isFinite(waiting.retryAt))factoryLater(3000);return;}factoryBusy=true;
    try{
      const F=await factoryModule(),f=await factoryGet();if(!f||f.status!=='running')return;
      const assertCurrent=async()=>{const current=await factoryGet();if(!current||current.id!==f.id||current.status!=='running')throw Error('Factory stopped or changed; unfinished work is kept.');};
      const put=()=>factoryPut(f,true);
      const step=F.nextStep(f);
      if(step.kind==='cooldown')return factoryLater(step.ms);
      if(step.kind==='suggest-topics'){
        const template=templates.find(t=>t.id===f.templateId),history=await ideaHistory();
        const setup=B.validateSetup({...f.answers,topicMode:'Suggest five ideas',topic:'Suggest five concrete, engaging ideas for this template.',presetContext:[(f.answers.presetContext||'').slice(0,500),'Suggest genuinely new stories. Avoid these previous ideas: '+avoidIdeas(history.flatMap(x=>x.topics||[]))].join('\n').slice(0,1500)});
        factorySay('asking AI Story for topics ('+(template?.title||'template')+')…');
        let j;try{await assertCurrent();j=await request('/builder/jobs',{setup,requestId:crypto.randomUUID(),templateId:f.templateId,kind:'topics'});}
        catch(e){if(e.code==='MAINTENANCE')return factoryWaitMaintenance(f,-1,e.message);if(/hourly limit/i.test(e.message||''))return factoryWaitHourly(f,-1,e.message);return factoryHalt(f,'Topics could not be requested: '+e.message);}
        let done;try{done=await pollJob(j.jobId||j.id,x=>Array.isArray(x.topics)&&x.topics.length>0,assertCurrent);}catch(e){return factoryHalt(f,'Topics could not be suggested: '+e.message);}
        await rememberIdeas(done);F.fillTopics(f,done.topics||[]);await put();return factoryLater();
      }
      if(step.kind==='build'){
        const allowed=await factoryAllowedNow();if(!allowed.ok)return factoryHalt(f,allowed.reason);
        const story=f.stories[step.index];story.status='building';story.reason='';await put();
        factorySay('writing '+(f.series?F.storyLabel(f,step.index).toLowerCase():'story '+(step.index+1)+' of '+f.stories.length)+': '+story.topic.slice(0,60));
        let setup;try{setup=B.validateSetup({...f.answers,topic:story.topic,topicMode:'Existing topic',partsTotal:f.series?String(f.parts||f.stories.length):'1'});}catch(e){F.storyEnded(f,step.index,'failed','setup: '+e.message);await put();return factoryLater();}
        const requestId=crypto.randomUUID();let j;
        try{await assertCurrent();j=await request('/builder/jobs',{setup,requestId,templateId:f.templateId,kind:'project'});}
        catch(e){const msg=e.message||String(e);if(e.code==='MAINTENANCE')return factoryWaitMaintenance(f,step.index,msg);if(/hourly limit/i.test(msg))return factoryWaitHourly(f,step.index,msg);
          if(/daily .*limit|allowance is used up/i.test(msg))return factoryHalt(f,(F.storyEnded(f,step.index,'daily-limit',msg),msg));
          F.storyEnded(f,step.index,'failed','AI Story: '+msg);await put();return factoryLater();}
        const record={...j,setup,requestId,target:f.target,templateId:f.templateId,media:{},factoryId:f.id,...(f.storyboard?{sceneImageMode:'sheets'}:{})};
        await store('put',record);story.projectId=record.id;await put();
        try{await pollJob(record.jobId||record.id,x=>!!x.project,assertCurrent);}catch(e){F.storyEnded(f,step.index,'failed','AI Story: '+e.message);await put();return factoryLater();}
        await assertCurrent();await refresh(record);
      }
      if(step.kind==='continue'){
        // Series (owner 2026-10-28): Part N+1 is written from the finished Part N (same cast, reused reference images, its ending).
        const allowed=await factoryAllowedNow();if(!allowed.ok)return factoryHalt(f,allowed.reason);
        const story=f.stories[step.index],prev=f.stories[step.index-1],pp=(await store('getAll')).find(x=>x.id===prev?.projectId);
        const fail=async msg=>{const r=F.storyEnded(f,step.index,'failed',msg);await put();return r.action==='stop'?factoryHalt(f,r.reason):factoryLater();};
        const part=F.partOf(f,step.index);
        const incomplete=prev?.status==='incomplete'&&F.canContinueWrittenPart(pp);
        if(!pp?.project||(pp.state!=='videos_finished'&&!incomplete))return fail('Part '+(part-1)+' has no approved written story and references for continuation');
        story.status='building';story.reason='';await put();factorySay('writing '+F.storyLabel(f,step.index)+'…');
        let child;
        try{await assertCurrent();child=await continuePart(pp,{factory:true,allowIncompleteMedia:incomplete});}
        catch(e){const msg=e.message||String(e);if(e.code==='MAINTENANCE')return factoryWaitMaintenance(f,step.index,msg);if(/hourly limit/i.test(msg))return factoryWaitHourly(f,step.index,msg);if(/daily .*limit|allowance is used up/i.test(msg))return factoryHalt(f,(F.storyEnded(f,step.index,'daily-limit',msg),msg));return fail('Part '+part+': '+msg);}
        if(!child)return fail('Part '+part+' was not written');
        story.projectId=child.id;await put();
        if(!child.project){try{await pollJob(child.jobId||child.id,x=>!!x.project,assertCurrent);}catch(e){return fail('AI Story: '+e.message);}await assertCurrent();await refresh(child);}
      }
      if(step.kind==='build'||step.kind==='resume'||step.kind==='continue'){
        const story=f.stories[step.index],p=(await store('getAll')).find(x=>x.id===story.projectId);
        if(!p?.project){F.storyEnded(f,step.index,'failed','the written story was not found');await put();return factoryLater();}
        const next=autoNextStep(p);
        if(next.stop&&next.done){story.status='running';await put();if(!await factoryStoryDone(p))factoryLater();return;}
        if(next.stop){F.storyEnded(f,step.index,'failed',next.stop);await put();return factoryLater();}
        story.status='running';story.account=(await factoryModule()).currentAccount(f);
        // A new ChatGPT chat once per story (owner 2026-11-10); series Part 2+ keep the chat of their cast.
        const freshChat=!story.chatgptNewChat&&!(f.series&&F.partOf(f,step.index)>1);story.chatgptNewChat=true;await put();
        if(freshChat&&typeof chatgptStartFreshChat==='function')chatgptStartFreshChat();
        factorySay('story '+(step.index+1)+': '+next.label+'…');
        // Quiet load (no "Replace the current prompt queue?" box): nobody is there to click it overnight (owner 2026-10-26).
        await assertCurrent();await startFromProject(p,true,async()=>{quietLoad=true;try{return await next.run();}finally{quietLoad=false;}});
        return;
      }
      if(step.kind==='finish'){F.finish(f);await put();await factoryAwake(false);const lines=F.report(f);factorySay(lines.join(' · '));if(typeof notifyUser==='function')await notifyUser('0xFlow Factory finished',lines.join('\n'));}
    }finally{factoryBusy=false;}
  }
  // Auto finished every video of a Factory story: export the plain MP4 (no subtitles, no music) in Story Workspace.
  async function factoryStoryDone(p){
    const F=await factoryModule(),f=await factoryGet();if(!f||f.status!=='running')return false;
    const index=f.stories.findIndex(x=>x.projectId===p.id);if(index<0)return false;
    F.storyEnded(f,index,'finished');await factoryPut(f,true);factorySay('story '+(index+1)+' videos done, exporting the MP4…');
    await chrome.storage.local.set({facelessDismissedProjectId:p.id});
    if(onPhone()){f.stories[index].status='done';f.stories[index].reason='videos saved; on phones the MP4 is not exported automatically, export it in Story Workspace';
      await factoryPut(f,true);factorySay('story '+(index+1)+' videos saved; export the MP4 in Story Workspace.');factoryLater(3000);return true;}
    await chrome.tabs.create({url:chrome.runtime.getURL('story-workspace.html?project='+encodeURIComponent(p.id)+'&factoryExport=1'),active:false});
    return true;
  }
  async function factoryExportDone(message){
    const F=await factoryModule(),f=await factoryGet();if(!f||f.status!=='running')return;
    const index=f.stories.findIndex(x=>x.projectId===message.projectId&&x.status==='exporting');if(index<0)return;
    if(message.ok){F.storyEnded(f,index,'exported');factorySay('story '+(index+1)+' exported.');}
    else{f.stories[index].status='done';f.stories[index].reason='videos saved; the MP4 export failed ('+String(message.error||'').slice(0,120)+'), export it in Story Workspace';factorySay('story '+(index+1)+' export failed: '+message.error);}
    await factoryPut(f,true);factoryLater(3000);
  }
  async function factoryStoryProblem(projectId,reason){
    const F=await factoryModule(),f=await factoryGet();if(!f||f.status!=='running')return;
    const index=f.stories.findIndex(x=>x.projectId===projectId&&x.status==='running');if(index<0)return;
    if(/were not saved/i.test(reason)){const retry=F.scheduleMediaRetry(f,index,reason);if(retry){await factoryPut(f,true);factorySay('story '+(index+1)+': '+f.stories[index].reason+' at '+new Date(f.retryAt).toLocaleTimeString()+'.');return factoryLater(retry.ms);}}
    const p=(await store('getAll')).find(x=>x.id===projectId),kind=F.canContinueWrittenPart(p)?'media-incomplete':'failed';
    const r=F.storyEnded(f,index,kind,reason);await factoryPut(f,true);if(r.action==='stop')return factoryHalt(f,r.reason);factorySay('story '+(index+1)+(kind==='media-incomplete'?' needs attention; continuing. ':' skipped: ')+reason);factoryLater(5000);
  }
  // Video → Story (owner 2026-11-04): the user's own Gemini chat watches their video with the two reverse prompts and
  // returns Tagalog Drama scenes; they are saved as normal projects (video-reverse.js), opened here like any story.
  let reverseRun=null;
  // Owner 2026-11-04: the flagship look — hero with a scanning film frame, a 4-stage tracker driven by the run's status
  // messages, and a drag-and-drop video zone. Logic is unchanged (run, resume, cancel).
  const VR_STAGES=[['upload','Upload','Sends your video to the AI',/reading the video|opening a new (?:gemini )?chat|uploading/i],['watch','Watch','Every line and shot, word for word',/watching|transcript/i],['rebuild','Rebuild','Scenes paced like the original, checked and repaired',/writing scenes|fixing|batch \d+ ready/i],['ready','Ready','Cards, start frames and video prompts',/^saved /i]];
  function videoScreen(){
    clear();
    const wrap=el('div',undefined,'fb-vr');
    const hero=el('div',undefined,'fb-vr-hero');
    const art=el('div',undefined,'fb-vr-art');art.setAttribute('aria-hidden','true');
    art.innerHTML='<svg viewBox="0 0 96 96" width="76" height="76"><defs><linearGradient id="fbvrg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c4b5fd"/><stop offset="1" stop-color="#5eead4"/></linearGradient></defs><rect x="14" y="10" width="68" height="76" rx="12" fill="none" stroke="url(#fbvrg)" stroke-width="3"/><g fill="url(#fbvrg)" opacity=".85"><rect x="19" y="17" width="5" height="7" rx="1.5"/><rect x="19" y="31" width="5" height="7" rx="1.5"/><rect x="19" y="45" width="5" height="7" rx="1.5"/><rect x="19" y="59" width="5" height="7" rx="1.5"/><rect x="19" y="73" width="5" height="7" rx="1.5"/><rect x="72" y="17" width="5" height="7" rx="1.5"/><rect x="72" y="31" width="5" height="7" rx="1.5"/><rect x="72" y="45" width="5" height="7" rx="1.5"/><rect x="72" y="59" width="5" height="7" rx="1.5"/><rect x="72" y="73" width="5" height="7" rx="1.5"/></g><path d="M42 36v24l20-12z" fill="url(#fbvrg)"/></svg><span class="fb-vr-scan"></span>';
    const copy=el('div',undefined,'fb-vr-copy');
    const kicker=el('span','Video → Story','fb-vr-kicker'),badge=el('span','NEW','fb-vr-new');kicker.append(badge);
    copy.append(kicker,el('h3','Reverse-engineer any drama','fb-vr-title'),el('p','Drop a Tagalog drama video. AI watches it, writes down every line word for word, and rebuilds it as ready-to-make AI Story scenes.','fb-vr-lead'));
    hero.append(art,copy);
    const steps=el('ol',undefined,'fb-vr-steps');
    const stepEls=VR_STAGES.map(([id,name,hint],i)=>{const li=el('li',undefined,'fb-vr-step');li.dataset.state='todo';li.append(el('span',String(i+1),'fb-vr-dot'),el('strong',name),el('small',hint));steps.append(li);return li;});
    const setStage=text=>{const at=VR_STAGES.findIndex(x=>x[3].test(text||''));if(at<0)return;stepEls.forEach((li,i)=>{li.dataset.state=i<at||(at===VR_STAGES.length-1)?'done':i===at?'active':'todo';});wrap.dataset.running=at<VR_STAGES.length-1&&reverseRun?'1':'';};
    const input=el('input');input.type='file';input.accept='video/*';input.setAttribute('aria-label','Video file');input.className='fb-vr-input';
    const drop=el('label',undefined,'fb-vr-drop');
    const dropIcon=el('span','⬆','fb-vr-drop-icon');dropIcon.setAttribute('aria-hidden','true');
    const dropMain=el('strong','Drop your video here or click to choose'),dropSub=el('small','MP4, MOV or WebM · up to 15 minutes · 200 MB');
    drop.append(input,dropIcon,dropMain,dropSub);
    const showFile=()=>{const f=input.files?.[0];drop.dataset.has=f?'1':'';dropMain.textContent=f?f.name:'Drop your video here or click to choose';dropSub.textContent=f?(f.size/1048576).toFixed(1)+' MB · ready to rebuild':'MP4, MOV or WebM · up to 15 minutes · 200 MB';};
    input.onchange=showFile;
    drop.ondragover=e=>{e.preventDefault();drop.dataset.over='1';};drop.ondragleave=()=>{drop.dataset.over='';};
    drop.ondrop=e=>{e.preventDefault();drop.dataset.over='';const f=e.dataTransfer?.files?.[0];if(!f||input.disabled)return;const dt=new DataTransfer();dt.items.add(f);input.files=dt.files;showFile();};
    // Owner 2026-11-08: pick the Flow video model here instead of in Settings first. It is the same setting (Settings → Model),
    // and it decides the scene lengths the rebuild asks for: Omni 1.2 Flash 3–15 s, the others 4/6/8/10 s.
    const flowModelSelect=document.getElementById('flowModel'),modelRow=el('div',undefined,'fb-vr-model'),modelPick=el('select'),modelNote=el('small','','fb-vr-model-note');
    modelPick.setAttribute('aria-label','Flow video model');modelRow.append(el('strong','Flow video model'),modelPick,modelNote);modelRow.hidden=!flowModelSelect;
    const paintModel=()=>{if(!flowModelSelect)return;modelPick.textContent='';for(const o of flowModelSelect.options)if(!o.hidden&&!o.disabled)modelPick.append(new Option(o.text,o.value));modelPick.value=flowModelSelect.value;
      const flex=/^omni\s*1\.2\s*flash$/i.test(modelPick.value.trim());modelNote.textContent=flex?'Scenes 3–15 s, each as long as the original shot.':/^veo\b/i.test(modelPick.value.trim())&&!/lower[\s_-]*priority/i.test(modelPick.value)?'Scenes 4, 6, 8 or 10 s. Veo always makes 8 s videos, so Omni 1.2 Flash matches the original timing best.':'Scenes 4, 6, 8 or 10 s. Choose Omni 1.2 Flash for any length from 3 to 15 s.';};
    modelPick.onchange=()=>{if(!flowModelSelect||reverseRun)return;flowModelSelect.value=modelPick.value;flowModelSelect.dispatchEvent(new Event('change'));paintModel();};
    paintModel();
    const status=el('p','', 'fb-vr-status');status.setAttribute('role','status');
    const say=t=>{status.textContent=t;setStage(t);};
    // A run that fails after the analysis keeps its batches (chrome.storage, survives a reload) and continues in the same
    // Gemini chat, without uploading or analysing the video again.
    const RESUME_KEY='videoReverseResume',retry=button('',()=>go(true));retry.hidden=true;retry.className='fb-vr-ghost';
    const showRetry=r=>{retry.hidden=!r;if(r)retry.textContent='↻ Retry from batch '+r.n+' (same Gemini chat)';};
    chrome.storage.local.get(RESUME_KEY).then(x=>{const r=x[RESUME_KEY];showRetry(r&&Date.now()-r.at<86400000?r:null);}).catch(()=>{});
    const go=async resumeRun=>{
      if(reverseRun)return;
      // Owner 2026-11-04: signed-in users only. The run uses the user's own Gemini and never calls our server, so the panel's
      // text-based sign-in gate (which misses "✦ Create…") is not enough: check here, for Create and Retry alike.
      const signIn=window.FlowGoogleSignIn;if(!signIn?.current?.()?.signedIn){say('Sign in with Google to rebuild a video.');signIn?.showSignInPopup?.();return;}
      const file=input.files?.[0];if(!file&&!resumeRun){say('Choose a video first.');drop.focus?.();return;}
      const resume=resumeRun?(await chrome.storage.local.get(RESUME_KEY))[RESUME_KEY]:null;if(resumeRun&&!resume){showRetry(null);return;}
      const control=new AbortController();reverseRun=control;start.disabled=retry.disabled=input.disabled=modelPick.disabled=true;startLabel.textContent='Rebuilding your story…';drop.dataset.locked='1';cancel.hidden=false;wrap.dataset.running='1';status.dataset.tone='';
      try{
        const records=await window.VideoReverse.run(file,{resume,signal:control.signal,onStatus:say});
        await chrome.storage.local.remove(RESUME_KEY);showRetry(null);
        for(const r of records)await store('put',r);
        await chrome.storage.local.set({facelessActiveProjectId:records[0].id,facelessDismissedProjectId:''});
        say('Saved '+records.length+(records.length>1?' parts':' story')+' · '+records.reduce((n,r)=>n+r.project.scenes.length,0)+' scenes.');
        await openProject(records[0]);
      }catch(e){status.dataset.tone='error';status.textContent=e.message||String(e);if(e.resume){const r={...e.resume,at:Date.now()};await chrome.storage.local.set({[RESUME_KEY]:r}).catch(()=>{});showRetry(r);}}
      finally{reverseRun=null;wrap.dataset.running='';startLabel.textContent='Create story from video';drop.dataset.locked='';start.disabled=retry.disabled=input.disabled=modelPick.disabled=false;cancel.hidden=true;}
    };
    const startLabel=el('span','Create story from video'),start=button('',()=>go(false));start.className='fb-vr-go';start.append(el('span','✦ '),startLabel);
    const cancel=button('Cancel',()=>reverseRun?.abort());cancel.hidden=true;cancel.className='fb-vr-ghost';
    const back=button('Back',()=>{if(!reverseRun)home();});back.className='fb-vr-ghost';
    const actions=el('div',undefined,'fb-vr-actions');actions.append(start,retry,cancel,back);
    const note=el('p','About 5–15 minutes · keep this panel open','fb-vr-note');
    wrap.append(hero,steps,drop,modelRow,actions,status,note);body.append(wrap);
  }
  async function factoryScreen(){
    const F=await factoryModule(),f=await factoryGet(),allowed=await factoryAllowedNow();
    clear();factoryShown=true;body.append(el('small','Overnight Auto-Factory · Pro'),el('h3','Make up to 5 stories while you sleep'));
    body.append(el('p','Each story is written, its images and videos are made with Auto, and the final MP4 is exported (no subtitles, no music). Keep the PC on, Chrome open and this panel open; the screen stays awake while the Factory runs.','fb-muted'));
    if(f){
      const list=el('div',undefined,'fb-factory-list');
      f.stories.forEach((x,i)=>{const row=el('div',undefined,'fb-factory-row fb-factory-'+x.status);row.append(el('strong',f.series?F.storyLabel(f,i)+(F.partOf(f,i)>1?'':' · '+(x.topic||'topic coming from AI Story')):(i+1)+'. '+(x.topic||'Topic coming from AI Story')),el('small',({waiting:'Waiting',building:'Writing the story…',running:'Making images and videos…',exporting:'Exporting the MP4…',done:'✓ Done',incomplete:'Needs attention',skipped:'Skipped',paused:'Paused'})[x.status]+(x.retryAt>Date.now()?' · automatic retry at '+new Date(x.retryAt).toLocaleTimeString():'')+(x.reason?' · '+x.reason:'')));if(x.projectId&&x.status!=='building')row.append(button('Open',async()=>{const p=(await store('getAll')).find(r=>r.id===x.projectId);if(p)openProject(p);}));list.append(row);});
      if(f.status==='running'&&f.retryAt>Date.now())body.append(el('p',(f.retryReason==='media'?'Some images or videos failed. The Factory makes the missing ones again at ':'Hourly limit reached. Factory will retry automatically at ')+new Date(f.retryAt).toLocaleTimeString()+'. Keep this panel open.','fb-next-stage'));
      body.append(el('div',f.status==='running'?'Running · '+F.report(f)[0]:f.status==='done'?'Finished · '+F.report(f)[0]:'Stopped · '+(f.stopReason||''),'fb-next-stage'),list);
      const actions=el('div',undefined,'fb-actions');
      if(f.status==='running')actions.append(button('Stop the Factory',async()=>{const latest=await factoryGet();if(latest){latest.status='stopped';latest.stopReason='Stopped by you.';latest.endedAt=Date.now();for(const x of latest.stories)if(['building','running','exporting'].includes(x.status)){x.status='paused';x.reason='stopped by you';}await factoryPut(latest);}await factoryAwake(false);if(running&&typeof stopQueue==='function')stopQueue();}));
      else{
        const left=f.stories.some(x=>['waiting','paused'].includes(x.status));
        if(left&&allowed.ok)actions.append(button('Resume Factory',async()=>{if(running)throw Error('Wait for the current run to finish.');const latest=await factoryGet();latest.status='running';latest.stopReason='';await factoryPut(latest);await factoryAwake(true);factoryLater(200);}));
        actions.append(button('New Factory run',async()=>{await chrome.storage.local.remove(FACTORY_KEY);factoryScreen();}));
      }
      actions.append(button('Back',()=>{factoryShown=false;home();}));body.append(actions);return;
    }
    if(!allowed.ok){body.append(el('p',allowed.reason,'fb-message'));body.append(button('Back',()=>{factoryShown=false;home();}));return;}
    const form=el('div',undefined,'fb-factory-form');
    const pick=el('select');pick.setAttribute('aria-label','Template');for(const t of orderedTemplates(templates).filter(factoryTemplate))pick.append(new Option(t.title,t.id));
    const mode=el('select');mode.setAttribute('aria-label','Topics');mode.append(new Option('AI picks the topics','auto'),new Option('I type my topics','list'));
    const list=el('textarea');list.rows=5;list.placeholder='One topic per line (up to 5)';list.hidden=true;list.setAttribute('aria-label','Your topics');
    const count=el('select');count.setAttribute('aria-label','How many stories');for(let n=1;n<=5;n++)count.append(new Option(n+(n===1?' story':' stories'),String(n)));count.value='3';
    const sheets=el('input');sheets.type='checkbox';sheets.id='fbFactorySheets';const sheetsLabel=el('label','Storyboard sheets (about 70% fewer image credits)');sheetsLabel.htmlFor=sheets.id;const sheetsRow=el('div',undefined,'fb-factory-check');sheetsRow.append(sheets,sheetsLabel);
    const kind=el('select');kind.setAttribute('aria-label','Stories or series');kind.append(new Option('Separate stories','stories'),new Option('One series (Part 1, 2, 3…)','series'),new Option('Several series (each Part 1, 2, 3…)','multi'));
    const parts=el('select');parts.setAttribute('aria-label','Parts in the series');for(const n of [2,3])parts.append(new Option(n+' parts',String(n)));
    // Owner 2026-10-29: the same Generation platforms picker as a story, inside the Factory form; it starts from the template's
    // saved choice and only changes this run.
    let chosen={};const platPanel=el('div',undefined,'fb-platform-panel fb-factory-platforms');platPanel.append(el('strong','Generation platforms'));
    const platModels=el('label','Flow video model'),platModel=el('select');for(const name of B.flowVideoModels())platModel.append(new Option(B.flowModelLabel(name),name));platModels.append(platModel);
    const platGroups={};
    for(const [key,label,platforms] of [['imagePlatform','Images',['gemini','chatgpt','flow','grok']],['videoPlatform','Videos',['flow','gemini','grok']]]){
      const row=el('div',undefined,'fb-platform-row'),group=el('div',undefined,'fb-platform-options');row.append(el('strong',label),group);group.setAttribute('role','group');group.setAttribute('aria-label',label+' platform');platGroups[key]=group;
      for(const platform of platforms){const b=button('',()=>{chosen[key]=platform;paintPlatforms();});b.dataset.platform=platform;const icon=el('img');icon.src='assets/platforms/'+platform+'.png';icon.alt='';b.append(icon,el('span',({flow:'Flow',gemini:'Gemini',chatgpt:'ChatGPT',grok:'Grok'})[platform]));group.append(b);}
      platPanel.append(row);
    }
    platPanel.append(platModels);
    // Owner 2026-11-02: the story Workflow chip inside the Factory form too. It starts from the template's choice and only
    // changes this run. Saved characters always need reference images, so Direct is off for those templates; UGC and Kitchen
    // templates are fixed to reference images first.
    const WORKFLOW_NOTES={refs:'Makes each character and place once, then every scene image from them, so faces stay the same.',direct:'Makes each scene image straight from its prompt: faster, but faces can change between scenes.',ingredients:'Makes only the character and place images; each video is made from them, with no scene images.'};
    let workflow='refs';const flowRow=el('div',undefined,'fb-platform-row'),flowGroup=el('div',undefined,'fb-platform-options'),flowNote=el('small','','fb-muted fb-workflow-note');
    flowRow.append(el('strong','Workflow'),flowGroup);flowGroup.setAttribute('role','group');flowGroup.setAttribute('aria-label','Workflow');
    for(const [value,label] of [['refs','Character images first'],['direct','Direct scene images'],['ingredients','Ingredients to Video']]){const b=button(label,()=>{workflow=value;paintWorkflow();});b.dataset.workflow=value;flowGroup.append(b);}
    platPanel.insertBefore(flowRow,platPanel.children[1]);platPanel.insertBefore(flowNote,flowRow.nextSibling);
    const workflowLocked=t=>!!t&&[56,57].includes(Number(t.answers.niche)),hasCast=t=>!!(t?.answers.characterIds||[]).length;
    const paintWorkflow=()=>{const t=templates.find(x=>x.id===pick.value),locked=workflowLocked(t);
      for(const b of flowGroup.children){b.disabled=locked&&b.dataset.workflow!=='refs'||hasCast(t)&&b.dataset.workflow==='direct';b.setAttribute('aria-pressed',String(b.dataset.workflow===workflow));}
      flowNote.textContent=locked?'This template always makes character images first.':WORKFLOW_NOTES[workflow];
      sheets.disabled=workflow==='ingredients';if(sheets.disabled)sheets.checked=false;};
    const loadWorkflow=()=>{const t=templates.find(x=>x.id===pick.value),a=t?.answers||{};workflow=workflowLocked(t)?'refs':a.exportProfile==='Recurring assets + video'?'ingredients':a.imageWorkflow==='Direct scene frames'&&!hasCast(t)?'direct':'refs';paintWorkflow();};
    pick.addEventListener('change',loadWorkflow);
    const paintPlatforms=()=>{for(const [key,group] of Object.entries(platGroups))for(const b of group.children)b.setAttribute('aria-pressed',String(b.dataset.platform===chosen[key]));platModels.hidden=chosen.videoPlatform!=='flow';};
    const loadPlatforms=()=>{const t=templates.find(x=>x.id===pick.value);chosen=B.generationTargets(t?.target,settings);if(!['flow','gemini','grok'].includes(chosen.videoPlatform))chosen.videoPlatform='flow';/* the Factory has no Google Vids */if(chosen.model&&!Array.from(platModel.options).some(x=>x.value===chosen.model))platModel.append(new Option(chosen.model,chosen.model));platModel.value=chosen.model||B.currentFlowModel('Omni 1.1 Flash');paintPlatforms();};
    pick.addEventListener('change',loadPlatforms);
    // Owner 2026-10-30: the Factory used each template's own language, so AI Drama always ran in English (United States).
    // The language and, for AI Drama, the story country are now picked here; they start from the template's choice.
    const lang=el('select');lang.setAttribute('aria-label','Viewer language');
    const customLang=el('input');customLang.type='text';customLang.maxLength=80;customLang.placeholder='Which language? (e.g. Bangla)';customLang.setAttribute('aria-label','Which language?');
    const country=el('select');country.setAttribute('aria-label','Story country');for(const name of B.DRAMA_COUNTRIES)country.append(new Option(name,name));
    const customCountry=el('input');customCountry.type='text';customCountry.maxLength=120;customCountry.placeholder='Which country or culture?';customCountry.setAttribute('aria-label','Which country or culture?');
    const loadLanguage=()=>{const t=templates.find(x=>x.id===pick.value),want=B.LANGUAGES.includes(t?.answers.language)?t.answers.language:'English';lang.textContent='';for(const name of languageChoices(t?.answers.niche,want))lang.append(new Option(name,name));lang.value=want;customLang.value=t?.answers.customLanguage||'';country.value=B.DRAMA_COUNTRIES.includes(t?.answers.dramaCountry)?t.answers.dramaCountry:'Auto (match the language)';customCountry.value=t?.answers.customCountry||'';};
    country.addEventListener('change',()=>{const main=B.countryLanguage(country.value);if(main)lang.value=main;sync();});lang.addEventListener('change',()=>sync());
    pick.addEventListener('change',loadLanguage);loadLanguage();
    const extras=el('div',undefined,'fb-factory-extras');let extraInputs=[];
    const loadExtras=()=>{const t=templates.find(x=>x.id===pick.value);extras.textContent='';extraInputs=factoryTextSteps(t?.answers).map(s=>{const input=el('textarea');input.rows=3;input.maxLength=24000;input.placeholder=s.auto?'Optional · leave empty and each story follows its topic (for example the speaker you describe in the topic)':'Used for every story of this run';input.setAttribute('aria-label',s.label);input.dataset.key=s.key;input.dataset.auto=s.auto;const row=el('label',undefined,'fb-factory-field');row.append(el('span',s.label+(s.auto?' (optional)':'')),input);extras.append(row);return input;});extras.hidden=!extraInputs.length;};
    pick.addEventListener('change',loadExtras);loadExtras();
    let listRow=null,kindRow=null,partsRow=null,countRow=null,customLangRow=null,countryRow=null,customCountryRow=null;
    const sync=()=>{const t=templates.find(x=>x.id===pick.value),drama=!!t&&B.isDrama(t.answers.niche);if(!drama)kind.value='stories';const series=kind.value==='series',multi=kind.value==='multi';
      if(kindRow)kindRow.hidden=!drama;if(partsRow)partsRow.hidden=!series&&!multi;if(countRow)countRow.hidden=series;
      const aiDrama=!!t&&B.isWorldDrama(t.answers.niche);if(customLangRow)customLangRow.hidden=lang.value!=='Custom';if(countryRow)countryRow.hidden=!aiDrama;if(customCountryRow)customCountryRow.hidden=!aiDrama||country.value!=='Custom';
      for(const o of count.options)o.text=o.value+(multi?' series':o.value==='1'?' story':' stories');
      if(listRow)listRow.hidden=mode.value!=='list';list.placeholder=series?'The series topic (one line)':multi?'One series topic per line (up to 5)':'One topic per line (up to 5)';count.disabled=mode.value==='list';};
    mode.onchange=sync;kind.onchange=sync;pick.addEventListener('change',sync);
    for(const [label,input] of [['Template',pick],['Story country',country],['',customCountry],['Language',lang],['',customLang],['Make',kind],['Parts',parts],['Topics',mode],['',list],['How many tonight',count]]){const row=el('label',undefined,'fb-factory-field');if(label)row.append(el('span',label));row.append(input);if(input===list){listRow=row;row.hidden=true;}if(input===kind)kindRow=row;if(input===parts)partsRow=row;if(input===count)countRow=row;if(input===customLang)customLangRow=row;if(input===country)countryRow=row;if(input===customCountry)customCountryRow=row;form.append(row);}
    sync();form.firstChild.after(extras);
    // Opt-in account switching (owner 2026-10-28): Flow keeps the account in the path (/u/1/ = 2nd account), up to 10 (owner 2026-11-13; Discord Pro 2), in order.
    const sw=el('input');sw.type='checkbox';sw.id='fbFactorySwitch';const swLabel=el('label','When Flow credits run out, switch to my next Flow account');swLabel.htmlFor=sw.id;const swRow=el('div',undefined,'fb-factory-check');swRow.append(sw,swLabel);
    // Compact neon panel (owner 2026-10-28): accounts are four toggle chips; the checkbox stays for state and keyboard use.
    const accBox=el('div',undefined,'fb-factory-accounts');accBox.hidden=true;accBox.append(el('div','▸ FLOW ACCOUNTS · USED IN ORDER','fb-acc-head'));
    const accGrid=el('div',undefined,'fb-acc-grid');accBox.append(accGrid);
    const ACC_NAMES=['Main','2nd','3rd','4th','5th','6th','7th','8th','9th','10th'];const accChecks=ACC_NAMES.map((name,n)=>{const c=el('input');c.type='checkbox';c.id='fbFactoryAcc'+n;c.value=String(n);c.checked=n<2;c.className='fb-acc-input';const l=el('label',name);l.htmlFor=c.id;l.className='fb-acc-chip';l.title=n===0?'Your main Google account in Flow':'The '+name+' account in Flow\'s account menu';accGrid.append(c,l);return c;});
    const paid=el('input');paid.type='checkbox';paid.id='fbFactoryPaid';const paidLabel=el('label','Each chosen account has its own paid Flow plan');paidLabel.htmlFor=paid.id;const paidRow=el('div',undefined,'fb-factory-check fb-factory-paid');paidRow.append(paid,paidLabel);
    accBox.append(el('small','Order of Flow\'s account menu · max 10 (Discord Pro 2) · sign in to each in Chrome first · ~2½ min pause before a switch · unusual activity stops all.','fb-acc-note'),paidRow);
    sw.onchange=()=>{accBox.hidden=!sw.checked;};
    const sep=()=>el('hr',undefined,'fb-factory-sep');form.append(sep(),platPanel,sep(),sheetsRow,swRow,accBox,sep());body.append(form);loadPlatforms();loadWorkflow();
    const start=button('▶ Start the Factory',async()=>{
      if(running)throw Error('Wait for the current run to finish first.');
      const t=templates.find(x=>x.id===pick.value);if(!t)throw Error('Choose a template.');
      const target={...t.target,imagePlatform:chosen.imagePlatform,videoPlatform:chosen.videoPlatform,model:platModel.value};
      const duration=Number(t.answers.sceneDuration);if(target.videoPlatform==='flow'&&/^veo/i.test(target.model)&&duration!==8)throw Error('This template uses '+duration+'s scenes. Select Flow Omni, Gemini or Grok; Veo needs 8s scenes.');
      if(workflow==='ingredients'&&target.videoPlatform==='grok')throw Error('Grok Ingredients to Video needs 2 or more character images in every scene. Choose Flow or Gemini videos, or another workflow.');
      if((target.videoPlatform==='grok'||target.imagePlatform==='grok')&&typeof ensureGrokAccess==='function'&&!await ensureGrokAccess())throw Error('Allow Grok access before starting.');
      const flowImages=['flow','chatgpt'].includes(B.generationTargets(target,settings).imagePlatform);
      const answers={...t.answers,language:lang.value};delete answers.customLanguage;
      if(!workflowLocked(t)){answers.exportProfile=workflow==='ingredients'?'Recurring assets + video':t.answers.exportProfile==='Recurring assets + video'||!t.answers.exportProfile?'Scene image + video':t.answers.exportProfile;answers.imageWorkflow=workflow==='direct'?'Direct scene frames':'Reference images first';}
      if(lang.value==='Custom'){if(!customLang.value.trim())throw Error('Type the language for the stories.');answers.customLanguage=customLang.value.trim();}
      for(const input of extraInputs){const v=input.value.trim()||input.dataset.auto;if(!v)throw Error('Fill in: '+input.getAttribute('aria-label'));answers[input.dataset.key]=v;}
      if(B.isWorldDrama(t.answers.niche)){answers.dramaCountry=country.value;delete answers.customCountry;if(country.value==='Custom'){if(!customCountry.value.trim())throw Error('Type the story country.');answers.customCountry=customCountry.value.trim();}}
      await factoryStart({templateId:t.id,answers,target,count:mode.value==='list'?5:Number(count.value),topicMode:mode.value,topics:list.value,storyboard:sheets.checked&&flowImages,switchAccounts:sw.checked,accounts:accChecks.filter(c=>c.checked).map(c=>Number(c.value)),confirmedPaid:paid.checked,series:kind.value!=='stories',parts:Number(parts.value),seriesCount:kind.value==='multi'?(mode.value==='list'?5:Number(count.value)):1});
      factoryScreen();
    });start.classList.add('fb-primary');
    body.append(el('small','Stops cleanly when Flow credits run out (everything made so far is kept) and at once if Flow reports unusual activity.','fb-muted'));
    const actions=el('div',undefined,'fb-actions');actions.append(button('Back',()=>{factoryShown=false;home();}),start);body.append(actions);
  }
  // A Factory story's run ended without finishing: credits, unusual activity, Stop or failed prompts.
  async function factoryQueueEnded(result,ids){
    if(result.clean||ids.length!==1)return;
    const F=await factoryModule(),f=await factoryGet();if(!f||f.status!=='running')return;
    const index=f.stories.findIndex(x=>x.projectId===ids[0]&&x.status==='running');if(index<0)return;
    let kind=F.classifyQueueEnd(result);
    if(kind==='hourly-limit')return factoryWaitHourly(f,index,result.reason);
    // A failed image or video gets two automatic retries of the missing ones before the story is skipped (owner 2026-11-08).
    // Flow refused the same prompt twice and nothing else failed: a restart would only resend it unchanged (owner 2026-11-11).
    if(kind==='failed'&&result.refusedOnly)factorySay('story '+(index+1)+': Flow refused the same prompt twice; it is not resent automatically.');
    if(kind==='failed'&&!result.refusedOnly){const retry=F.scheduleMediaRetry(f,index,result.reason);if(retry){await factoryPut(f,true);factorySay('story '+(index+1)+': '+f.stories[index].reason+' at '+new Date(f.retryAt).toLocaleTimeString()+'.');return factoryLater(retry.ms);}}
    if(kind==='failed'){const p=(await store('getAll')).find(x=>x.id===ids[0]);if(F.canContinueWrittenPart(p))kind='media-incomplete';}
    const action=F.storyEnded(f,index,kind,kind==='failed'||kind==='media-incomplete'?'some prompts failed after repair':result.reason||'');await factoryPut(f,true);
    if(action.action==='stop')return factoryHalt(f,action.reason);
    if(action.action==='switch'){
      // Opt-in account switching: pause, move the Flow tab to the next account, then resume the same story there.
      const label=F.flowAccountLabel(action.account);
      factorySay('Flow credits ran out. Switching to '+label+' in about '+Math.round(action.pauseMs/60000*10)/10+' minutes…');
      await new Promise(r=>setTimeout(r,action.pauseMs));
      const latest=await factoryGet();if(!latest||latest.status!=='running')return;
      try{await factoryUseAccount(action.account);}catch(e){return factoryHalt(latest,'Could not switch Flow to '+label+': '+(e.message||e)+'. Sign in to that account in Chrome, then resume the Factory.');}
      factorySay('now on '+label+'; continuing story '+(index+1)+'.');return factoryLater(3000);
    }
    if(action.action==='next'){factorySay('story '+(index+1)+(kind==='media-incomplete'?' needs attention; continuing: ':' skipped: ')+f.stories[index].reason);factoryLater(5000);}
  }
  // Maintenance lock (owner 2026-11-11): the owner switches it with the Discord /maintenance command. While it is on, the
  // AI Story panel is blurred under a lock card and the server refuses new stories (so the lock holds even without this
  // screen). A story or Factory already running keeps going and only shows a banner; the owner's account passes.
  let maintenance={on:false},maintenanceLayer=null,maintenanceBanner=null;
  function maintenanceNodes(){
    if(!maintenanceLayer){maintenanceLayer=el('div',undefined,'fb-maintenance');maintenanceBanner=el('div',undefined,'fb-maintenance-banner');maintenanceLayer.hidden=true;maintenanceBanner.hidden=true;maintenanceLayer.setAttribute('role','alertdialog');maintenanceLayer.setAttribute('aria-modal','true');maintenanceBanner.setAttribute('role','status');}
    return [maintenanceLayer,maintenanceBanner];
  }
  async function maintenanceBusy(){if(typeof running!=='undefined'&&running)return true;try{return (await factoryGet())?.status==='running';}catch{return false;}}
  // A failed check keeps the last answer (a short internet blip neither locks nor unlocks); an older server without the
  // switch answers 404, which means off.
  async function maintenanceRefresh(){
    try{const connection=await chrome.storage.local.get(['remoteRepairUrl','remoteRepairToken']);if(!connection.remoteRepairToken||!connection.remoteRepairUrl)return maintenance;
      const r=await remoteRepairRequest(connection,'/builder/maintenance');maintenance=r.status===200&&r.body?.on===true?r.body:{on:false};announcement=r.status===200&&r.body?.announcement?.text?r.body.announcement:null;}catch{}
    await maintenancePaint();await announcementPaint().catch(()=>{});return maintenance;
  }
  async function maintenancePaint(){
    maintenanceNodes();const m=maintenance,title=m.mode==='upgrading'?'System is upgrading':'System in maintenance mode';
    const lock=on=>{maintenanceLayer.hidden=!on;dialog.classList.toggle('fb-locked',on);body.inert=on;message.inert=on;};
    if(!m.on){lock(false);maintenanceBanner.hidden=true;return;}
    if(m.pass||await maintenanceBusy()){
      lock(false);maintenanceBanner.replaceChildren(el('strong',title),el('span',m.pass?'Members are locked out. Your account passes.':'Your running story keeps going. New stories start after maintenance ends.'));maintenanceBanner.hidden=false;return;
    }
    maintenanceBanner.hidden=true;
    const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');for(const [k,v] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))icon.setAttribute(k,v);
    for(const d of ['M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z','M8 11V7a4 4 0 0 1 8 0v4','M12 15v2']){const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',d);icon.append(path);}
    const badge=el('div',undefined,'fb-maintenance-lock');badge.append(icon);
    const card=el('div',undefined,'fb-maintenance-card'),heading=el('h3',title);heading.id='fbMaintenanceTitle';maintenanceLayer.setAttribute('aria-labelledby',heading.id);
    const status=el('p','','fb-maintenance-note');status.setAttribute('aria-live','polite');
    const again=button('Check again',async()=>{again.disabled=true;status.textContent='Checking…';try{const next=await maintenanceRefresh();if(next.on)status.textContent='Still in progress. Please check again in a few minutes.';}finally{again.disabled=false;}});
    card.append(badge,heading);if(m.message)card.append(userText('p',m.message,'fb-maintenance-message'));
    card.append(el('p','AI Story is paused for a short time. Your saved projects are safe on this device.'),again,status);
    maintenanceLayer.replaceChildren(card);lock(true);
  }
  // Announcement banner (owner 2026-11-11): the owner's Discord /announce shows one closable banner under the header, on
  // every tab. Closing it is remembered on this device until the owner posts a new one (a new id). The text is the owner's
  // own words, shown as written; only the button labels are translated.
  let announcement=null,announcementNode=null;
  let announcementResize=null;
  function announcementMarquee(box,track){
    const fit=()=>{const cw=box.clientWidth,tw=track.scrollWidth;if(!cw||!tw)return;track.style.setProperty('--fb-from',cw+'px');track.style.setProperty('--fb-to',-tw+'px');track.style.setProperty('--fb-marquee',Math.max(6,(cw+tw)/55).toFixed(1)+'s');};
    fit();announcementResize?.disconnect();if(typeof ResizeObserver==='function'){announcementResize=new ResizeObserver(fit);announcementResize.observe(box);}
  }
  async function announcementPaint(){
    if(!announcementNode){
      announcementNode=el('aside',undefined,'fb-announcement');announcementNode.hidden=true;announcementNode.setAttribute('role','status');
      const anchor=document.getElementById('updateBanner')||document.querySelector('.top-tabs');if(!anchor)return;
      anchor.id==='updateBanner'?anchor.after(announcementNode):anchor.before(announcementNode);
    }
    const a=announcement,closed=a?((await chrome.storage.local.get('announcementClosed')).announcementClosed===a.id):true;
    if(!a||closed){announcementNode.hidden=true;announcementNode.replaceChildren();return;}
    if(announcementNode.dataset.id===a.id&&!announcementNode.hidden)return;
    announcementNode.dataset.id=a.id;announcementNode.dataset.style=a.style||'info';
    const icon=el('span',a.style==='important'?'⚠':a.style==='promo'?'🎁':'📣','fb-announcement-icon');icon.setAttribute('aria-hidden','true');
    const marquee=el('span',undefined,'fb-announcement-marquee'),track=el('span',undefined,'fb-announcement-track');
    marquee.title=a.text;track.append(userText('span',a.text,'fb-announcement-text'));marquee.append(track);
    const parts=[icon,marquee];
    if(a.link){const link=el('a',a.label||'Open','fb-announcement-link');if(a.label)link.setAttribute('data-no-i18n','');link.href=a.link;link.target='_blank';link.rel='noopener noreferrer';parts.push(link);}
    const close=el('button','×','fb-announcement-close');close.type='button';close.setAttribute('aria-label','Close announcement');close.title='Close';
    close.onclick=async()=>{announcementNode.hidden=true;try{await chrome.storage.local.set({announcementClosed:a.id});}catch{}};
    parts.push(close);announcementNode.replaceChildren(...parts);announcementNode.hidden=false;announcementMarquee(marquee,track);
  }
  async function init(){
    const data=await Promise.all([fetch('lib/faceless-niches.json').then(r=>r.json()),fetch('lib/faceless-templates.json').then(r=>r.json())]);catalog=data[0];templates=data[1].templates;
    const style=el('style');style.textContent='.fb-dialog{color:#eee;background:#12111d;border:1px solid #776493;border-radius:20px;width:min(560px,90vw);max-height:85vh;padding:20px}.fb-dialog::backdrop{background:#070611c9;backdrop-filter:blur(6px)}.fb-body{display:grid;gap:12px}.fb-dialog h2,.fb-dialog h3,.fb-dialog p{margin:4px 0}.fb-dialog h2{font-size:18px;margin-right:auto}.fb-dialog .fb-primary{background:linear-gradient(110deg,#bea0ff,#8ee5df);color:#171020;font-weight:700}.fb-dialog select,.fb-dialog textarea{width:100%;box-sizing:border-box;background:#191724;color:#eee;border:1px solid #443950;border-radius:10px;padding:10px;font:inherit}.fb-dialog button{padding:9px 12px;border:1px solid #594b76;border-radius:10px;background:#282136;color:#eee;font:inherit;cursor:pointer}.fb-dialog button:hover{border-color:#82e8e3;background:#342a48}.fb-card{display:grid;gap:8px;border:1px solid #363044;border-radius:12px;padding:12px}.fb-card img{max-width:160px;max-height:130px;object-fit:contain}.fb-actions{display:flex;flex-wrap:wrap;gap:8px}.fb-muted,.fb-dialog small{color:#b7adc9;font-size:12px}.fb-message{color:#ffcf97;white-space:pre-wrap}.fb-launch{margin:8px 0}.fb-gallery{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.fb-dialog .fb-template{display:grid;gap:7px;text-align:left;padding:14px;background:linear-gradient(145deg,#211c32,#151924);transition:transform .16s,border-color .16s}.fb-dialog .fb-template:hover{transform:translateY(-2px);border-color:#ba9bfa}.fb-template-icon{color:#9eece8;font-size:22px}.fb-template strong{font-size:13px}.fb-dialog .fb-template small{font-size:11px}@media(max-width:360px){.fb-gallery{grid-template-columns:1fr}}';document.head.append(style);
    const top=el('div',undefined,'fb-actions fb-builder-head'),mark=el('span',undefined,'fb-builder-mark');mark.setAttribute('aria-hidden','true');
    const movieIcon=document.createElementNS('http://www.w3.org/2000/svg','svg');
    for(const [name,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round'}))movieIcon.setAttribute(name,value);
    for(const d of ['M3 10h18v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z','M3 10 2 5l18-3 1 5Z','m7 4 3 4','m13 3 3 4','M10 13l5 3-5 3Z']){const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',d);movieIcon.append(path);}mark.append(movieIcon);top.append(mark,el('h2','AI Story'),el('span',templates.length+' templates','fb-builder-count'),button('Control →',()=>dialog.close()));maintenanceNodes();dialog.append(top,maintenanceBanner,message,body,maintenanceLayer);$('controlTabPanel').after(dialog);
    // Maintenance is checked now, every 2 minutes while the panel is visible, and when it becomes visible again.
    maintenanceRefresh();setInterval(()=>{if(!document.hidden)maintenanceRefresh();},120000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)maintenanceRefresh();});
    const builderTab=button('AI Story',async()=>{const alreadyBrowsing=dialog.open&&Boolean(body.querySelector('.fb-gallery'));switchTab(dialog.id,builderTab);if(!alreadyBrowsing)await home();});builderTab.id='builderTabBtn';builderTab.className='top-tab';builderTab.setAttribute('role','tab');builderTab.setAttribute('aria-controls',dialog.id);builderTab.setAttribute('aria-selected','false');$('controlTabBtn').after(builderTab);
    try{const saved=(await chrome.storage.local.get('facelessAutoRun')).facelessAutoRun;if(saved)autoRun={on:saved.on===true};}catch{}
    await restoreFactory();
    chrome.runtime.onMessage.addListener((message,sender)=>{if(message?.type==='factory-export-done'&&sender.id===chrome.runtime.id&&String(sender.url||'').startsWith(chrome.runtime.getURL('story-workspace.html')))factoryExportDone(message).catch(e=>factorySay(e.message));return false;});
    continuation=el('section',undefined,'fb-continuation');continuation.hidden=true;$('runCard').after(continuation);await showContinuation();scheduleBuildWatch();
  }
  // AI assistant (MCP, owner 2026-10-31): flow-mcp-bridge.js starts and stops the same Story Factory as the Start button,
  // with the template's own platforms and no account switching. Factory rules (Pro, trial, one run at a time) apply unchanged.
  function mcpSnapshot(){return{templates:templates.map(x=>({id:x.id,title:x.title,language:x.answers.language||'English'})),languages:B.LANGUAGES.filter(x=>x!=='Custom')};}
  async function mcpFactory(){const f=await factoryGet();return f&&{status:f.status,stopReason:f.stopReason||'',startedAt:f.startedAt,endedAt:f.endedAt||0,stories:f.stories.map(s=>({topic:s.topic,status:s.status,reason:s.reason||''}))};}
  // Typed setup answers a template leaves empty (owner 2026-11-07: Science Proves God needs "Real speaker or AI speaker?
  // Describe them."). The Factory never asked them, so every story of 13 templates was skipped at setup.
  // UGC product ads need a Creative brief, which Factory runs do not make yet (owner 2026-11-07: hide them there).
  function factoryTemplate(t){return Number(t?.answers?.niche)!==56;}
  // Owner 2026-11-07: the speaker, object, character or topic lane can come from each topic, so those boxes are optional;
  // empty sends a note that the writer follows each topic (the server still requires a value). Custom niche, lyrics and
  // sources stay required.
  function factoryAuto(a,key){const n=Number(a?.niche);if(key==='topicLane')return 'Not chosen in the Factory: follow each topic.';if(key!=='special')return '';
    return ({29:'Not chosen in the Factory: the object named in each topic speaks; if the topic names none, pick an everyday object that fits the topic.',
      31:'Not chosen in the Factory: follow the character described in each topic; if the topic describes none, create one consistent host who fits the topic.',
      32:'Not chosen in the Factory: follow the speaker described in each topic (real or AI, look, age, clothing, place); if the topic describes none, use a realistic AI presenter who fits the topic.'})[n]||'';}
  function factoryTextSteps(a){if(!a)return[];return B.steps({...a,topic:'-',topicMode:'Existing topic',partsTotal:String(a.partsTotal||1)}).filter(s=>s.type==='text'&&!['topic','customLanguage','customCountry'].includes(s.key)&&!String(a[s.key]??'').trim()).map(s=>({...s,auto:factoryAuto(a,s.key)}));}
  async function mcpStartFactory({templateId,topics,language}){
    if(running)throw Error('A queue is already running in the panel. Wait for it to finish.');
    const t=templates.find(x=>x.id===templateId);if(!t)throw Error('Unknown template "'+templateId+'". Use list_templates.');
    if(!factoryTemplate(t))throw Error('The template "'+t.title+'" cannot run in the Factory yet. Make it with AI Story → New story.');
    const answers={...t.answers};
    const missing=factoryTextSteps(answers).filter(s=>!s.auto||!(answers[s.key]=s.auto));if(missing.length)throw Error('The template "'+t.title+'" needs: '+missing.map(s=>s.label).join('; ')+'. Start it from the Factory in the panel.');
    if(language&&language!==answers.language){if(!B.LANGUAGES.includes(language)||language==='Custom')throw Error('Unknown language "'+language+'".');answers.language=language;delete answers.customLanguage;}
    const g=B.generationTargets(t.target,settings),target={...t.target,imagePlatform:g.imagePlatform,videoPlatform:g.videoPlatform,model:g.model};
    if(target.videoPlatform!=='flow')throw Error('The AI assistant can only start Flow runs. Choose Flow in AI Story settings.');
    // Grok images need Chrome's Grok permission, which only a click in the panel can grant (owner 2026-11-01).
    if(target.imagePlatform==='grok'&&!await chrome.permissions.contains({origins:['https://grok.com/*','https://*.grok.com/*']}).catch(()=>false))throw Error('This template makes its images on Grok. Allow Grok access once in the panel (AI Story → Factory → Start with Grok images), then try again.');
    if(/^veo/i.test(target.model||'')&&Number(t.answers.sceneDuration)!==8)throw Error('This template uses '+t.answers.sceneDuration+'s scenes; Veo needs 8s scenes. Choose Flow Omni in AI Story.');
    const list=(topics||[]).map(x=>String(x).trim()).filter(Boolean).slice(0,5);
    if(await factoryStart({templateId:t.id,answers,target,count:list.length,topicMode:'list',topics:list.join('\n'),storyboard:false,switchAccounts:false,accounts:[],series:false})===false)throw Error('This month\'s Factory run is used. Upgrade to Pro for more.');
    return 'Story Factory started: '+list.length+(list.length===1?' story':' stories')+' with '+t.title+'.';
  }
  // Prompts from the user's AI chat become a normal AI Story project (owner 2026-11-09). Saving never starts anything.
  async function mcpSaveProject(args){
    const {buildProject}=await import('./lib/mcp-project.mjs'),p=buildProject(args,settings,B);await store('put',p);
    if(!running){await chrome.storage.local.set({facelessActiveProjectId:p.id,facelessDismissedProjectId:''});await showContinuation();}
    log('AI assistant saved a project: '+p.project.title);
    const steps=p.setup.exportProfile==='Recurring assets + video'?p.project.assets.length+' ingredient image(s), then videos':'scene images, then videos';
    return 'Saved "'+p.project.title.slice(0,60)+'": '+p.project.scenes.length+' scene(s), '+steps+'. Images: '+p.target.imagePlatform+'. Videos: '+(p.target.model||'Flow')+'. Nothing has started. Project id: '+p.id.slice(0,8)+'. It is in AI Story > Projects.';
  }
  async function mcpRunProject({projectId}){
    if(running)throw Error('A queue is already running in the panel. Wait for it to finish.');
    const unfinished=queue.filter(x=>['pending','error'].includes(x.status)).length;if(unfinished)throw Error('The panel queue still has '+unfinished+' unfinished prompt(s). Finish or clear them in the panel first.');
    if((await mcpFactory())?.status==='running')throw Error('The Story Factory is running. Wait for it to finish.');
    const p=(await store('getAll')).find(x=>x.origin==='ai-chat'&&String(x.id).slice(0,8)===projectId);if(!p)throw Error('That project is not on this device. Save it again.');
    const next=autoNextStep(p);if(next.stop)throw Error(next.stop);
    const g=B.generationTargets(p.target,settings),engines=[...(next.stage==='videos'?[]:[g.imagePlatform]),g.videoPlatform],{chatInTheWay}=await import('./lib/mcp-project.mjs'),[tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true}).catch(()=>[]),inTheWay=chatInTheWay(tab?.url,engines);
    if(inTheWay)throw Error('This project runs on '+inTheWay+', and starting it from this chat would type into the chat. Press Auto: run all steps in the panel. Nothing was started.');
    if(engines.includes('grok')&&!await chrome.permissions.contains({origins:['https://grok.com/*','https://*.grok.com/*']}).catch(()=>false))throw Error('This project uses Grok. Press Auto: run all steps in the panel once to allow Grok.');
    await startFromProject(p,true,async()=>{quietLoad=true;try{return await next.run();}finally{quietLoad=false;}});
    if(!running)throw Error($('applyStatus').textContent||'The panel did not start. Open the project in AI Story to see why.');
    return 'Started "'+p.project.title.slice(0,60)+'": '+next.label+', then every remaining step. Progress is in get_status.';
  }
  async function mcpStopFactory(){
    const f=await factoryGet();if(f?.status!=='running')return 'The Story Factory is not running.';
    f.status='stopped';f.stopReason='Stopped by your AI assistant.';f.endedAt=Date.now();for(const x of f.stories)if(['building','running','exporting'].includes(x.status)){x.status='paused';x.reason='stopped by your AI assistant';}
    await factoryPut(f);await factoryAwake(false);if(running&&typeof stopQueue==='function')stopQueue();return 'Story Factory stopped. Everything made so far is kept.';
  }
  window.FlowBuilderUI={factoryOwns,mcpSnapshot,mcpFactory,mcpStartFactory,mcpStopFactory,mcpSaveProject,mcpRunProject,prepareManualQueue,rememberManualInput,captureManualVideo,removeWorkspaceProjects:async ids=>{const workspace=await import('./lib/story-workspace.mjs');for(const id of ids)await workspace.removeProject(id);},generateCover,regenerateScene,captureVideo,captureImage,queueEnded,queueChanged,autoRunOn,autoStatus,flowReferenceTags,autoProgress,factoryFlowTab};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>init().catch(console.error));else init().catch(console.error);
})();




// Animated build indicator uses the existing polling cycle; no extra server calls.
(()=>{const style=document.createElement('style');style.textContent=`
.fb-build-progress{padding:16px;border:1px solid #65508d;border-radius:14px;background:linear-gradient(120deg,#2a2042,#142d35);box-shadow:0 0 22px #a179ff15;display:grid;gap:12px}
.fb-progress-label{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:13px}.fb-progress-label span{color:#9ff3e8;font-weight:700;font-variant-numeric:tabular-nums}
.fb-progress-track{height:9px;background:#090c18;border-radius:20px;overflow:hidden}.fb-progress-fill{position:relative;height:100%;min-width:3px;border-radius:inherit;background:linear-gradient(90deg,#ad83ff,#80e8df);transition:width 2.8s ease;box-shadow:0 0 12px #a98bff88;overflow:hidden}
.fb-progress-fill::after{content:'';position:absolute;inset:0;background:linear-gradient(100deg,transparent,#ffffff80,transparent);transform:translateX(-100%);animation:fb-build-shimmer 1.8s linear infinite}.fb-build-progress small{font-size:11px;color:#bdb5cf}
@keyframes fb-build-shimmer{to{transform:translateX(100%)}}@media(prefers-reduced-motion:reduce){.fb-progress-fill{transition:none}.fb-progress-fill::after{animation:none}}
`;document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent=`
#builderTabPanel{width:auto;max-height:none;margin:16px 0;padding:16px;border-radius:16px;box-sizing:border-box}#builderTabPanel.hidden{display:none}#builderTabPanel .fb-body{margin-top:14px}#builderTabPanel .fb-card img{max-width:100%;max-height:240px;border-radius:10px}#builderTabPanel .fb-editors{min-width:0}#builderTabPanel summary{cursor:pointer;padding:6px 0;color:#cbb9f5;font-size:13px}#builderTabPanel label{display:grid;gap:7px;margin-top:14px;color:#bdb4d0;font-size:12px}#builderTabPanel textarea{display:block;min-height:84px;resize:vertical;line-height:1.65;font:13px/1.65 system-ui,sans-serif;color:#eae6f3;padding:12px;border-radius:10px;max-width:100%}#builderTabPanel textarea:focus{outline:2px solid #a994e5;outline-offset:2px}#builderTabPanel .fb-card{min-width:0}#builderTabPanel .fb-actions{gap:8px}#builderTabPanel input[type=file]{max-width:100%;font-size:12px}#builderTabBtn{white-space:nowrap}
`;document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent=`
.top-tabs{grid-template-columns:repeat(5,minmax(0,1fr));gap:2px;padding:3px;border-radius:10px}.top-tabs .top-tab{padding:8px 2px;font-size:11px;line-height:1.2;white-space:nowrap;border-radius:7px;min-height:32px}
#builderTabPanel{width:100%;max-width:none;padding:12px}#builderTabPanel .fb-body{width:100%;min-width:0;justify-items:stretch}#builderTabPanel .fb-media-card{display:grid;grid-template-columns:minmax(100px,30%) minmax(0,1fr);gap:14px;width:100%;max-width:none;box-sizing:border-box;align-items:start;margin:0;padding:12px}#builderTabPanel .fb-visual{display:grid;gap:10px;min-width:0}#builderTabPanel .fb-visual strong{font-size:11px}#builderTabPanel .fb-visual img{width:100%;max-height:280px;object-fit:contain;background:#0c0b14}#builderTabPanel .fb-editors label{margin-top:10px;font-size:10px;gap:5px}#builderTabPanel .fb-editors label:first-child{margin-top:0}#builderTabPanel .fb-editors textarea{font:11px/1.55 system-ui,sans-serif;padding:9px;min-height:66px;border-radius:8px}#builderTabPanel .fb-visual input{font-size:10px;width:100%;min-width:0}#builderTabPanel .fb-visual input::file-selector-button{font:10px system-ui;padding:5px;border:1px solid #65517d;border-radius:6px;background:#2a233b;color:#ddd}
@media(max-width:350px){#builderTabPanel .fb-media-card{grid-template-columns:minmax(80px,28%) minmax(0,1fr);gap:8px;padding:8px}.top-tabs .top-tab{font-size:10px}}
`;document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent=`
#builderTabPanel .fb-template{overflow:hidden;padding:10px;align-content:start}#builderTabPanel .fb-template-cover{display:block;width:100%;aspect-ratio:3/2;height:auto;object-fit:cover;border-radius:8px;background:#191624}#builderTabPanel .fb-template:has(.fb-template-cover) .fb-template-icon{display:none}
`;document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent=`#builderTabPanel .fb-template-section>summary{padding:12px;border:1px solid #645080;border-radius:10px;background:#251d35;color:#e1d4f7;font-weight:600;margin-bottom:12px}#builderTabPanel .fb-template-section .fb-gallery{margin-top:12px}`;document.head.append(style);})();

// Fill each media row vertically so prompt editing uses the available image height.
(()=>{const style=document.createElement('style');style.textContent=`
#builderTabPanel .fb-media-card{align-items:stretch}
#builderTabPanel .fb-media-card .fb-editors{display:flex;flex-direction:column;gap:10px;align-self:stretch;min-height:0}
#builderTabPanel .fb-media-card .fb-editors label{display:flex;flex-direction:column;flex:1 1 auto;margin:0;min-height:0}
#builderTabPanel .fb-media-card .fb-editors textarea{flex:1 1 auto;min-height:110px;height:auto;box-sizing:border-box;margin:0}
#builderTabPanel .fb-media-card .fb-editors label:only-child textarea{min-height:280px}
#builderTabPanel .fb-media-card .fb-visual{align-content:start}
`;document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent=`
#builderTabPanel .fb-project-section{width:100%;box-sizing:border-box;border:1px solid #40354f;border-radius:12px;overflow:hidden;background:#15121f}#builderTabPanel .fb-project-section>summary{font-size:12px;padding:10px 12px;margin:0;color:#e0d6ef;font-weight:600}#builderTabPanel .fb-project-list{display:grid;gap:0}#builderTabPanel .fb-project-row{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;box-sizing:border-box;padding:9px 12px;border-top:1px solid #30283e;min-height:58px}#builderTabPanel .fb-project-info{display:grid;gap:4px;min-width:0;flex:1}#builderTabPanel .fb-project-info strong{font-size:12px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#builderTabPanel .fb-project-info small{font-size:10px;color:#a69bb9}#builderTabPanel .fb-project-row button{font-size:11px;padding:6px 9px;flex:none;width:auto;min-height:28px}#builderTabPanel .fb-project-pager{display:flex;align-items:center;justify-content:center;gap:12px}#builderTabPanel .fb-project-pager:not(:empty){padding:8px;border-top:1px solid #30283e}#builderTabPanel .fb-project-pager button{padding:4px 10px;font-size:12px}#builderTabPanel .fb-project-pager button:disabled{opacity:.35;cursor:default}
`;document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent=`
#builderTabPanel .fb-library-tabs{display:flex;gap:6px;border-bottom:1px solid #393044;padding-bottom:10px}#builderTabPanel .fb-library-tabs button{font-size:12px;padding:7px 12px;background:transparent;border-color:transparent}#builderTabPanel .fb-library-tabs button[aria-selected=true]{background:#302640;border-color:#745b95;color:#efe3ff}#builderTabPanel .fb-library-controls{display:grid;gap:8px}#builderTabPanel .fb-library-controls input{width:100%;box-sizing:border-box;border:1px solid #40374f;border-radius:9px;padding:10px;background:#15121d;color:#eee;font:12px system-ui}#builderTabPanel .fb-library-filters{display:grid;grid-template-columns:1fr 1fr;gap:8px}#builderTabPanel .fb-library-filters select{font-size:11px;padding:7px}#builderTabPanel .fb-library-results{display:grid;gap:12px;min-width:0}#builderTabPanel .fb-cover-box{position:relative;width:100%;aspect-ratio:3/2;border-radius:7px;background:linear-gradient(135deg,#2a2140,#191624);overflow:hidden}#builderTabPanel .fb-niche-badge{position:absolute;top:6px;left:6px;background:#251833e8;color:#e8d7ff;border:1px solid #b294cf77;border-radius:5px;padding:3px 6px;font-size:9px;font-weight:700}#builderTabPanel .fb-template-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center}#builderTabPanel .fb-type-badge{font-size:9px;border-radius:5px;background:#17332f;color:#8be3cd;padding:3px 5px}#builderTabPanel .fb-template-meta small{font-size:9px}#builderTabPanel .fb-library-results .fb-project-list{border:1px solid #393044;border-radius:10px;overflow:hidden}#builderTabPanel .fb-template-cover{border-radius:7px}
`;document.head.append(style);})();

// Compact Builder library chrome.
(()=>{const style=document.createElement('style');style.textContent=`
#builderTabPanel{padding:12px;margin-top:10px}#builderTabPanel>.fb-actions{align-items:center;gap:8px}#builderTabPanel>.fb-actions h2{font:800 17px/1.2 system-ui,sans-serif;letter-spacing:-.5px;background:linear-gradient(105deg,#eee4ff 10%,#b79aff 50%,#8ce9e0);-webkit-background-clip:text;background-clip:text;color:transparent;text-shadow:0 0 18px #b292ff15;margin:0 auto 0 0}#builderTabPanel>.fb-actions>button{font-size:11px;padding:6px 9px;min-height:28px;border-radius:8px}#builderTabPanel .fb-body{gap:9px;margin-top:10px}#builderTabPanel .fb-message:empty{display:none}#builderTabPanel .fb-library-tabs{padding-bottom:7px;gap:4px}#builderTabPanel .fb-library-tabs button{font-size:11px;padding:6px 9px;border-radius:7px;min-height:28px}#builderTabPanel .fb-library-controls{gap:6px}#builderTabPanel .fb-library-controls input{padding:8px 10px;font-size:11px;min-height:32px;border-radius:8px}#builderTabPanel .fb-library-filters{gap:6px}#builderTabPanel .fb-library-filters select{padding:6px 8px;font-size:10px;min-height:30px;border-radius:8px}#builderTabPanel .fb-library-results{gap:9px}#builderTabPanel .fb-library-results>.fb-muted{font-size:10px}
html{scrollbar-gutter:stable}
`;document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent=`.fb-continuation{margin:12px 0;padding:14px;border:1px solid #796095;border-radius:13px;background:linear-gradient(115deg,#241a36,#15272d);display:grid;gap:7px}.fb-continuation[hidden]{display:none}.fb-continuation>strong{font-size:12px}.fb-continuation small{font-size:11px;color:#b6a9c8}.fb-continuation .fb-continue-label{font-size:9px;letter-spacing:1px;color:#ac94d3}.fb-continue-status{color:#a5e5cf;font-size:13px;font-weight:650}.fb-continuation .fb-actions{display:flex;gap:8px;margin-top:5px}.fb-continuation button{font:11px system-ui;padding:9px;border:1px solid #65517e;border-radius:8px;background:#282035;color:#ddd;cursor:pointer}.fb-continuation button.fb-primary{flex:1;background:linear-gradient(110deg,#c0a1ff,#8ce3dc);color:#181020;font-weight:750;border:0}.fb-continuation button:disabled{opacity:.45;cursor:default}`;document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent=`
.fb-continuation .fb-stage-running{position:relative;overflow:hidden;opacity:1!important;background:linear-gradient(110deg,#644a8f,#276c74)!important;color:#efe7ff!important}.fb-stage-running::before{content:'';display:inline-block;width:3px;height:13px;border:0;border-radius:2px;background:#b8fbef;box-shadow:-5px 0 0 #cbb4ff,5px 0 0 #8fe5df;vertical-align:-2px;margin:0 13px 0 5px;transform-origin:center;animation:fb-stage-bars 1s ease-in-out infinite}.fb-stage-running::after{content:'';position:absolute;inset:0;background:linear-gradient(110deg,transparent,#ffffff18,transparent);animation:fb-stage-sweep 2s linear infinite;pointer-events:none}.fb-continue-links{display:flex;justify-content:space-between;gap:8px}.fb-continuation .fb-continue-links button{border:0;background:none;padding:3px 0;color:#c3b3d9;font-size:10px}.fb-inline-review{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;max-height:300px;overflow:auto;padding:6px 0}.fb-inline-review img{display:block;width:100%;height:120px;object-fit:contain;background:#101019;border-radius:7px}.fb-inline-review small{font-size:9px}.fb-inline-review>div{min-width:0}@keyframes fb-stage-bars{0%,100%{transform:scaleY(.45);box-shadow:-5px -3px 0 #cbb4ff,5px 3px 0 #8fe5df;opacity:.65}50%{transform:scaleY(1);box-shadow:-5px 2px 0 #cbb4ff,5px -2px 0 #8fe5df;opacity:1}}@keyframes fb-stage-sweep{from{transform:translateX(-100%)}to{transform:translateX(100%)}}@media(prefers-reduced-motion:reduce){.fb-stage-running::before,.fb-stage-running::after{animation:none}}.fb-start-choice{display:grid;grid-template-columns:1.4fr 1fr;gap:8px}.fb-hook-options{display:grid;gap:6px;margin:8px 0}#builderTabPanel .fb-hook-option{text-align:left;white-space:normal;line-height:1.35;padding:8px 10px}#builderTabPanel .fb-hook-option{display:grid;gap:3px}.fb-hook-action{font-size:12px;opacity:.85}#builderTabPanel .fb-hook-option[aria-checked=true]{border-color:#8b6cff;background:rgba(139,108,255,.18);box-shadow:0 0 0 1px #8b6cff inset}.fb-run-estimate{display:block;margin:6px 0}.fb-next-notes,.fb-say textarea{width:100%;box-sizing:border-box;margin:8px 0;resize:vertical}.fb-season-size-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:6px 0 0;font-size:12px}.fb-season-size{min-width:120px}.fb-say{margin:6px 0}.fb-say summary{cursor:pointer;font-size:12px}#builderTabPanel .fb-start-choice button{min-height:44px;transition:filter .15s,box-shadow .15s,transform .15s,background .15s}#builderTabPanel .fb-start-choice button.fb-primary{border:0;background:linear-gradient(110deg,#c0a1ff,#8ce3dc);color:#181020;font-weight:750}#builderTabPanel .fb-start-choice button.fb-primary:hover:not(:disabled){background:linear-gradient(110deg,#c0a1ff,#8ce3dc);filter:brightness(1.08) saturate(1.08);box-shadow:0 6px 20px #a98bff3d;transform:translateY(-1px)}#builderTabPanel .fb-start-choice button:not(.fb-primary):hover:not(:disabled){background:#2f2642;border-color:#9b82c4}#builderTabPanel .fb-start-choice button:disabled{opacity:.45;cursor:not-allowed;transform:none;box-shadow:none}#builderTabPanel label.fb-auto-row{display:flex;align-items:center;gap:9px;margin:2px 0 0;font-size:12px;color:#cfc4e4;cursor:pointer}#builderTabPanel label.fb-auto-row input{margin:0;flex:none}.fb-next-stage{font-size:12px;color:#c9bce6}.fb-sheet-choice{display:grid;gap:5px;margin:2px 0 4px}.fb-sheet-choice .fb-sheet-label{font-size:11px;color:#a99cc4;letter-spacing:.3px}#builderTabPanel .fb-pro-chip{display:inline-block;min-height:0;margin-left:6px;padding:1px 6px;border:1px solid #c9a24a;border-radius:999px;background:linear-gradient(135deg,#f6d36555,#c9a24a33);color:#f6d365;font-size:9px;font-weight:800;letter-spacing:.8px;line-height:1.5;vertical-align:1px;cursor:pointer}.fb-sheet-choice select{width:100%;min-height:34px;border-radius:9px;background:#1b1527;color:#e6dcf7;border:1px solid #4a3d63;padding:0 8px;font-size:12px}.fb-sheet-choice select:disabled{opacity:.6}.fb-sheet-choice small{font-size:10.5px;color:#9a8fb3}.fb-factory-form{display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;margin:6px 0}.fb-factory-form>*:not(.fb-factory-field),.fb-factory-form>.fb-factory-field:has(textarea){grid-column:1/-1}.fb-factory-field select{min-height:0!important;height:32px;padding:4px 8px!important}.fb-factory-field>span{font-size:11px}.fb-factory-field[hidden]{display:none!important}.fb-factory-field{display:grid;gap:4px;font-size:12px;color:#c9bce6}.fb-factory-field select,.fb-factory-field textarea{width:100%;box-sizing:border-box;border-radius:9px;background:#1b1527;color:#e6dcf7;border:1px solid #4a3d63;padding:6px 8px;font-size:12px}.fb-factory-check{display:flex;gap:8px;align-items:center;font-size:12px;color:#c9bce6}.fb-factory-check{min-height:22px}.fb-factory-check label{margin:0!important;padding:0!important;display:inline-block!important;line-height:20px!important;align-self:center}.fb-factory-sep{border:0;height:1px;margin:2px 0;width:100%;background:linear-gradient(90deg,transparent,#00e5ff55,#ff2bd655,transparent)}.fb-factory-accounts{display:grid;gap:7px;margin:0;padding:9px 10px;border:1px solid #00e5ff40;border-radius:8px;background:linear-gradient(135deg,#0a0714 0%,#140b26 100%);box-shadow:inset 0 0 14px #00e5ff14,0 0 10px #ff2bd60f}.fb-factory-accounts[hidden]{display:none!important}.fb-acc-head{font:600 10px/1 ui-monospace,Consolas,monospace;letter-spacing:.14em;color:#00e5ff;text-shadow:0 0 6px #00e5ff88}.fb-acc-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:5px}.fb-acc-grid input.fb-acc-input[type=checkbox]{position:absolute!important;opacity:0!important;width:1px!important;height:1px!important;min-height:0!important;pointer-events:none}.fb-acc-chip{display:block!important;margin:0!important;padding:6px 0!important;text-align:center;border:1px solid #3b2f57;border-radius:6px;font:600 11px/1 ui-monospace,Consolas,monospace!important;letter-spacing:.06em;color:#8f82b3!important;background:#120c1f;cursor:pointer;transition:border-color .15s,box-shadow .15s,color .15s}.fb-acc-chip:hover{border-color:#6c58a0;color:#cbbdf0!important}.fb-acc-input:checked+.fb-acc-chip{border-color:#00e5ff;color:#eafdff!important;background:#00e5ff14;box-shadow:0 0 8px #00e5ff66,inset 0 0 6px #00e5ff33}.fb-acc-input:focus-visible+.fb-acc-chip{outline:2px solid #ff2bd6;outline-offset:2px}.fb-acc-note{font-size:10.5px!important;line-height:1.35;color:#8a7dab}.fb-factory-paid{border-top:1px dashed #ff2bd640;padding-top:7px}@media(prefers-reduced-motion:reduce){.fb-acc-chip{transition:none}}.fb-factory-list{display:grid;gap:6px;margin:8px 0}.fb-factory-row{display:grid;grid-template-columns:1fr auto;gap:2px 8px;align-items:center;padding:8px 10px;border:1px solid #3a2f52;border-radius:10px;background:#18132400}.fb-factory-row strong{font-size:12.5px;overflow-wrap:anywhere}.fb-factory-row small{grid-column:1;font-size:11px;color:#a79fbb}.fb-factory-row button{grid-row:1/span 2;grid-column:2;font-size:11px;padding:4px 10px}.fb-factory-done{border-color:#2f6b55}.fb-factory-skipped,.fb-factory-paused{border-color:#6b5a2f}.fb-auto{display:grid;gap:5px;padding:8px 10px;border:1px solid #3a3150;border-radius:10px;background:#ffffff06}.fb-auto-row{display:flex;align-items:center;gap:8px;font-size:11px;color:#d9cfee;cursor:pointer}.fb-auto-row input{accent-color:#9ee8e1;margin:0}.fb-auto-wait{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;color:#9ff0e8}.fb-continuation .fb-auto-wait button{padding:3px 10px;font-size:11px}.fb-auto-note{color:#ffcf97;font-size:11px}
`;document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent=`#builderTabPanel .fb-project-meta{display:flex;gap:7px;align-items:center;flex-wrap:wrap;font-size:10px}#builderTabPanel .fb-project-completed{color:#8be3bf;background:#18352c;border:1px solid #2f5c48;border-radius:5px;padding:1px 6px;font-size:9px;font-weight:650}#builderTabPanel .fb-project-state{font-size:10px;color:#ab9fbc}`;document.head.append(style);})();


// Builder heading matches the compact Duration & reference cards bar.
(()=>{const style=document.createElement('style');style.textContent=`
#builderTabPanel>.fb-builder-head{display:flex;flex-wrap:nowrap;align-items:center;gap:10px;padding:12px;border:1px solid #725b92;border-radius:12px;background:linear-gradient(110deg,#402d60,#294e5b 60%,#252133);min-height:58px;box-shadow:inset 0 1px 0 #ffffff05}#builderTabPanel>.fb-builder-head h2{font:750 14px/1.3 system-ui,sans-serif;letter-spacing:-.2px;background:none;color:#f1eaff;text-shadow:none;margin:0;flex:0 1 auto;min-width:0}#builderTabPanel .fb-builder-mark{display:grid;place-items:center;flex:none;width:30px;height:30px;border-radius:50%;background:#8e72cf35;color:#c5b5ff;font-size:19px}#builderTabPanel .fb-builder-count{flex:none;border:1px solid #a2a5cf55;background:#c0c8e21b;color:#dce7f6;border-radius:20px;padding:3px 9px;font-size:10px;font-weight:650;white-space:nowrap}#builderTabPanel>.fb-builder-head>button{margin-left:auto;border:0;background:none;padding:4px;font-size:10px;min-height:25px;white-space:nowrap;color:#e0d9f3}#builderTabPanel>.fb-builder-head>button:hover{background:#b69be518}#builderTabPanel .fb-body{margin-top:10px}@media(max-width:380px){#builderTabPanel>.fb-builder-head{gap:6px;padding:9px}#builderTabPanel>.fb-builder-head h2{font-size:13px}#builderTabPanel .fb-builder-count{font-size:9px;padding:2px 6px}#builderTabPanel .fb-builder-mark{width:25px;height:25px;font-size:17px}}
`;document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent=`
#builderTabPanel .fb-card{width:100%;max-width:none;box-sizing:border-box;justify-self:stretch}#builderTabPanel .fb-complete-panel{display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box;border:1px solid #345b4b;border-left:3px solid #71d3a5;border-radius:11px;background:#14251f;padding:14px}#builderTabPanel .fb-complete-icon{display:grid;place-items:center;flex:none;width:32px;height:32px;border-radius:50%;background:#244d3b;color:#9ce7bb;font-size:19px}#builderTabPanel .fb-complete-copy{display:grid;gap:3px;flex:1;min-width:0}#builderTabPanel .fb-complete-copy strong{font-size:13px;color:#c0f0cf}#builderTabPanel .fb-complete-copy small{font-size:10px;color:#96b6a4}#builderTabPanel .fb-complete-panel button{font-size:10px;padding:6px 9px;background:#1a3227;border-color:#3f6a53;color:#bce1c9;white-space:nowrap}#builderTabPanel .fb-follow-up{display:grid;gap:3px;padding:3px 0}#builderTabPanel .fb-follow-up small{font-size:11px;margin:0}#builderTabPanel .fb-follow-up.fb-card{padding:14px 16px;gap:10px}#builderTabPanel .fb-follow-up.fb-card>p{margin:0;line-height:1.45}#builderTabPanel .fb-follow-up.fb-card>strong{font-size:14px}#builderTabPanel .fb-follow-up.fb-card .fb-next-notes{margin:0;min-height:58px;padding:8px 10px;border-radius:8px;font-size:12px}#builderTabPanel .fb-follow-up.fb-card>small{text-align:center}#builderTabPanel .fb-season-size-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:2px 0}#builderTabPanel .fb-season-size-row span{font-size:12px;font-weight:600}#builderTabPanel .fb-season-size{width:auto;min-width:120px;height:32px;min-height:0;padding:4px 10px;margin:0;font-size:12px;border-radius:8px}#builderTabPanel .fb-part-tabs button{padding:5px 10px;font-size:11px;min-height:27px;border-radius:7px}#builderTabPanel .fb-part-tabs button.fb-primary{background:#332842;color:#dfcef7;border:1px solid #806598;box-shadow:none}#builderTabPanel .fb-niche-tag{display:inline-flex;align-items:center;gap:7px;max-width:100%;margin:2px 0 6px;padding:4px 10px 4px 4px;border:1px solid #806598;border-radius:999px;background:#241c33;color:#e6dbf5;font-size:11.5px;line-height:1.3;overflow-wrap:anywhere}#builderTabPanel .fb-niche-tag .fb-niche-label{padding:2px 7px;border-radius:999px;background:#3b2d55;color:#c9b3f2;font-size:9.5px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;flex-shrink:0}#builderTabPanel .fb-standalone-tag{display:inline-flex;align-items:center;padding:5px 10px;font-size:11px;font-weight:600;min-height:27px;box-sizing:border-box;border-radius:7px;background:#332842;color:#dfcef7;border:1px solid #806598}#builderTabPanel .fb-body>h3{margin-bottom:0;font-size:16px}#builderTabPanel .fb-body>.fb-muted{margin-top:0}#builderTabPanel .fb-body>.fb-actions button{font-size:11px;padding:7px 10px}@media(max-width:380px){#builderTabPanel .fb-complete-panel{gap:8px;padding:10px}#builderTabPanel .fb-complete-panel button{font-size:9px;padding:5px}#builderTabPanel .fb-complete-icon{width:26px;height:26px}}
`;document.head.append(style);})();

// Movie-studio identity and consistent local typography (no external font requests).
(()=>{const style=document.createElement('style');style.textContent=`
#builderTabPanel{font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;font-size:12px;line-height:1.5;font-weight:400}
#builderTabPanel button,#builderTabPanel input,#builderTabPanel select,#builderTabPanel textarea{font-family:inherit}
#builderTabPanel>.fb-builder-head h2{font-family:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;font-size:15px;font-weight:700;letter-spacing:-.35px;line-height:1.25}
#builderTabPanel .fb-builder-mark{width:32px;height:32px;border-radius:9px;background:linear-gradient(145deg,#bca1ff26,#80e6df14);border:1px solid #c8b3ff40;color:#e1d5ff;box-shadow:inset 0 1px 0 #ffffff12}
#builderTabPanel .fb-builder-mark svg{display:block;width:21px;height:21px}
#builderTabPanel .fb-body>h3{font-family:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;font-weight:650;letter-spacing:-.25px;line-height:1.4}
#builderTabPanel .fb-template strong,#builderTabPanel .fb-project-info strong{font-weight:600;letter-spacing:-.1px}
#builderTabPanel .fb-builder-count{font-weight:600;font-variant-numeric:tabular-nums}
@media(max-width:380px){#builderTabPanel>.fb-builder-head h2{font-size:13px}#builderTabPanel .fb-builder-mark{width:27px;height:27px}#builderTabPanel .fb-builder-mark svg{width:18px;height:18px}}
`;document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent='#builderTabPanel .fb-story-type{display:grid;gap:7px;padding:10px;border:1px solid #514364;border-radius:10px;background:#1c1728}#builderTabPanel .fb-story-type button{font-size:11px;padding:7px 10px}#builderTabPanel .fb-story-type button[aria-pressed=true]{border-color:#bba0f1;background:#3a2c51;color:#f1e6ff}#builderTabPanel .fb-pro-tag{margin-left:6px;padding:1px 5px;border-radius:5px;background:linear-gradient(90deg,#b49cff,#7ee6ef);color:#120d27;font-size:8.5px;font-weight:800;letter-spacing:.5px;vertical-align:1px}';document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent='#builderTabPanel button.fb-project-delete{width:28px;min-height:28px;padding:3px;font-size:17px;background:transparent;border-color:transparent;color:#ef7e91;display:grid;place-items:center}#builderTabPanel button.fb-project-delete:hover{background:#462330;border-color:#99546c;color:#ffb6c8}';document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent='#builderTabPanel .fb-platform-panel{display:grid;gap:14px;padding:12px;border:1px solid #493d5c;border-radius:11px;background:#181421}#builderTabPanel .fb-platform-row{display:grid;grid-template-columns:44px minmax(0,1fr);align-items:center;gap:8px}#builderTabPanel .fb-platform-row>strong{font-size:11px;font-weight:600}#builderTabPanel .fb-platform-options{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}#builderTabPanel .fb-platform-options button{display:flex;justify-content:center;align-items:center;gap:5px;min-width:0;padding:8px 3px;font-size:11px;border-radius:8px;background:#211b2d;border-color:#43364f}#builderTabPanel .fb-platform-options button img{width:15px;height:15px;object-fit:contain}#builderTabPanel .fb-platform-options button[data-workflow]{text-align:center;line-height:1.25}#builderTabPanel .fb-platform-options button[data-workflow]:disabled{opacity:.4;cursor:not-allowed}#builderTabPanel .fb-workflow-note{margin-top:-8px;font-size:10.5px}#builderTabPanel .fb-platform-options button[aria-pressed=true]{border-color:#b89ae9;color:#f3eaff;background:#3c2e52;box-shadow:inset 0 0 0 1px #b89ae925}#builderTabPanel .fb-platform-panel label{margin:0;gap:5px}#builderTabPanel .fb-platform-panel label[hidden]{display:none}#builderTabPanel .fb-platform-panel select{padding:8px;font-size:11px}@media(max-width:350px){#builderTabPanel .fb-platform-row{grid-template-columns:1fr;gap:5px}}#builderTabPanel .fb-quick-platforms{display:grid;gap:14px;margin:12px 0 8px;padding:14px;border:1px solid #ffffff12;border-radius:12px;background:#ffffff03}#builderTabPanel .fb-quick-row{display:grid;grid-template-columns:minmax(0,1fr);gap:7px;min-width:0}#builderTabPanel .fb-quick-label{font-size:12px;font-weight:600;line-height:1.4;color:#c9bfdc}#builderTabPanel .fb-quick-pills{display:flex;flex-wrap:wrap;align-items:stretch;gap:6px;min-width:0}#builderTabPanel .fb-quick-pills button{display:inline-flex;flex:1 1 76px;justify-content:center;align-items:center;gap:5px;padding:7px 8px;font-size:12px;line-height:18px;min-height:36px;border-radius:9px;background:#211b2d;border-color:#43364f;white-space:normal}#builderTabPanel .fb-quick-pills button span,#builderTabPanel .fb-platform-options button span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#builderTabPanel .fb-quick-pills button img{width:13px;height:13px;object-fit:contain}#builderTabPanel .fb-quick-pills button[aria-pressed=true]{border-color:#b89ae9;color:#f3eaff;background:#3c2e52}#builderTabPanel .fb-wide .fb-visual img{aspect-ratio:16/9}#builderTabPanel .fb-quick-pills select[hidden]{display:none}#builderTabPanel .fb-quick-pills select{flex:1 1 100%;width:100%;min-width:0;max-width:100%;min-height:38px;margin:2px 0 0;padding:7px 10px;font-size:12px;border-radius:9px}#builderTabPanel .fb-quick-pills button:focus-visible{outline:2px solid #a4e3df;outline-offset:2px}#builderTabPanel .fb-quick-pills button:disabled{opacity:.5;cursor:not-allowed}@media(max-width:480px){#builderTabPanel .fb-quick-pills button[data-key="imagePlatform"]{flex-basis:calc(50% - 6px)}}';document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent='#builderTabPanel .fb-package-ready{display:flex;align-items:center;gap:10px;padding:12px;border:1px solid #514638;border-left:3px solid #d8af6c;border-radius:9px;background:#211d19;box-shadow:none}#builderTabPanel .fb-package-icon{display:grid;place-items:center;flex:none;width:32px;height:32px;border-radius:8px;background:#382e20;color:#e4c28b}#builderTabPanel .fb-package-copy{display:grid;gap:3px;min-width:0;flex:1}#builderTabPanel .fb-package-copy strong{font-size:12px;font-weight:650;color:#f0dfc4}#builderTabPanel .fb-package-copy small{font-size:10px;line-height:1.5;color:#b8aa96}#builderTabPanel .fb-package-badge{font-size:8px;font-weight:650;letter-spacing:.8px;padding:3px 6px;border:1px solid #6a5536;border-radius:5px;color:#e0bd83;background:#30271c;flex:none}@media(max-width:350px){#builderTabPanel .fb-package-ready{gap:7px;padding:9px}#builderTabPanel .fb-package-badge{font-size:7px;padding:3px 4px}}';document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent='.fb-ugc-sec{display:grid;gap:10px;margin:0;padding:12px;border:1px solid #2e2742;border-radius:14px;background:#15121f}.fb-ugc-sec>h4{margin:0;font:700 11.5px/1.2 system-ui,sans-serif;letter-spacing:.07em;text-transform:uppercase;color:#b79aff}.fb-ugc-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 10px}.fb-ugc-sec label:not(.fb-upload){display:grid;gap:4px;margin:0;font-size:12px;color:#c9bedb}.fb-ugc-sec label:not(.fb-upload)>select,.fb-ugc-sec label:not(.fb-upload)>input,.fb-ugc-sec label:not(.fb-upload)>textarea{width:100%;box-sizing:border-box;margin:0}.fb-ugc-more>summary{cursor:pointer;font:700 11.5px/1.2 system-ui,sans-serif;letter-spacing:.07em;text-transform:uppercase;color:#b79aff}.fb-ugc-more:not([open]){padding:10px 12px}.fb-ugc-actions{display:flex;flex-wrap:wrap;gap:8px}.fb-ugc-actions>button:last-child{flex:1 1 100%;order:-1}@media (max-width:420px){.fb-ugc-grid{grid-template-columns:1fr}}.fb-upload{position:relative;display:flex;align-items:center;gap:14px;padding:14px;border:1.5px dashed #6d5a8c;border-radius:14px;background:linear-gradient(135deg,#1c1730,#16131f);cursor:pointer;transition:border-color .15s,background .15s}.fb-upload:hover,.fb-upload.drag{border-color:#b79aff;background:linear-gradient(135deg,#251d3d,#1a1626)}.fb-upload.has-image{border-style:solid;border-color:#5b4a78}.fb-upload input[type=file]{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}.fb-upload-thumb{flex:none;display:grid;place-items:center;width:84px;height:84px;border-radius:11px;background:#251f36;border:1px solid #3c3253;color:#b79aff;font-size:30px;overflow:hidden}.fb-upload-thumb img{width:100%;height:100%;object-fit:contain;background:#fff}.fb-upload-info{display:grid;gap:4px;min-width:0}.fb-upload-info strong{font-size:13.5px;color:#eee4ff}.fb-upload-info small{color:#a99cbd;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fb-upload-action{justify-self:start;margin-top:4px;padding:4px 12px;border-radius:999px;background:#3a2c58;color:#e6dbf5;font-size:12px;font-weight:600}.fb-upload:hover .fb-upload-action{background:#4a3870}.fb-redo-bar{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 10px}#builderTabPanel button.fb-redo-pill{display:inline-flex;align-items:center;gap:7px;width:auto;max-width:100%;min-height:0;margin:0;padding:4px 10px 4px 4px;border:1px solid #806598;border-radius:999px;background:#241c33;color:#e6dbf5;font-family:inherit;font-size:11.5px;font-weight:400;line-height:1.3;box-shadow:none;cursor:pointer;text-align:left}#builderTabPanel button.fb-redo-pill:hover:not(:disabled){border-color:#b294cf;background:#2c2240}#builderTabPanel button.fb-redo-pill:disabled{opacity:.45;cursor:default}';document.head.append(style);})();
(()=>{const style=document.createElement('style');style.textContent='#builderTabPanel button.fb-regenerate{width:100%;padding:7px 5px;min-height:29px;font-size:10px;font-weight:600;color:#ccebe6;background:#192b2e;border-color:#35585d;border-radius:8px}#builderTabPanel button.fb-regenerate:hover{background:#223b40;border-color:#72bfb6}#builderTabPanel button.fb-regenerate:disabled{opacity:.45;cursor:default}#builderTabPanel .fb-stale-image{font-size:9px;color:#e8bd80;line-height:1.4}';document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent='.fb-limit-dialog{box-sizing:border-box;width:min(360px,calc(100vw - 32px));padding:18px;border:1px solid #62506f;border-radius:15px;background:#191421;color:#eee7f5;box-shadow:0 20px 65px #0009;font:12px/1.6 "Segoe UI",system-ui,sans-serif}.fb-limit-dialog::backdrop{background:#080610b8;backdrop-filter:blur(4px)}.fb-limit-head{display:flex;gap:10px;align-items:center}.fb-limit-icon{display:grid;place-items:center;flex:none;width:33px;height:33px;background:#45321e;border:1px solid #88643c;border-radius:10px;color:#f0c780;font-size:21px;font-weight:650}.fb-limit-head>div{flex:1;min-width:0}.fb-limit-head h3{font-size:14px;line-height:1.4;margin:0;font-weight:650}.fb-limit-head small{font-size:10px;color:#b5a8c2}.fb-limit-dialog button{font:inherit;cursor:pointer}.fb-limit-head>button{border:0;background:transparent;color:#b5a8c2;font-size:21px;line-height:1;padding:5px}.fb-limit-dialog>p{margin:16px 0 12px;color:#c5bace;font-size:12px}.fb-limit-saved{border:1px solid #345346;background:#1b2c25;color:#a9d7bc;border-radius:8px;padding:9px 10px;font-size:11px}.fb-limit-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.fb-limit-actions button.fb-limit-upgrade{border:0;color:#181020;background:linear-gradient(110deg,#c0a1ff,#8ce3dc);font-weight:800;box-shadow:0 3px 14px #b798ff44}.fb-limit-actions button{border:1px solid #967bb5;border-radius:8px;background:#49355f;color:#f5edff;padding:7px 20px;font-size:11px;font-weight:600}.fb-limit-dialog button:focus-visible{outline:2px solid #c9a5f4;outline-offset:3px}';document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent='.fb-writing-row{display:flex;align-items:center;gap:10px}.fb-writing-pencil{display:grid;place-items:center;flex:none;width:32px;height:32px;border-radius:9px;border:1px solid #8065a3;background:#322541;color:#dac0ff;font-size:23px}.fb-writing-pencil.is-writing{animation:fb-pencil-write 1.2s ease-in-out infinite}.fb-writing-copy{display:grid;gap:3px;min-width:0;flex:1}.fb-writing-copy strong{font-size:12px;color:#e6d8ff}.fb-writing-copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}.fb-writing-track{height:4px;border-radius:8px;overflow:hidden;background:#100e1b;margin:3px 0}.fb-writing-track>div{height:100%;background:#b798ed;border-radius:inherit;transition:width 3s linear}.fb-continuation:has(.fb-writing-row){background:#1b1627;border-color:#574367;padding:12px;gap:8px}@keyframes fb-pencil-write{0%,100%{transform:rotate(-10deg) translateX(-1px)}50%{transform:rotate(8deg) translateX(2px)}}@media(prefers-reduced-motion:reduce){.fb-writing-pencil.is-writing{animation:none}.fb-writing-track>div{transition:none}}';document.head.append(style);})();

// Smaller Builder title bar.
(()=>{const style=document.createElement('style');style.textContent=`#builderTabPanel>.fb-builder-head{min-height:42px;padding:7px 10px;gap:8px;border-radius:10px;box-sizing:border-box}#builderTabPanel>.fb-builder-head h2{font-size:13px;letter-spacing:-.2px}#builderTabPanel .fb-builder-mark{width:25px;height:25px;border-radius:7px;box-sizing:border-box}#builderTabPanel .fb-builder-mark svg{width:17px;height:17px}#builderTabPanel .fb-builder-count{font-size:9px;padding:2px 7px;line-height:1.4}#builderTabPanel>.fb-builder-head>button{font-size:9px;min-height:23px;padding:3px}@media(max-width:380px){#builderTabPanel>.fb-builder-head{padding:6px 8px;gap:6px;min-height:39px}#builderTabPanel>.fb-builder-head h2{font-size:12px}#builderTabPanel .fb-builder-mark{width:23px;height:23px}}`;document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent='#builderTabPanel .fb-library-controls[hidden]{display:none}#builderTabPanel button.fb-advance-card{display:block;width:100%;padding:0;overflow:hidden;text-align:left;border:1px solid #78608f;border-radius:12px;background:#21182e;transition:border-color .18s,transform .18s}#builderTabPanel button.fb-advance-card:hover{border-color:#c5a0ec;transform:translateY(-2px)}#builderTabPanel .fb-advance-cover{position:relative;height:155px;background:#17101f;overflow:hidden}#builderTabPanel .fb-advance-cover img{display:block;width:100%;height:100%;object-fit:cover;object-position:center 40%}#builderTabPanel .fb-advance-cover::after{content:"";position:absolute;inset:0;background:linear-gradient(0deg,#21182ee8,transparent 70%);pointer-events:none}#builderTabPanel .fb-advance-badge{position:absolute;top:10px;left:10px;z-index:1;padding:4px 7px;border:1px solid #c9abeb66;border-radius:5px;background:#2d1b40e8;color:#efd6ff;font-size:9px;letter-spacing:.8px;font-weight:600}#builderTabPanel .fb-advance-external{position:absolute;right:10px;top:10px;background:#21152edd;border-radius:7px;padding:3px 8px;font-size:16px}#builderTabPanel .fb-advance-copy{display:grid;gap:6px;padding:12px 14px}#builderTabPanel .fb-advance-copy strong{font-size:15px;letter-spacing:-.2px;color:#f0e3fd}#builderTabPanel .fb-advance-copy small{font-size:11px;color:#bfaacc}#builderTabPanel .fb-advance-cta{justify-self:start;margin-top:3px;font-size:11px;color:#a8e5d8;font-weight:600}@media(prefers-reduced-motion:reduce){#builderTabPanel button.fb-advance-card{transition:none}#builderTabPanel button.fb-advance-card:hover{transform:none}}';document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent='#builderTabPanel .fb-library-tabs{align-items:flex-end}#builderTabPanel .fb-library-tabs button.fb-advance-tab{position:relative}#builderTabPanel .fb-advance-tab>svg{position:absolute;top:-7px;left:50%;transform:translateX(-50%);color:#edc66e;filter:drop-shadow(0 0 4px #edc66e40)}#builderTabPanel .fb-advance-premium{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;background:#160c2799;backdrop-filter:blur(2px);color:#ffe2a1;font-size:18px;font-weight:650;letter-spacing:.5px;opacity:0;transition:opacity .18s;pointer-events:none}#builderTabPanel .fb-advance-card:hover .fb-advance-premium,#builderTabPanel .fb-advance-card:focus-visible .fb-advance-premium{opacity:1}@media(prefers-reduced-motion:reduce){#builderTabPanel .fb-advance-premium{transition:none}}';document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent='#builderTabPanel .fb-library-tabs button.fb-advance-tab{display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:6px 9px}#builderTabPanel .fb-advance-tab>svg{position:static;transform:none;flex:none;width:12px;height:12px;color:#edc66e;filter:none}#builderTabPanel .fb-advance-premium{font-size:16px;letter-spacing:.2px}';document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent='#builderTabPanel button.fb-advance-card{border-color:#86643e;background:#251c20}#builderTabPanel button.fb-advance-card:hover{border-color:#e5b969}#builderTabPanel .fb-advance-cover img{filter:brightness(.72) saturate(.8);transition:transform .3s,filter .3s}#builderTabPanel .fb-advance-cover::after{background:linear-gradient(0deg,#251c20e8,transparent 80%)}#builderTabPanel .fb-advance-lock{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2;display:grid;place-items:center;width:43px;height:43px;border:1px solid #f0c87c77;border-radius:12px;background:#291c19d9;color:#f2ce8d;box-shadow:0 3px 18px #0006;transition:transform .2s,opacity .2s}#builderTabPanel .fb-advance-lock svg{width:23px;height:23px}#builderTabPanel .fb-advance-premium{background:#25131899;backdrop-filter:blur(2px);padding-top:52px}#builderTabPanel .fb-premium-pill{display:inline-flex;align-items:center;padding:9px 16px;border:1px solid #ffdd9a;border-radius:8px;background:linear-gradient(120deg,#f5d38f,#cd9848);color:#382010;font-size:12px;font-weight:700;letter-spacing:0;box-shadow:0 4px 18px #0005;transform:translateY(7px);transition:transform .2s}#builderTabPanel .fb-advance-card:hover .fb-premium-pill,#builderTabPanel .fb-advance-card:focus-visible .fb-premium-pill{transform:none}#builderTabPanel .fb-advance-card:hover .fb-advance-lock,#builderTabPanel .fb-advance-card:focus-visible .fb-advance-lock{transform:translate(-50%,-100%)}#builderTabPanel .fb-advance-card:hover .fb-advance-cover img{transform:scale(1.03)}#builderTabPanel .fb-advance-badge{background:#3e2422e8;border-color:#c8a26b66;color:#f2d7a3}#builderTabPanel .fb-advance-cta{color:#e6bf80}@media(prefers-reduced-motion:reduce){#builderTabPanel .fb-advance-cover img,#builderTabPanel .fb-advance-lock,#builderTabPanel .fb-premium-pill{transition:none}}';document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent='#builderTabPanel .fb-visual img{aspect-ratio:9/16;max-height:280px;object-fit:contain}#builderTabPanel .fb-body{overflow-anchor:none}';document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent='.fb-template-category{position:static;display:block;width:fit-content;justify-self:start;background:#2d213a;color:#cbb9df;border:1px solid #63497555;border-radius:4px;padding:2px 6px;font-size:9px;font-weight:600;line-height:1.3;margin-top:2px}.fb-template-badges{position:absolute;top:8px;left:8px;right:8px;display:flex;flex-wrap:wrap;gap:4px;pointer-events:none}.fb-card-badge{padding:3px 6px;border-radius:5px;font-size:9px;font-weight:800;letter-spacing:.4px;line-height:1.2;box-shadow:0 2px 8px #0005}.fb-badge-featured{background:#aa8ae8;color:#190e2b}.fb-badge-new{background:#4ee6a3;color:#06261a}.fb-badge-popular{background:#e52b65;color:#fff}.fb-badge-trending{background:#e8b64c;color:#251707}.fb-template-usage{display:block;color:#b8aec9;font-size:10px;border-top:1px solid #ffffff12;padding-top:7px;margin-top:2px}';document.head.append(style);})();

(()=>{const style=document.createElement('style');style.textContent='#builderTabPanel .fb-template-discovery{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px;width:100%}#builderTabPanel .fb-template-discovery button{width:100%;min-width:0;box-sizing:border-box;min-height:30px;padding:4px 3px;border:1px solid var(--filter-border,#554069);border-radius:7px;background:var(--filter-bg,#291f38);color:var(--filter-text,#dac8f3);font:600 10px/1.25 system-ui;white-space:normal;--filter-accent:#b99af5}#builderTabPanel .fb-template-discovery button[data-discovery=stories]{--filter-bg:#342135;--filter-border:#674068;--filter-text:#efb4de;--filter-accent:#eda1d3}#builderTabPanel .fb-template-discovery button[data-discovery=products]{--filter-bg:#352b18;--filter-border:#68532b;--filter-text:#f3cf80;--filter-accent:#e8bf78}#builderTabPanel .fb-template-discovery button[data-discovery=explainers]{--filter-bg:#153330;--filter-border:#315e58;--filter-text:#9be8dc;--filter-accent:#8ee5df}#builderTabPanel .fb-template-discovery button[data-discovery=creative]{--filter-bg:#1d2d42;--filter-border:#37577d;--filter-text:#abcfff;--filter-accent:#8bbcff}#builderTabPanel .fb-template-discovery button[data-discovery=hosts]{--filter-bg:#38241f;--filter-border:#71483c;--filter-text:#f4bba3;--filter-accent:#eead8b}#builderTabPanel .fb-template-discovery button[aria-pressed=true]{border-color:var(--filter-accent);box-shadow:inset 0 0 0 1px var(--filter-accent);color:#fff;background:var(--filter-bg,#291f38)}#builderTabPanel .fb-template-discovery button:focus-visible{outline:2px solid #8ee5df;outline-offset:2px}#builderTabPanel .fb-template-discovery[hidden],#builderTabPanel .fb-library-controls input[hidden],#builderTabPanel .fb-library-controls [hidden]{display:none}#builderTabPanel .fb-browse-heading{font-size:12px;color:#e5daf4}#builderTabPanel .fb-filter-reset{justify-self:end;width:auto;min-height:24px;padding:3px 7px;font-size:10px;background:transparent;border-color:#4b3d60}#builderTabPanel .fb-template-secondary{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}#builderTabPanel .fb-new-filter{display:inline-flex;align-items:center;gap:8px;white-space:nowrap;font:500 11px/1.3 system-ui;color:#b5e3da;min-height:30px;padding:4px 2px;background:transparent;border:0;border-radius:5px;box-shadow:none}#builderTabPanel .fb-switch-track{display:block;position:relative;width:30px;height:18px;box-sizing:border-box;border-radius:99px;border:1px solid #78648d;background:#40364d;flex-shrink:0;transition:background .15s,border-color .15s}#builderTabPanel .fb-switch-thumb{position:absolute;left:2px;top:2px;width:12px;height:12px;border-radius:50%;background:#d6c8e6;transition:transform .15s}#builderTabPanel .fb-new-filter[aria-checked=true] .fb-switch-track{background:#83e4d6;border-color:#83e4d6}#builderTabPanel .fb-new-filter[aria-checked=true] .fb-switch-thumb{background:#163d37;transform:translateX(12px)}#builderTabPanel .fb-new-filter:focus-visible{outline:2px solid #8ee5df;outline-offset:2px}';document.head.append(style);})();
// Library tabs stay on one row; a narrow side panel gets tighter tabs instead of pushing Advance to a second line (owner 2026-10-30).
(()=>{const style=document.createElement('style');style.textContent='#builderTabPanel .fb-library-tabs{flex-wrap:nowrap;gap:3px;overflow-x:auto;scrollbar-width:none}#builderTabPanel .fb-library-tabs::-webkit-scrollbar{display:none}#builderTabPanel .fb-library-tabs button,#builderTabPanel .fb-library-tabs button.fb-advance-tab{flex:0 0 auto;white-space:nowrap}@media (max-width:540px){#builderTabPanel .fb-library-tabs{gap:1px}#builderTabPanel .fb-library-tabs button,#builderTabPanel .fb-library-tabs button.fb-advance-tab{padding:6px 6px}#builderTabPanel .fb-advance-tab>svg{width:11px;height:11px}}';document.head.append(style);})();
// Video → Story look (owner 2026-11-04).
(()=>{const style=document.createElement('style');style.textContent=`
#builderTabPanel .fb-vr{--vr-a:#c4b5fd;--vr-b:#5eead4;--vr-c:#f472b6;display:grid;gap:14px}
#builderTabPanel .fb-vr-model{display:grid;grid-template-columns:auto 1fr;align-items:center;gap:6px 10px;padding:10px 12px;border-radius:12px;border:1px solid #ffffff17;background:linear-gradient(180deg,#221f31,#17151f)}
#builderTabPanel .fb-vr-model[hidden]{display:none}
#builderTabPanel .fb-vr-model strong{font-size:12px;color:#e9e4f6}
#builderTabPanel .fb-vr-model select{min-width:0;width:100%}
#builderTabPanel .fb-vr-model-note{grid-column:1/-1;color:#b9b1cc;font-size:11px}
#builderTabPanel .fb-vr-hero{position:relative;display:flex;gap:16px;align-items:center;padding:18px;border-radius:18px;overflow:hidden;border:1px solid #6d5a92;background:radial-gradient(120% 140% at 0% 0%,#3b2a63 0%,#1a1530 45%,#0f1a24 100%);box-shadow:0 10px 40px #0008,inset 0 1px 0 #ffffff14}
#builderTabPanel .fb-vr-hero::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(0deg,#ffffff06 0 1px,transparent 1px 4px);pointer-events:none}
#builderTabPanel .fb-vr-art{position:relative;flex:none;width:76px;height:76px;filter:drop-shadow(0 0 14px #8b5cf680)}
#builderTabPanel .fb-vr-scan{position:absolute;left:12px;right:12px;top:8px;height:3px;border-radius:3px;background:linear-gradient(90deg,transparent,var(--vr-b),transparent);box-shadow:0 0 12px var(--vr-b);animation:fbvrScan 2.6s ease-in-out infinite}
#builderTabPanel .fb-vr[data-running="1"] .fb-vr-scan{animation-duration:1.1s}
@keyframes fbvrScan{0%,100%{transform:translateY(0);opacity:.2}50%{transform:translateY(58px);opacity:1}}
#builderTabPanel .fb-vr-copy{min-width:0;position:relative;z-index:1}
#builderTabPanel .fb-vr-kicker{display:inline-flex;align-items:center;gap:8px;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--vr-b)}
#builderTabPanel .fb-vr-new{padding:2px 7px;border-radius:999px;font-size:10px;letter-spacing:.08em;color:#1a1030;background:linear-gradient(90deg,var(--vr-a),var(--vr-c));box-shadow:0 0 12px #f472b680}
#builderTabPanel .fb-vr-title{margin:6px 0 6px;font-size:23px;line-height:1.15;font-weight:800;background:linear-gradient(90deg,#fff 0%,var(--vr-a) 45%,var(--vr-b) 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
#builderTabPanel .fb-vr-lead{margin:0;color:#c9c2dc;font-size:13.5px;line-height:1.5}
#builderTabPanel .fb-vr-steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
#builderTabPanel .fb-vr-step{display:grid;gap:3px;padding:10px;border-radius:12px;border:1px solid #3a3150;background:#16131f;transition:border-color .3s,background .3s,box-shadow .3s}
#builderTabPanel .fb-vr-step strong{font-size:13px;color:#eee}#builderTabPanel .fb-vr-step small{font-size:11px;line-height:1.35;color:#9b93b3}
#builderTabPanel .fb-vr-dot{display:grid;place-items:center;width:22px;height:22px;border-radius:50%;font-size:11px;font-weight:800;color:#c4b5fd;border:1px solid #5b4b80;background:#1e1830}
#builderTabPanel .fb-vr-step[data-state="active"]{border-color:var(--vr-b);background:linear-gradient(180deg,#123a3a55,#16131f);box-shadow:0 0 0 1px #5eead433,0 0 18px #5eead433}
#builderTabPanel .fb-vr-step[data-state="active"] .fb-vr-dot{color:#062a25;background:var(--vr-b);border-color:var(--vr-b);animation:fbvrPulse 1.4s ease-in-out infinite}
#builderTabPanel .fb-vr-step[data-state="done"]{border-color:#6d5a92}#builderTabPanel .fb-vr-step[data-state="done"] .fb-vr-dot{color:#1a1030;background:var(--vr-a);border-color:var(--vr-a)}
@keyframes fbvrPulse{0%,100%{box-shadow:0 0 0 0 #5eead499}50%{box-shadow:0 0 0 6px #5eead400}}
#builderTabPanel .fb-vr-drop{position:relative;display:grid;justify-items:center;gap:4px;padding:22px 14px;border-radius:16px;border:1.5px dashed #6d5a92;background:#14111d;text-align:center;cursor:pointer;transition:border-color .2s,background .2s,transform .2s}
#builderTabPanel .fb-vr-drop:hover,#builderTabPanel .fb-vr-drop[data-over="1"]{border-color:var(--vr-b);background:#132027;transform:translateY(-1px)}
#builderTabPanel .fb-vr-drop[data-has="1"]{border-style:solid;border-color:var(--vr-a);background:linear-gradient(180deg,#241b3a,#14111d)}
#builderTabPanel .fb-vr-drop[data-locked="1"]{opacity:.6;cursor:default;pointer-events:none}
#builderTabPanel .fb-vr-drop:focus-within{outline:2px solid var(--vr-b);outline-offset:2px}
#builderTabPanel .fb-vr-input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
#builderTabPanel .fb-vr-drop-icon{display:grid;place-items:center;width:40px;height:40px;border-radius:12px;font-size:18px;color:#1a1030;background:linear-gradient(135deg,var(--vr-a),var(--vr-b));box-shadow:0 6px 18px #5eead433}
#builderTabPanel .fb-vr-drop strong{font-size:14px;color:#f2eefc;word-break:break-all}#builderTabPanel .fb-vr-drop small{font-size:12px;color:#9b93b3}
#builderTabPanel .fb-vr-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
#builderTabPanel .fb-vr-go{flex:1 1 220px;min-height:46px;padding:0 18px;border:0;border-radius:14px;font-size:15px;font-weight:800;color:#120c22;cursor:pointer;background:linear-gradient(90deg,var(--vr-a),var(--vr-b));background-size:200% 100%;box-shadow:0 8px 26px #8b5cf655,0 0 0 1px #ffffff22 inset;transition:transform .15s,box-shadow .2s,background-position .6s}
#builderTabPanel .fb-vr-go:hover:not(:disabled){transform:translateY(-1px);background-position:100% 0;box-shadow:0 10px 32px #5eead455}
#builderTabPanel .fb-vr-go:disabled{opacity:.55;cursor:progress}
#builderTabPanel .fb-vr-ghost{min-height:46px;padding:0 16px;border-radius:14px;border:1px solid #4a3f63;background:#1a1626;color:#ddd5f0;cursor:pointer}
#builderTabPanel .fb-vr-ghost:hover:not(:disabled){border-color:var(--vr-a)}
#builderTabPanel .fb-vr-status{margin:0;min-height:1.3em;font-size:13px;font-weight:600;color:var(--vr-b)}
#builderTabPanel .fb-vr-status:empty{display:none}#builderTabPanel .fb-vr-status[data-tone="error"]{color:#fda4af}
#builderTabPanel .fb-vr-note{margin:0;font-size:11.5px;color:#857d9c;text-align:center}
@media(max-width:520px){#builderTabPanel .fb-vr-hero{flex-direction:column;align-items:flex-start}#builderTabPanel .fb-vr-steps{grid-template-columns:repeat(2,minmax(0,1fr))}#builderTabPanel .fb-vr-title{font-size:20px}}
@media(prefers-reduced-motion:reduce){#builderTabPanel .fb-vr-scan,#builderTabPanel .fb-vr-step[data-state="active"] .fb-vr-dot{animation:none}#builderTabPanel .fb-vr *{transition:none}}
`;document.head.append(style);})();
// Compact AI Story tool menu (owner 2026-11-08 mockup): glass tiles with glowing icons, quiet links row, accent heading.
(()=>{const style=document.createElement('style');style.textContent='#builderTabPanel .fb-library-tabs.fb-compact-nav{display:grid;gap:8px;padding-bottom:10px;overflow:visible;border-bottom:1px solid #ffffff12}#builderTabPanel .fb-tool-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}#builderTabPanel .fb-compact-nav .fb-tool-tile{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:68px;padding:8px 4px 7px;border:1px solid #ffffff17;border-radius:13px;background:linear-gradient(180deg,#221f31,#17151f);color:#e9e4f6;font-size:11.5px;font-weight:600;letter-spacing:.1px;line-height:1.15;text-align:center;white-space:nowrap;box-shadow:inset 0 1px 0 #ffffff0f,0 4px 12px #00000040;transition:border-color .18s,box-shadow .18s,transform .18s}.fb-announcement{--fb-glow:#a274ff;position:relative;display:flex;align-items:center;gap:7px;height:30px;margin:8px 0 0;padding:0 4px 0 10px;box-sizing:border-box;border-radius:99px;border:1px solid #a274ffa6;background:linear-gradient(90deg,#2a1d4df2,#1a1430f2 55%,#2a1d4df2);color:#efe7ff;font-size:12px;line-height:1;overflow:hidden;box-shadow:0 0 0 1px #a274ff26,0 0 12px #8b5cf659,inset 0 0 10px #8b5cf62e;animation:fb-ann-glow 2.8s ease-in-out infinite}.fb-announcement[hidden]{display:none}.fb-announcement[data-style=important]{--fb-glow:#ffb84a;border-color:#ffb84aa6;background:linear-gradient(90deg,#3a2a14f2,#1d1626f2 55%,#3a2a14f2);color:#ffe9c4}.fb-announcement[data-style=promo]{background:linear-gradient(90deg,#3a1d5cf2,#1d1433f2 55%,#2b1d55f2)}@keyframes fb-ann-glow{0%,100%{box-shadow:0 0 0 1px #a274ff26,0 0 10px #8b5cf64d,inset 0 0 8px #8b5cf626}50%{box-shadow:0 0 0 1px #a274ff59,0 0 20px #8b5cf6a6,inset 0 0 14px #8b5cf640}}.fb-announcement[data-style=important]{animation-name:fb-ann-glow-amber}@keyframes fb-ann-glow-amber{0%,100%{box-shadow:0 0 0 1px #ffb84a26,0 0 10px #ffb84a40}50%{box-shadow:0 0 0 1px #ffb84a59,0 0 20px #ffb84a8c}}.fb-announcement-icon{flex:none;font-size:13px;filter:drop-shadow(0 0 5px var(--fb-glow))}.fb-announcement-marquee{flex:1;min-width:0;overflow:hidden;white-space:nowrap;-webkit-mask-image:linear-gradient(90deg,transparent,#000 18px,#000 calc(100% - 18px),transparent);mask-image:linear-gradient(90deg,transparent,#000 18px,#000 calc(100% - 18px),transparent)}.fb-announcement-track{display:inline-block;will-change:transform;transform:translateX(var(--fb-from,100%));animation:fb-ann-marquee var(--fb-marquee,14s) linear infinite}.fb-announcement-text{display:inline-block;padding:2px 0;font:650 13px/1.2 "Segoe UI Variable Display","Segoe UI",system-ui,-apple-system,Roboto,sans-serif;letter-spacing:.2px;background:linear-gradient(90deg,#ffffff,#eadcff 45%,#c9a8ff 70%,#ffffff);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 0 6px #a274ff8c)}.fb-announcement[data-style=important] .fb-announcement-text{background-image:linear-gradient(90deg,#fff6e6,#ffd89a 60%,#fff6e6)}.fb-announcement:hover .fb-announcement-track,.fb-announcement:focus-within .fb-announcement-track{animation-play-state:paused}@keyframes fb-ann-marquee{from{transform:translateX(var(--fb-from,100%))}to{transform:translateX(var(--fb-to,-100%))}}.fb-announcement-link{flex:none;height:22px;display:inline-flex;align-items:center;padding:0 10px;border-radius:99px;border:1px solid #c4a2ff99;background:#8b5cf633;color:#fff;font-size:11px;font-weight:700;text-decoration:none;white-space:nowrap;box-shadow:0 0 8px #8b5cf659}.fb-announcement[data-style=important] .fb-announcement-link{border-color:#ffd08a99;background:#ffb84a26;box-shadow:0 0 8px #ffb84a4d}.fb-announcement-link:hover{background:#8b5cf666}.fb-announcement-close{flex:none;width:22px;height:22px;padding:0;border:0;border-radius:50%;background:transparent;color:inherit;font-size:16px;line-height:1;cursor:pointer;opacity:.7}.fb-announcement-close:hover{opacity:1;background:#ffffff1a}@media (prefers-reduced-motion:reduce){.fb-announcement,.fb-announcement-track{animation:none}.fb-announcement-track{display:block;transform:none;overflow:hidden;text-overflow:ellipsis}}#builderTabPanel.fb-locked{position:relative;min-height:440px}#builderTabPanel .fb-maintenance{position:absolute;inset:0;z-index:40;display:flex;justify-content:center;align-items:flex-start;padding:72px 16px 16px;border-radius:inherit;background:#0b0912a8;backdrop-filter:blur(9px) saturate(.8);-webkit-backdrop-filter:blur(9px) saturate(.8)}#builderTabPanel .fb-maintenance[hidden]{display:none}#builderTabPanel .fb-maintenance-card{position:sticky;top:72px;width:100%;max-width:340px;box-sizing:border-box;text-align:center;padding:22px 18px 16px;border:1px solid #a274ff66;border-radius:16px;background:linear-gradient(180deg,#221b36f2,#15121ff2);box-shadow:0 12px 40px #000a,0 0 24px #8b5cf633}#builderTabPanel .fb-maintenance-lock{width:56px;height:56px;margin:0 auto 12px;display:grid;place-items:center;border-radius:50%;background:#8b5cf624;border:1px solid #a274ff66;color:#c4a2ff;box-shadow:0 0 18px #8b5cf640}#builderTabPanel .fb-maintenance-lock svg{width:28px;height:28px}#builderTabPanel .fb-maintenance-card h3{margin:0 0 8px;font-size:16px;line-height:1.25;color:#fff}#builderTabPanel .fb-maintenance-card p{margin:0 0 10px;color:#cfc8dd}#builderTabPanel .fb-maintenance-card .fb-maintenance-message{color:#fff;font-weight:600}#builderTabPanel .fb-maintenance-card button{margin-top:4px}#builderTabPanel .fb-maintenance-card .fb-maintenance-note{min-height:1em;margin:8px 0 0;font-size:11px;color:#a99fbd}#builderTabPanel .fb-maintenance-banner{display:grid;gap:2px;margin:0 0 10px;padding:8px 12px;border-radius:10px;border:1px solid #ffb84a66;background:#ffb84a14;color:#ffd79a;font-size:12px}#builderTabPanel .fb-maintenance-banner[hidden]{display:none}#builderTabPanel .fb-compact-nav .fb-tool-tile{min-width:0}#builderTabPanel .fb-compact-nav .fb-tool-tile>span{display:block;max-width:100%;white-space:normal;text-wrap:balance;overflow-wrap:anywhere}@media (max-width:440px){#builderTabPanel .fb-compact-nav .fb-tool-tile{font-size:10.5px;padding:8px 3px 7px}}#builderTabPanel .fb-compact-nav .fb-tool-tile svg{width:26px;height:26px;stroke-width:1.9;overflow:visible}#builderTabPanel .fb-compact-nav .fb-tool-tile:not(.fb-tool-locked):hover{transform:translateY(-1px);border-color:#ffffff30;background:linear-gradient(180deg,#27233a,#1a1824)}#builderTabPanel .fb-compact-nav .fb-tool-tile[aria-selected=true]{border-color:#a274ff;background:linear-gradient(180deg,#2e2350,#1c1631);color:#fff;box-shadow:0 0 0 1px #a274ff59,0 0 18px #8b5cf661,inset 0 0 18px #8b5cf62e}#builderTabPanel .fb-compact-nav .fb-tool-tile[aria-selected=true]::after{content:"";position:absolute;left:22%;right:22%;bottom:-1px;height:2px;border-radius:2px;background:#c4a2ff;box-shadow:0 0 8px #b892ff}#builderTabPanel .fb-compact-nav .fb-tool-tile[data-tone=story] svg{color:#b892ff;filter:drop-shadow(0 0 6px #b892ff8c)}#builderTabPanel .fb-compact-nav .fb-tool-tile[data-tone=video] svg{color:#4fa3ff;filter:drop-shadow(0 0 6px #4fa3ff8c)}#builderTabPanel .fb-compact-nav .fb-tool-tile[data-tone=motion] svg{color:#3ee6c8;filter:drop-shadow(0 0 6px #3ee6c88c)}#builderTabPanel .fb-compact-nav .fb-tool-tile[data-tone=factory] svg{color:#ffb84a;filter:drop-shadow(0 0 6px #ffb84a8c)}#builderTabPanel .fb-compact-nav .fb-tool-locked{cursor:not-allowed}#builderTabPanel .fb-compact-nav .fb-tool-locked span{color:#cfc8dd}#builderTabPanel .fb-tool-soon{position:absolute;top:4px;right:5px;padding:1px 6px;border-radius:99px;font-size:8px;font-weight:700;letter-spacing:.5px;color:#3ee6c8;background:#3ee6c814;border:1px solid #3ee6c859;text-transform:uppercase}#builderTabPanel .fb-tool-locked[data-soon] .fb-tool-soon{left:50%;right:auto;transform:translateX(-50%);white-space:nowrap}#builderTabPanel .fb-resource-row{display:flex;justify-content:center;align-items:center;gap:0}#builderTabPanel .fb-compact-nav .fb-resource-row button{position:relative;flex:0 1 auto;display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:3px 13px;border:0;border-radius:0;background:transparent;color:#b9b1cc;font-size:11.5px;font-weight:500;box-shadow:none}#builderTabPanel .fb-compact-nav .fb-resource-row button+button{border-left:1px solid #ffffff1a}#builderTabPanel .fb-compact-nav .fb-resource-row button svg{color:#cfc8e2}#builderTabPanel .fb-compact-nav .fb-resource-row button[data-tone=projects]::before{content:"";width:13px;height:13px;background:#cfc8e2;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'black\' stroke-width=\'2\' stroke-linejoin=\'round\'%3E%3Cpath d=\'M12 3 3 7.5l9 4.5 9-4.5Z\'/%3E%3Cpath d=\'M3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5\'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'black\' stroke-width=\'2\' stroke-linejoin=\'round\'%3E%3Cpath d=\'M12 3 3 7.5l9 4.5 9-4.5Z\'/%3E%3Cpath d=\'M3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5\'/%3E%3C/svg%3E") center/contain no-repeat}#builderTabPanel .fb-compact-nav .fb-resource-row button:hover{color:#fff;background:transparent}#builderTabPanel .fb-compact-nav .fb-resource-row button[aria-selected=true]{color:#fff;background:transparent}#builderTabPanel .fb-compact-nav .fb-resource-row button[data-tone=advance]{color:#ffc94d;font-weight:600}#builderTabPanel .fb-compact-nav .fb-resource-row button[data-tone=advance] svg{color:#ffc94d;filter:drop-shadow(0 0 4px #ffc94d99)}#builderTabPanel .fb-compact-nav .fb-resource-row button[data-tone=advance]::after{content:"";position:absolute;left:14px;right:14px;bottom:-11px;height:2px;border-radius:2px;background:linear-gradient(90deg,transparent,#ffc94d,transparent);box-shadow:0 0 6px #ffc94d}body:not(:has(#builderTabBtn[aria-selected=true])) .gs-bar{display:none!important}body .gs-bar{padding:5px 10px;gap:8px;margin:8px 0 0;border-radius:10px}body .gs-bar .gs-info{flex-direction:row;align-items:baseline;gap:8px}body .gs-bar .gs-info strong{font-size:11px;font-weight:600;color:#ddd5ee}body .gs-bar .gs-muted{font-size:10px}body .gs-bar .gs-actions button{min-height:22px;padding:2px 9px;font-size:10px;border-radius:7px}#builderTabPanel:has(.fb-compact-nav)>.fb-builder-head{display:none}#builderTabPanel:has(.fb-compact-nav) .fb-browse-heading{position:relative;margin-top:4px;padding-left:11px;font-size:14px;color:#f1ecfb}#builderTabPanel:has(.fb-compact-nav) .fb-browse-heading::before{content:"";position:absolute;left:0;top:2px;bottom:2px;width:3px;border-radius:3px;background:linear-gradient(180deg,#c4a2ff,#7c4dff);box-shadow:0 0 8px #8b5cf6}';document.head.append(style);})();
