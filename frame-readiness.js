// Self-contained functions injected into Flow. A filename in the library is not an attached frame.
function pg_flowFrameState(name, expected = null) {
  const visible=e=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
  const key=src=>String(src||'').split('?')[0];
  const wanted=String(name).toLowerCase();
  const sources=new Set();
  const mediaIds=new Set();
  if(expected?.name===name){
    if(expected.src)sources.add(key(expected.src));
    if(expected.mediaId)mediaIds.add(expected.mediaId);
  }
  for(const tile of document.querySelectorAll('flow-grid-tile-container')) {
    const match=[...tile.querySelectorAll('.footer-title,[role="button"],button')].some(e=>String(e.textContent||'').trim().toLowerCase()===wanted);
    const img=tile.querySelector('img');
    if(match&&img?.complete&&img.naturalWidth>0){
      sources.add(key(img.currentSrc||img.src));
      // Flow shows the same picture under a different address in the Start box than in the library (owner log 2026-10-30:
      // "start box 25150303, library 25150303" was not confirmed), so the media id in the address counts too.
      const id=img.getAttribute('data-media-id')||String(img.currentSrc||img.src).match(/\/image\/([a-z0-9-]+)(?:[?/#=]|$)/i)?.[1];if(id)mediaIds.add(id);
    }
  }
  const editors=[...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')].filter(visible).sort((a,b)=>b.getBoundingClientRect().top-a.getBoundingClientRect().top);
  const editor=editors[0];if(!editor)return {ready:false,error:'No Flow composer'};
  const r=editor.getBoundingClientRect();
  const picker=[...document.querySelectorAll('input')].some(e=>visible(e)&&/search assets/i.test((e.getAttribute('placeholder')||'')+' '+(e.getAttribute('aria-label')||'')));
  const frames=[...document.querySelectorAll('img')].filter(img=>{
    if(!visible(img)||!img.complete||img.naturalWidth===0)return false;
    const p=(img.closest('.frame-trigger')||img).getBoundingClientRect();
    return p.top>=r.top-100&&p.bottom<=r.bottom+100&&p.left>=r.left-30&&p.right<=r.right+30;
  });
  const triggers=[...document.querySelectorAll('.frame-trigger')].filter(e=>{
    const p=e.getBoundingClientRect();return visible(e)&&p.top>=r.top-110&&p.bottom<=r.bottom+100&&p.left>=r.left-30&&p.right<=r.right+30;
  }).sort((a,b)=>a.getBoundingClientRect().left-b.getBoundingClientRect().left);
  const startFrames=triggers.length ? frames.filter(img=>triggers[0].contains(img)) : frames;
  // A phone can leave an occupied Start chip with a placeholder instead of an <img>.
  // Treat it as filled (never ready), so recovery clears it before selecting the verified image.
  const mobile=typeof navigator!=='undefined'&&(!!navigator.userAgentData?.mobile||/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent||''));
  const startPlaceholder=mobile&&!!triggers[0]?.querySelector?.('button[aria-label="Image ingredient"],.chip-container');
  const matched=startFrames.some(img=>{
    const src=img.currentSrc||img.src;const id=img.getAttribute('data-media-id')||String(src).match(/\/image\/([a-z0-9-]+)(?:[?/#=]|$)/i)?.[1];
    return (id&&mediaIds.has(id))||sources.has(key(src))||[img.alt,img.title,img.getAttribute('aria-label')].some(v=>String(v||'').trim().toLowerCase()===wanted);
  });
  // What the check saw, for the log when the frame is not confirmed: pictures by the prompt box, frame boxes, library
  // tiles with this name, and the last 8 characters of each picture's media id.
  const tail=src=>{const s=key(src);return (s.match(/\/image\/([a-z0-9-]+)/i)?.[1]||s).slice(-8);};
  const seen='pictures by the prompt box '+frames.length+', frame boxes '+triggers.length+', library tiles named '+name+' '+sources.size+(startFrames.length?', start box '+startFrames.map(img=>tail(img.currentSrc||img.src)).join('/'):'')+(sources.size?', library '+[...sources].map(tail).join('/'):'');
  return {ready:matched&&!picker,matched,picker,libraryReady:sources.size>0,startFilled:triggers.length>0&&(startFrames.length>0||startPlaceholder),seen};
}

function pg_flowFramePickerPoint(name) {
  const visible=e=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
  const text=e=>String(e.getAttribute('aria-label')||e.innerText||e.textContent||'').trim().toLowerCase();
  const wanted=String(name).trim().toLowerCase();
  const same=v=>v===wanted||v===wanted.replace(/\.[^.]+$/,'');
  const search=[...document.querySelectorAll('input')].find(e=>visible(e)&&/search assets/i.test((e.getAttribute('placeholder')||'')+' '+(e.getAttribute('aria-label')||'')));
  if(!search)return {action:'closed'};
  // Search results may include icons/badges in the button's text. Match the
  // dedicated asset title, never a partial filename or the first result.
  const named=e=>same(text(e))||same(String(e.querySelector?.('.asset-title,.footer-title')?.textContent||'').trim().toLowerCase());
  const scope=search.closest?.('flow-add-menu-popover-content,[role="dialog"],.flow-menu-panel');
  let picker=search.parentElement,add=null,rowScope=null;
  while(picker&&picker!==document.body){
    if(!rowScope&&[...picker.querySelectorAll('[role="option"],button,[role="button"]')].some(e=>visible(e)&&named(e)))rowScope=picker;
    add=[...picker.querySelectorAll('button,[role="button"]')].find(e=>visible(e)&&text(e)==='add to prompt');
    if(add||picker===scope)break;
    picker=picker.parentElement;
  }
  picker=picker===document.body?rowScope:(picker||rowScope);
  if(!picker)return {action:'wait',reason:'waiting for image row '+name};
  const options=[...picker.querySelectorAll('[role="option"]')].filter(e=>visible(e)&&named(e));
  const rows=options.length?options:[...picker.querySelectorAll('button,[role="button"]')].filter(e=>visible(e)&&named(e));
  // A name ending in _ + 8 hex characters carries the start of the picture's sha256 (faceless-builder flowName), so rows
  // with that exact name are copies of one picture (owner run 2026-11-05: a re-upload left p01_scene_006_ffd360eb.png
  // three times and the scene failed). Any copy is the right frame; a plain name like scene_002.png is still never guessed.
  const sameFile=/_[a-f0-9]{8}\.(?:png|jpe?g|webp)$/i.test(wanted);
  if(rows.length>1&&!sameFile)return {action:'wait',reason:'multiple image rows match '+name+'; no frame guessed'};
  const row=rows.find(e=>e.getAttribute('aria-selected')==='true')||rows[0];
  if(!row)return {action:'wait',reason:'waiting for image row '+name};
  const preview=[...picker.querySelectorAll('img')].find(e=>visible(e)&&e.complete&&e.naturalWidth>0&&same(String(e.alt||'').toLowerCase().replace(/^preview of\s+/,'')));
  const point=e=>{const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};};
  if(row.getAttribute('aria-selected')!=='true'&&!preview)return {action:'select',...point(row)};
  if(!preview||!add||add.disabled||add.getAttribute('aria-disabled')==='true')return {action:'wait',reason:'waiting for selected frame preview and enabled Add to prompt'};
  const src=preview.currentSrc||preview.src;
  const mediaId=preview.getAttribute('data-media-id')||String(src).match(/\/image\/([a-z0-9-]+)(?:[?/#=]|$)/i)?.[1]||null;
  return {action:'add',...point(add),expected:{name,src,mediaId}};
}

function pg_flowOpenStartFrame() {
  const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
  if([...document.querySelectorAll('input')].some(e=>visible(e)&&/search assets/i.test((e.getAttribute('placeholder')||'')+' '+(e.getAttribute('aria-label')||''))))return {ok:true};
  const editors=[...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]')].filter(visible).sort((a,b)=>b.getBoundingClientRect().top-a.getBoundingClientRect().top);
  if(!editors[0])return {ok:false,error:'Flow composer not found'};
  const r=editors[0].getBoundingClientRect();
  const near=e=>{const p=e.getBoundingClientRect();return p.top>=r.top-110&&p.bottom<=r.bottom+100&&p.left>=r.left-30&&p.right<=r.right+30;};
  // Only the labelled Start box. Clicking a Start box that already shows a picture did not open the picker (owner run
  // 2026-10-30: a silent 60 s wait), so a filled box fails at once and the log shows what the box holds.
  const button=[...document.querySelectorAll('button,[role="button"],.frame-trigger')].filter(visible).find(e=>{
    const text=(e.getAttribute('aria-label')||e.innerText||'').trim();
    return /^(?:start|start frame|add start frame)$/i.test(text)&&near(e);
  });
  // The log says what the page looked like (phones: owner's user on Quetta, 2026-10-30), e.g. a narrow layout without the box.
  if(!button){const seen=[...document.querySelectorAll('button,[role="button"],.frame-trigger')].filter(e=>visible(e)&&near(e)).map(e=>(e.getAttribute('aria-label')||e.innerText||'').replace(/\s+/g,' ').trim().slice(0,24)).filter(Boolean).slice(0,8);
    return {ok:false,error:`Flow Start frame selector not found (page ${typeof innerWidth==='number'?innerWidth+'x'+innerHeight:'size unknown'}; near the prompt box: ${seen.length?seen.map(x=>'"'+x+'"').join(', '):'no buttons'})`};}
  if(button.disabled||button.getAttribute('aria-disabled')==='true')return {ok:false,error:'Flow Start frame selector is disabled'};
  // Flow's Start box is a div that ignores script clicks (checked live 2026-10-30: .click() opened nothing, a real click
  // opened "Select a frame image"), so return its centre for a debugger click.
  const p=button.getBoundingClientRect();return {ok:true,x:p.left+p.width/2,y:p.top+p.height/2};
}

// Reset an old filter using the native input setter so Flow receives the change.
function pg_flowSearchStartFrame(name) {
  const visible=e=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
  const search=[...document.querySelectorAll('input')].find(e=>visible(e)&&/search assets/i.test((e.getAttribute('placeholder')||'')+' '+(e.getAttribute('aria-label')||'')));
  if(!search)return {ok:false};
  const query=String(name).replace(/\.[^.]+$/,'');
  if(search.value!==query){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(search,query);search.dispatchEvent(new Event('input',{bubbles:true}));search.dispatchEvent(new Event('change',{bubbles:true}));}
  return {ok:true};
}

async function ensureFlowStartFrame(tabId, name, token) {
  assertRunActive(token);
  let state=await exec(tabId,pg_flowFrameState,[name],'MAIN');
  // A dropped image can take a few seconds to show as the start frame (p002 confirmed 2 s after the drop); wait for it
  // before opening the picker over a frame that is about to appear.
  for(let waited=0;!state.ready&&waited<5000;waited+=500){await sleep(500);assertRunActive(token);state=await exec(tabId,pg_flowFrameState,[name],'MAIN');}
  if(!state.ready&&state.seen&&typeof log==='function')log('Start frame '+name+' not confirmed yet; Flow shows: '+state.seen+'. Opening the Start picker.');
  let expected=null,ownsDebugger=false,connected=false;
  const target={tabId},send=(method,params)=>chrome.debugger.sendCommand(target,method,params);
  try {
    if(!state.ready){
      // Attach before measuring any coordinates: Chrome's debugger banner shifts
      // the layout. Keep it attached through selection and confirmation.
      try{await chrome.debugger.attach(target,'1.3');ownsDebugger=true;}
      catch(e){if(!/another debugger|already attached/i.test(String(e?.message||e)))throw e;}
      connected=true;await sleep(400);assertRunActive(token);
      // Stop/resume may leave an ingredient picker open. Reopen Start explicitly.
      await cdpEscape(send);await sleep(200);assertRunActive(token);
      // Closing a leftover picker can reveal an already-correct Start image.
      state=await exec(tabId,pg_flowFrameState,[name],'MAIN');
      // The Start box still shows another scene's picture (left by a failed try, owner log 2026-10-30: p001 found p004's
      // frame three times). It has no Start label then, so clear the prompt box first; the picker below adds the right one.
      if(state.startFilled&&!state.matched){
        const clear=await exec(tabId,pg_flowClearIngredientDraft,[],'MAIN');
        if(clear){assertRunActive(token);await flowCdpClick(tabId,clear.x,clear.y,true);await sleep(900);assertRunActive(token);if(typeof log==='function')log('Start frame '+name+': the Start box held another picture; cleared it.');}
      }
      let opened=state.ready?{ok:true}:await exec(tabId,pg_flowOpenStartFrame,[],'MAIN');
      if(!opened?.ok)throw Error('Flow frame attachment failed: '+(opened?.error||'Start selector unavailable')+(state.seen?' (Flow shows: '+state.seen+')':''));
      if(opened.x!=null){assertRunActive(token);await flowCdpClick(tabId,opened.x,opened.y,true);}
      await sleep(500);assertRunActive(token);
      const selectingAt=Date.now();let added=false,searched=false,recovered=false,lastReason='frame picker did not finish';
      while(Date.now()-selectingAt<60000){
        assertRunActive(token);
        // Mobile can attach immediately and close the picker, without a separate Add button.
        // Preserve the same image-identity check and final stability wait.
        const attached=await exec(tabId,pg_flowFrameState,[name,expected],'MAIN');
        if(attached.ready){expected=expected||{name};added=true;break;}
        if(!searched){const search=await exec(tabId,pg_flowSearchStartFrame,[name],'MAIN');searched=!!search?.ok;if(searched){await sleep(500);continue;}}
        const point=searched?await exec(tabId,pg_flowFramePickerPoint,[name],'MAIN'):null;
        if(point?.action==='select'||point?.action==='add'){
          assertRunActive(token);await flowCdpClick(tabId,point.x,point.y,true);
          if(point.action==='add'){expected=point.expected;added=true;break;}
        }else lastReason=point?.reason||'frame picker or search unavailable';
        if(!recovered&&Date.now()-selectingAt>=12000){
          assertRunActive(token);await cdpEscape(send);await sleep(200);assertRunActive(token);
          opened=await exec(tabId,pg_flowOpenStartFrame,[],'MAIN');
          if(!opened?.ok)throw Error('Flow frame attachment failed: '+(opened?.error||'Start selector unavailable'));
          if(opened.x!=null){assertRunActive(token);await flowCdpClick(tabId,opened.x,opened.y,true);}
          searched=false;recovered=true;await sleep(500);
        }
        await sleep(500);
      }
      if(!added)throw Error('Flow frame attachment failed: '+lastReason);
    }
    const start=Date.now();let stableSince=0;
    while(Date.now()-start<60000){
      assertRunActive(token);state=await exec(tabId,pg_flowFrameState,[name,expected],'MAIN');
      if(state.ready){stableSince=stableSince||Date.now();if(Date.now()-stableSince>=1500)return expected;}
      else stableSince=0;
      await sleep(300);
    }
    throw Error('Flow frame attachment failed: '+name+' was not confirmed in the start-frame box. Prompt was not submitted.');
  } finally {
    if(connected)await cdpEscape(send).catch(()=>{});
    if(ownsDebugger)await chrome.debugger.detach(target).catch(()=>{});
  }
}
