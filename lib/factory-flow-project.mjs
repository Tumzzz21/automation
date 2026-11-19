// A persistent Flow project belongs to one Factory part on one selected account.
export const factoryFlowRoot=url=>String(url||'').match(/^https:\/\/flow\.google\.com\/(?:u\/\d+\/)?project\/[^/?#]+/i)?.[0]||null;
const accountOf=url=>Number(String(url||'').match(/^https:\/\/flow\.google\.com\/u\/(\d+)(?:\/|$)/i)?.[1]||0);
const isFlow=url=>/^https:\/\/flow\.google\.com(?:\/|$)/i.test(url||'');
// Runs in the extension's isolated world. Owner 2026-11-10: every "unusual activity" came on the first submit in a project
// 0xFlow had just made, and this was the last script click inside Flow's page. Now it only reports where "New project"
// is; the panel presses it with one real browser click (like "+" and Enter). scriptClick=true only where there is no
// chrome.debugger. Phones with chrome.debugger use the real click too (owner 2026-11-10); if it opens no project within
// env.fallbackAfter seconds, env.scriptClick presses the button the old way once, so phones never do worse than before.
export function factoryFlowPage(scriptClick=false) {
  const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
  if(/\/project\/[^/]+/.test(location.pathname))return {ok:[...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')].some(visible)};
  const button=[...document.querySelectorAll('button,[role="button"]')].filter(visible).find(e=>!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&/new project/i.test((e.innerText||'')+' '+(e.getAttribute('aria-label')||'')));
  if(!button)return {ok:false,creatingProject:false};
  if(scriptClick){button.click();return {ok:false,creatingProject:true};}
  button.scrollIntoView({block:'center',inline:'center'});
  const r=button.getBoundingClientRect();
  if(r.bottom<=0||r.right<=0||r.top>=innerHeight||r.left>=innerWidth)return {ok:false,creatingProject:false};
  return {ok:false,creatingProject:false,newProjectAt:{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}};
}
export async function ensureFactoryFlowProject(f,index,env) {
  const story=f.stories[index];if(!story?.projectId)throw Error('Factory part has no saved story');
  const {tabs,inspect,save,sleep}=env,assertActive=env.assertActive|| (async()=>{});
  await assertActive();let inventory=await tabs.query({});
  story.flowProjects ||= {};
  const previous=Object.values(story.flowProjects)[0];
  const recent=inventory.filter(t=>isFlow(t.url||t.pendingUrl)).sort((a,b)=>Number(!!b.active)-Number(!!a.active)||(b.lastAccessed||0)-(a.lastAccessed||0))[0];
  const account=env.account==null?(previous?.account??accountOf(recent?.url||recent?.pendingUrl)):Number(env.account);
  if(!Number.isInteger(account)||account<0)throw Error('Invalid Factory Flow account');
  const key=String(account);let binding=story.flowProjects[key];
  const unique=url=>{
    const root=factoryFlowRoot(url);
    if(!root||accountOf(root)!==account)throw Error('Factory Flow project/account does not match this part');
    if(f.stories.some((s,i)=>i!==index&&Object.values(s.flowProjects||{}).some(b=>factoryFlowRoot(b.url)===root)))throw Error('Another Factory part already owns this Flow project');
    return root;
  };
  if(binding?.url)unique(binding.url);
  if(!binding){binding=story.flowProjects[key]={account,tabId:null,url:null,creating:false};await save();}
  let tab=inventory.find(t=>t.id===binding.tabId);
  if(!tab&&binding.url)tab=inventory.find(t=>factoryFlowRoot(t.url)===binding.url);
  if(!tab){
    if(binding.creating&&!binding.url)throw Error('Factory project creation was not confirmed. Check Flow before resuming; no second project was created.');
    binding.creating=true;await save();await assertActive();
    const url=binding.url||((account?'https://flow.google.com/u/'+account+'/':'https://flow.google.com/')+'?hl=en');
    tab=await tabs.create({url,active:true});binding.tabId=tab.id;binding.creating=false;await save();
  }else if(binding.tabId!==tab.id){binding.tabId=tab.id;await save();}
  // Factory changes projects between parts. Unlike a manually captured task tab,
  // this fresh tab has no background capture to keep Flow's settings interactive.
  // Activate the exact bound tab before inspecting/clicking its composer.
  await assertActive();await tabs.update(binding.tabId,{active:true});
  let returned=false,realClickAt=-1;
  for(let attempt=0;attempt<(env.maxPolls||60);attempt++){
    await assertActive();inventory=await tabs.query({});tab=inventory.find(t=>t.id===binding.tabId);
    if(!tab)throw Error('Factory Flow tab was closed; resume this part to reopen its saved project');
    const url=tab.url||tab.pendingUrl||'';
    if(tab.status==='loading'&&isFlow(tab.pendingUrl)){
      if(accountOf(tab.pendingUrl)!==account)throw Error('Factory Flow account changed; no prompt was sent');
      await sleep(1000);continue;
    }
    if(!isFlow(url)){
      if(tab.status==='loading'&&isFlow(tab.pendingUrl)){await sleep(1000);continue;}
      throw Error('Factory Flow tab left Google Flow. Saved parts are kept.');
    }
    if(accountOf(url)!==account)throw Error('Factory Flow account changed; no prompt was sent');
    const root=factoryFlowRoot(url);
    if(binding.url&&root!==binding.url)throw Error('Factory Flow project changed; no other part will be used');
    if(root){
      unique(root);
      if(!binding.url){binding.url=root;await save();}
      if(url.split(/[?#]/)[0]!==root&&!returned){returned=true;await tabs.update(tab.id,{url:root});await sleep(1000);continue;}
      const ready=await inspect(tab.id);
      if(ready?.ok){await assertActive();return {...tab,url:root};}
    }else if(tab.status==='complete'&&!binding.createRequested){
      binding.createRequested=true;await save();await assertActive();
      const result=await inspect(tab.id);
      let creating=!!result?.creatingProject;
      if(!creating&&result?.newProjectAt&&env.click){await assertActive();await env.click(tab.id,result.newProjectAt);creating=true;realClickAt=attempt;}
      if(!creating){binding.createRequested=false;await save();}
    }else if(tab.status==='complete'&&env.scriptClick&&realClickAt>=0&&attempt-realClickAt>=(env.fallbackAfter||15)){
      realClickAt=-1;await assertActive();await env.scriptClick(tab.id);
    }
    await sleep(1000);
  }
  throw Error('Factory Flow project is not ready. Resume this part after Flow finishes loading.');
}
