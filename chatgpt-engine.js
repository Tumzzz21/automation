// Experimental ChatGPT image adapter. No private APIs, session tokens or account changes.
let chatgptTaskTab = null;
async function chatgptExactTab(tabId) {
  if(/Android|iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent||'')&&typeof chrome.tabs.query==='function'){
    const tab=(await chrome.tabs.query({})).find(t=>t.id===tabId);
    if(!tab)throw Error('No tab with id: '+tabId);
    return tab;
  }
  return chrome.tabs.get(tabId);
}
function isChatgptTab(tab) { return /^https:\/\/chatgpt\.com(?:\/|$)/i.test(tab?.url || ''); }
// A tab that is still opening has an empty URL: no conversation yet (owner 2026-10-24: "Failed to construct 'URL'").
function chatgptConversationId(url) { try { return new URL(url).pathname.match(/\/c\/([^/]+)/)?.[1]; } catch { return undefined; } }
function rememberChatgptTaskTab(tab) { chatgptTaskTab={id:tab.id,url:tab.url || 'https://chatgpt.com/'}; }
// Factory (owner 2026-11-10): each new story starts its own ChatGPT chat, so characters of an earlier story do not slip
// into the next one's images. Set by the Factory, used once by the next ChatGPT prompt. Hand-run queues keep the open chat.
let chatgptFreshChatNext=false;
function chatgptStartFreshChat(){chatgptFreshChatNext=true;}
async function chatgptOpenFreshChat(tab) {
  chatgptFreshChatNext=false;
  if(!chatgptConversationId(tab.url))return tab;
  await chrome.tabs.update(tab.id,{url:'https://chatgpt.com/'});
  await sleep(800);
  if(typeof waitForTabComplete==='function')await waitForTabComplete(tab.id,15000).catch(()=>{});
  const now=await chatgptExactTab(tab.id).catch(()=>tab);
  if(typeof log==='function')log('ChatGPT: new chat for this story.');
  return {...now,url:chatgptConversationId(now.url)?'https://chatgpt.com/':now.url};
}
async function getChatgptTaskTab(slot) {
  const id=chatgptTaskTab?.id ?? slotTabs.get(slot);
  let tab;
  if(chatgptFreshChatNext&&id!=null){
    const open=await chatgptExactTab(id).catch(()=>null);
    if(open&&isChatgptTab(open)){tab=await chatgptOpenFreshChat(open);rememberChatgptTaskTab(tab);}
  }
  if(id!=null) {
    try{tab=await chatgptExactTab(id);}catch(e){
      if(!/No tab|Invalid tab|closed|not found/i.test(String(e.message||e)))throw e;
      tab=await chrome.tabs.create({url:chatgptTaskTab?.url || 'https://chatgpt.com/',active:!!settings.openTabWhileGenerating});
    }
    if(tab.url && !isChatgptTab(tab))throw Error('The task ChatGPT tab was navigated away. Return to its conversation before retrying.');
    if(chatgptTaskTab?.id===tab.id && tab.url && chatgptConversationId(chatgptTaskTab.url) && chatgptConversationId(tab.url)!==chatgptConversationId(chatgptTaskTab.url))throw Error('The task ChatGPT conversation changed. Return to the original chat, or select the intended ChatGPT tab before pressing Start.');
  } else {
    const active=typeof chrome.tabs.query==='function'?(await chrome.tabs.query({active:true,lastFocusedWindow:true}))[0]:null;
    tab=isChatgptTab(active)?active:await chrome.tabs.create({url:'https://chatgpt.com/',active:!!settings.openTabWhileGenerating});
  }
  if(chatgptFreshChatNext)tab=await chatgptOpenFreshChat(tab);
  const background=typeof confirmBackgroundTab==='function'&&await confirmBackgroundTab(tab.id);
  if(settings.openTabWhileGenerating&&!background)await chrome.tabs.update(tab.id,{active:true});
  await zoomChatgptTab(tab.id);
  rememberChatgptTaskTab(tab);slotTabs.set(slot,tab.id);return tab;
}
// 50% for this tab only (like Flow): more of the chat and the composer fit, also in a small window.
// restoreTabZoom puts the tab back to 100% when the whole queue finishes.
// Called at queue start, before each prompt and while waiting: a page load (new chat, reload) resets a per-tab zoom.
async function zoomChatgptTab(tabId,retry=true) {
  if(typeof chrome.tabs.setZoom!=='function')return;
  try{
    // A tab that has not loaded its page yet has no address, and Chrome refuses the zoom ("Cannot access contents of url
    // ''", owner log 2026-10-25): wait up to 10 s for the page, then zoom.
    for(let i=0;i<20&&typeof chrome.tabs.get==='function';i++){const t=await chatgptExactTab(tabId).catch(()=>null);if(!t||(t.url&&t.status==='complete'))break;await sleep(500);}
    const zoom=await chrome.tabs.getZoomSettings(tabId);
    const before=await chrome.tabs.getZoom(tabId);
    if(zoom?.scope!=='per-tab'){
      await chrome.tabs.setZoomSettings(tabId,{mode:'automatic',scope:'per-tab'});
    }
    if(Math.abs((await chrome.tabs.getZoom(tabId))-0.5)>0.01){
      await chrome.tabs.setZoom(tabId,0.5);await sleep(600);
      const now=await chrome.tabs.getZoom(tabId);
      if(typeof log==='function')log(Math.abs(now-0.5)<=0.01?`ChatGPT tab zoom set to 50% (was ${Math.round(before*100)}%).`:`ChatGPT tab zoom is ${Math.round(now*100)}% after setting 50%.`);
    }
  }catch(e){
    if(retry&&/Cannot access contents of url/i.test(e?.message||'')){await sleep(1500);return zoomChatgptTab(tabId,false);}
    if(typeof log==='function')log(`ChatGPT zoom could not be set: ${e.message||e}`);
  }
}
function chatgptPromptMatches(actual,expected) {
  // Match rendered JSON/Markdown despite whitespace, syntax styling and smart quotes.
  const norm=text=>String(text||'').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  const wanted=norm(expected),seen=norm(actual);
  // Long user messages can be collapsed behind Show more; bind their visible prefix.
  return !!wanted && (seen.includes(wanted) || (wanted.length>200 && seen.includes(wanted.slice(0,200))));
}
async function refreshChatgptTaskTab(tabId, submission = null) {
  const tab=await chatgptExactTab(tabId);
  if(!tab.url)return;
  if(!isChatgptTab(tab))throw Error('The task ChatGPT tab was navigated away. Return to its conversation before retrying.');
  if(chatgptTaskTab?.id===tabId && chatgptConversationId(chatgptTaskTab.url) && chatgptConversationId(tab.url)!==chatgptConversationId(chatgptTaskTab.url)) {
    if(!submission || !(submission.idMatch || chatgptPromptMatches(submission.userText,submission.prompt))) {
      if(submission && Date.now()-submission.sentAt<(submission.userText?15000:45000))return false;
      throw Object.assign(Error(submission && !submission.userText ? 'Could not read the submitted ChatGPT message after its URL updated. Queue paused; check Debug Logs.' : 'Could not match the submitted prompt after ChatGPT updated its conversation URL. Queue paused; check Debug Logs.'),{chatgptConversationChanged:true});
    }
    if(typeof log==='function')log('ChatGPT conversation URL updated after Send; submitted prompt confirmed in the same task tab.');
  }
  rememberChatgptTaskTab(tab);
  return true;
}
function pg_chatgptSnapshot() {
  const visible = e => !!e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
  const editors = [...document.querySelectorAll('[contenteditable="true"][role="textbox"],#prompt-textarea,textarea')].filter(visible);
  const editor = editors.sort((a,b)=>b.getBoundingClientRect().width-a.getBoundingClientRect().width)[0];
  const scope = editor?.closest('form') || document;
  const buttons = [...scope.querySelectorAll('button')].filter(visible);
  const stop = [...document.querySelectorAll('button')].filter(visible).some(e => /^(stop|stop generating)$/i.test(e.getAttribute('aria-label') || e.innerText.trim()));
  const send = buttons.find(e => /^(send|send message|send prompt)$/i.test(e.getAttribute('aria-label') || e.innerText.trim()) || e.dataset.testid === 'send-button');
  // ChatGPT mixes role-marked messages and heading-marked image/tool turns.
  // Merge both layouts in document order; neither selector is a global fallback.
  const turnOf=e=>e.closest?.('article,[data-testid^="conversation-turn-"]') || e;
  const ordered=nodes=>[...new Set(nodes)].sort((a,b)=>{
    const order=a.compareDocumentPosition?.(b) || 0;
    return order&2?1:order&4?-1:0;
  });
  const roots=ordered([
    ...[...document.querySelectorAll('[data-message-author-role="assistant"]')].map(turnOf),
    ...[...document.querySelectorAll('[data-conversation-role="assistant"]')].map(e=>turnOf(/^H[1-6]$/.test(e.tagName)?e.parentElement:e)),
    ...[...document.querySelectorAll('h4[data-conversation-role="assistant"]')].map(e=>turnOf(e.closest?.('[data-message-author-role="assistant"]') || e.parentElement))
  ]);
  const users=ordered([
    ...[...document.querySelectorAll('[data-user-message-bubble="true"]')].map(turnOf),
    ...[...document.querySelectorAll('[data-message-author-role="user"]')].map(turnOf),
    ...[...document.querySelectorAll('[data-conversation-role="user"]')].map(e=>turnOf(/^H[1-6]$/.test(e.tagName)?e.parentElement:e)),
    ...[...document.querySelectorAll('h5[data-conversation-role="user"],h4[data-conversation-role="user"]')].map(e=>turnOf(e.closest?.('[data-message-author-role="user"]') || e.parentElement))
  ]);
  const lastUser=users.at(-1);
  const userMessage=lastUser?.querySelector?.('[data-message-author-role="user"]') || lastUser;
  const latestUserText=userMessage?.textContent || userMessage?.innerText || '';
  // The latest user turn's own ID (customer log 2026-10-23): in long chats ChatGPT keeps only ~12 turns on the page, so the
  // count does not rise, and it can show a long prompt collapsed (24 characters), so the text does not match. A new ID
  // still proves a new message was sent, and binds the reply to it.
  // The ID can sit on the bubble, a wrapper above it or the turn itself, depending on the ChatGPT layout.
  const idOf=e=>e?.getAttribute?.('data-message-id')||e?.getAttribute?.('data-turn-id')||e?.getAttribute?.('data-turn-key')||e?.getAttribute?.('data-chatgpt-search-message-ids')||'';
  const turnTestId=/^conversation-turn-\d+$/.test(lastUser?.getAttribute?.('data-testid')||'')?lastUser.getAttribute('data-testid'):'';
  const latestUserId=idOf(userMessage)||idOf(userMessage?.querySelector?.('[data-message-id],[data-turn-id]'))||idOf(userMessage?.closest?.('[data-message-id],[data-turn-id],[data-chatgpt-search-message-ids],[data-turn-key]'))||idOf(lastUser)||idOf(lastUser?.querySelector?.('[data-message-id],[data-turn-id]'))||turnTestId||'';
  // Virtualized chats can leave an older marked assistant image in the DOM while
  // the current generated card has no assistant marker. Never let that old image
  // prevent the after-current-user fallback from finding the new result.
  const lastAssistant=lastUser?roots.filter(root=>!!(lastUser.compareDocumentPosition?.(root)&4)).at(-1):roots.at(-1);
  // Image cards can be siblings of the role-marked message inside its turn.
  // Never broaden to the whole conversation: old images must stay excluded.
  const turn=lastAssistant?.closest?.('article,[data-testid^="conversation-turn-"]');
  const reply=turn && !turn.querySelector('[data-message-author-role="user"]') ? turn : lastAssistant;
  let assistantAfterLatestUser=!!lastUser && !!lastAssistant && !!(lastUser.compareDocumentPosition?.(lastAssistant)&4);
  const generated = [...document.querySelectorAll('[data-testid="generated-image-preview"] img, img[alt]')].filter(img=>img.closest('[data-testid="generated-image-preview"]') || /generated image|image created|generated by/i.test(img.alt||''));
  const candidates = [...roots.flatMap(root=>[...root.querySelectorAll('img')]), ...generated];
  const sources = [...new Set(candidates.filter(img=>img.complete && img.naturalWidth>=256 && img.naturalHeight>=256 && !img.closest('[data-message-author-role="user"]')).map(img=>img.currentSrc||img.src))];
  const usable=img=>img.complete && img.naturalWidth>=256 && img.naturalHeight>=256 && !img.closest('[data-message-author-role="user"],[data-user-message-bubble="true"]');
  let replyImages=[...(reply?.querySelectorAll('img') || [])].filter(usable);
  // Some ChatGPT layouts render the generated image outside the assistant turn: accept generated images that follow the latest user turn.
  // The turn may carry no assistant marker at all (only the image card), so also accept any large image in the conversation that follows the latest user turn.
  let outsideTurn=false;
  if(!replyImages.length && lastUser){
    const afterUser=img=>usable(img) && !!(lastUser.compareDocumentPosition?.(img)&4);
    replyImages=generated.filter(afterUser);
    if(!replyImages.length) replyImages=[...document.querySelectorAll('main img,[role="main"] img')].filter(afterUser);
    outsideTurn=replyImages.length>0;
    if(outsideTurn) assistantAfterLatestUser=true;
  }
  const replySources=[...new Set(replyImages.map(img=>img.currentSrc||img.src))];
  const text = reply?.innerText || ''; 
  const limit = /you.ve reached.*limit|image generation limit|too many requests|try again (?:in|after)|unable to upload/i.test(text);
  // "...the image we created may violate our guardrails around acceptable depictions of teens and children. If you think we
  // got it wrong, please retry or edit your prompt." (owner 2026-10-25): ChatGPT judges the finished picture, so a retry can pass.
  const denied = /can.t (?:help|create|generate)|cannot (?:help|create|generate)|against.*polic|violat.*polic|violate our guardrails|may violate our (?:guardrails|content)/i.test(text);
  const failed = /image generation failed|(?:couldn.t|could not|wasn.t able to|was unable to) generate the [\w -]{0,30}image this time|please resend the request|(?:wasn.t|was not|weren.t|were not|unable|couldn.t|could not) (?:able )?to generate (?:the|an|this) image.*error|error (?:on my side|while generating)/i.test(text);
  // A text reply that asks something instead of drawing ("Please upload the image... or confirm that you want...").
  const question = !replySources.length && /\?\s*$|please (?:upload|confirm|provide|share)|(?:would|do) you (?:like|want)|(?:shall|should) I\b|confirm (?:that|whether|if)|let me know/i.test(text.trim());
  const latest = reply;
  const generationStage = /making the first draft|generating image|creating image|adding details|finishing touches|adding (?:the )?final touches|finalizing (?:the )?image/i;
  // Any other finished text answer without an image (a refusal in other words, an explanation): owner run 2026-10-25, a
  // storyboard sheet with children in a fire waited 3 x 5 minutes on such a reply.
  const textReply = !replySources.length && text.trim().length >= 40 && !generationStage.test(text);
  let progressPercent = null, progressOutsideTurn = false;
  if (latest) {
    const progressValues = [...latest.querySelectorAll('[role="progressbar"][aria-valuenow]')].filter(visible).map(e=>Number(e.getAttribute('aria-valuenow'))).filter(n=>Number.isFinite(n)&&n>=0&&n<=100);
    // Only exact, visible percentage badges near an image-generation stage count.
    if (generationStage.test(text)) {
      for (const badge of latest.querySelectorAll('span,div,p')) {
        if (!visible(badge) || badge.children.length) continue;
        const match = (badge.textContent || '').trim().match(/^(100|[1-9]?\d)\s*%$/);
        if (match) progressValues.push(Number(match[1]));
      }
    }
    if(progressValues.length)progressPercent=Math.max(...progressValues);
  }
  // Image-to-Image can render its stage/percentage outside a marked assistant.
  // Bind an exact badge to a nearby generation card after the latest user turn;
  // never use a page-wide percentage, user text, composer, or older progress.
  if (progressPercent === null && lastUser) {
    const afterUser = node => !!node && !lastUser.contains?.(node)
      && !node.closest?.('[data-message-author-role="user"],[data-user-message-bubble="true"],form,[contenteditable="true"]')
      && !!(lastUser.compareDocumentPosition?.(node)&4);
    for (const badge of document.querySelectorAll('main [role="progressbar"][aria-valuenow],main span,main div,main p,[role="main"] [role="progressbar"][aria-valuenow],[role="main"] span,[role="main"] div,[role="main"] p')) {
      const aria = badge.getAttribute?.('aria-valuenow');
      const exact = !badge.children?.length && (badge.textContent || '').trim().match(/^(100|[1-9]?\d)\s*%$/);
      const value = aria != null && aria !== '' ? Number(aria) : exact ? Number(exact[1]) : NaN;
      if (!Number.isFinite(value) || value < 0 || value > 100 || !visible(badge) || !afterUser(badge)) continue;
      for (let card=badge.parentElement,depth=0;card && depth<6;card=card.parentElement,depth++) {
        if (/^(MAIN|BODY|HTML)$/.test(card.tagName || '') || card.getAttribute?.('role') === 'main') break;
        if (!afterUser(card)) break;
        if (generationStage.test(card.innerText || '')) {
          progressPercent = Math.max(progressPercent ?? 0, value);
          progressOutsideTurn = true; assistantAfterLatestUser = true;
          break;
        }
      }
    }
  }
  const finishedScope=(outsideTurn || (reply && replyImages.length && !(reply.contains?.(replyImages[0]) ?? true))) ? document : reply;
  const finishedControls=[...(finishedScope?.querySelectorAll('button,a[download],[role="button"]') || [])].filter(visible).some(e=>!e.disabled && (!progressOutsideTurn || !!(lastUser.compareDocumentPosition?.(e)&4)) && /^(edit(?: (?:generated )?image(?: \d+)?)?|download(?: (?:generated )?image(?: \d+)?)?|save image)$/i.test((e.getAttribute('aria-label') || e.getAttribute('title') || e.innerText || '').trim()));
  const completedImage=assistantAfterLatestUser && replySources.length>0 && finishedControls && !stop && !denied && !limit;
  const busy = stop || (!(completedImage || denied || failed || limit) && ((progressPercent !== null && progressPercent < 100) || progressOutsideTurn || generationStage.test(text) || /image generation in progress/i.test(text)));
  if(completedImage)progressPercent=100;
  const r = editor?.getBoundingClientRect();
  const diag={replyFound:!!reply,replyImages:replyImages.length,finishedControls,stop,denied,failed,limit,progressPercent,outsideTurn,progressOutsideTurn,historicalAssistantIgnored:!!lastUser&&roots.length>0&&!lastAssistant};
  return {diag,editor:!!editor, editorText:editor?.innerText || editor?.value || '',point:r?{x:r.x+r.width/2,y:r.y+r.height/2}:null, send:send&&!send.disabled?{x:send.getBoundingClientRect().x+send.getBoundingClientRect().width/2,y:send.getBoundingClientRect().y+send.getBoundingClientRect().height/2}:null, busy, progressPercent, sources,replySources,question,textReply,assistantCount:roots.length,userCount:users.length,latestUserId,latestUserText,assistantAfterLatestUser,limit, denied,failed, text:text.slice(-1600)};
}

async function pg_chatgptUpload(files, forcePaste = false) {
  const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
  const editors=[...document.querySelectorAll('[contenteditable="true"][role="textbox"],#prompt-textarea,textarea')].filter(visible);
  const editor=editors.sort((a,b)=>b.getBoundingClientRect().width-a.getBoundingClientRect().width)[0];
  if(!editor)return {ok:false,error:'ChatGPT composer not found for reference upload'};
  let scope=editor.closest('form');
  if(!scope) {
    for(let node=editor.parentElement,depth=0;node&&depth<7;node=node.parentElement,depth++) {
      if(node.querySelector('button[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label="Send"]')) {scope=node;break;}
    }
  }
  scope ||= editor.parentElement?.parentElement;
  const inputs = [...document.querySelectorAll('input[type="file"]')];
  const eligible=inputs.filter(e=>!e.disabled && (!e.accept || /image|\.(png|jpe?g|webp|gif)|\*\//i.test(e.accept)) && (files.length===1 || e.multiple));
  const local=eligible.filter(e=>scope?.contains(e));
  let input = local.find(e=>/image/i.test(e.accept)) || local[0] || eligible.find(e=>/image/i.test(e.accept)) || eligible[0];
  const transfer = new DataTransfer();
  for (const file of files) {
    const bytes = Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0));
    transfer.items.add(new File([bytes],file.name,{type:file.type}));
  }
  let method='file input';
  if(!input && !forcePaste) {
    // ChatGPT can create its file input only after the attachment menu is opened.
    const buttons=[...document.querySelectorAll('button')].filter(visible);
    const plus=buttons.find(e=>/add files|add photos|attach files|attach|upload/i.test([e.getAttribute('aria-label'),e.getAttribute('title'),e.dataset?.testid].join(' '))) ||
      buttons.find(e=>e.dataset?.testid==='composer-plus-btn');
    if(!plus)return {ok:false,error:'ChatGPT attachment button not found. Open the composer + menu, then retry.'};
    plus.click();
    const wait=ms=>new Promise(r=>setTimeout(r,ms));
    const findInput=()=>[...document.querySelectorAll('input[type="file"]')].find(e=>!e.disabled && (files.length===1 || e.multiple) && (!e.accept || /image|\.(png|jpe?g|webp|gif)|\*\//i.test(e.accept)));
    for(let n=0;n<8&&!input;n++){await wait(150);input=findInput();}
    method='attachment menu file input';
    if(!input) {
      const upload=[...document.querySelectorAll('[role="menuitem"],button')].filter(visible).find(e=>/^(add photos\s*(?:&|and)\s*files|upload(?: files| photos)?|upload from computer|add files|choose files)$/i.test((e.innerText || e.getAttribute('aria-label') || '').trim()));
      if(!upload)return {ok:false,error:'ChatGPT upload menu did not expose a file input. Open + → Add photos & files, then retry.'};
      // Capture the menu-created input; never open a native file picker.
      const originalClick=HTMLInputElement.prototype.click;
      let captured=false,captureError='';
      HTMLInputElement.prototype.click=function(...args){
        if(this.type!=='file')return originalClick.apply(this,args);
        try {
          if(files.length>1&&!this.multiple){captureError='ChatGPT upload control accepts only one file at a time';return;}
          this.files=transfer.files;
          this.dispatchEvent(new Event('input',{bubbles:true}));
          this.dispatchEvent(new Event('change',{bubbles:true}));
          captured=true;
        }catch(e){captureError=String(e.message||e);}
      };
      try {
        upload.click();
        for(let n=0;n<10&&!captured&&!captureError;n++){
          await wait(150);input=findInput();
          if(input){input.files=transfer.files;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));captured=true;}
        }
      }finally{HTMLInputElement.prototype.click=originalClick;}
      if(captured)return {ok:true,method:'attachment menu file selection'};
      return {ok:false,error:captureError||'ChatGPT did not create its upload control; prompt was not sent'};
    }
  }
  if(input && !forcePaste) {
    try {
      input.files=transfer.files;
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));
      return {ok:true,method};
    } catch {}
  }
  editor.focus();
  editor.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));
  return {ok:true,method:'composer paste'}; // Acceptance is checked separately; dispatch alone is not success.
}

function pg_chatgptUploadStatus(names, baseline = null) {
  const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
  const editors=[...document.querySelectorAll('[contenteditable="true"][role="textbox"],#prompt-textarea,textarea')].filter(visible);
  const editor=editors.sort((a,b)=>b.getBoundingClientRect().width-a.getBoundingClientRect().width)[0];
  let form=editor?.closest('form');
  if(!form) {
    for(let node=editor?.parentElement,depth=0;node&&depth<7;node=node.parentElement,depth++) {
      if(node.querySelector('button[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label="Send"]')) {form=node;break;}
    }
  }
  form ||= editor?.parentElement?.parentElement;
  if(!form)return {ready:false};
  const text=form.innerText || '';
  const labels=[...form.querySelectorAll('[aria-label],[title],img')].filter(e=>!editor.contains?.(e)).map(e=>e.getAttribute('aria-label')||e.getAttribute('title')||e.alt||'').join('\n');
  const attachmentText=text.replace(editor.innerText || editor.value || '', '');
  const found=names.filter(name=>(attachmentText+'\n'+labels).toLowerCase().includes(name.toLowerCase()));
  const previews=[...form.querySelectorAll('img')].filter(visible).map(img=>({src:img.currentSrc||img.src,loaded:img.complete&&img.naturalWidth>0&&img.naturalHeight>0})).filter(img=>img.src);
  const previewSources=[...new Set(previews.map(img=>img.src))];
  const fresh=previews.filter(img=>!baseline?.previewSources?.includes(img.src));
  const freshSources=new Set(fresh.filter(img=>img.loaded).map(img=>img.src));
  const pending=[...form.querySelectorAll('[role="progressbar"],[aria-busy="true"]')].some(visible) || fresh.some(img=>!img.loaded);
  const error=/upload failed|unable to upload|file.*too large|too many files/i.test(text);
  const named=names.length>0 && found.length===names.length && (!baseline || found.every(name=>!baseline.found?.includes(name)));
  const imageEvidence=!!baseline && names.length>0 && freshSources.size>=names.length;
  return {ready:(named||imageEvidence)&&!pending&&!fresh.some(img=>!img.loaded),found,previewSources,newPreviewCount:freshSources.size,pending,
    error:error?'ChatGPT could not upload these references':null};
}

function pg_chatgptCancel() {
  const button=[...document.querySelectorAll('button')].find(e=>/^(stop|stop generating)$/i.test(e.getAttribute('aria-label')||''));
  if(button)button.click();
}

function pg_chatgptClickSend() {
  const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
  const editors=[...document.querySelectorAll('[contenteditable="true"][role="textbox"],#prompt-textarea,textarea')].filter(visible);
  const editor=editors.sort((a,b)=>b.getBoundingClientRect().width-a.getBoundingClientRect().width)[0];
  const scope=editor?.closest('form') || document;
  const send=[...scope.querySelectorAll('button')].filter(visible).find(e=>/^(send|send message|send prompt)$/i.test(e.getAttribute('aria-label') || e.innerText.trim()) || e.dataset.testid==='send-button');
  if(!send||send.disabled)return false;
  send.click();return true;
}

// Attachment chips in the composer, read from their "Remove <filename>" buttons (live markup, Oct 2026).
function pg_chatgptComposerAttachments() {
  const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
  const editors=[...document.querySelectorAll('[contenteditable="true"][role="textbox"],#prompt-textarea,textarea')].filter(visible);
  const editor=editors.sort((a,b)=>b.getBoundingClientRect().width-a.getBoundingClientRect().width)[0];
  if(!editor)return {count:0,names:[]};
  const form=editor.closest('form') || editor.parentElement?.parentElement?.parentElement || document;
  const names=[...form.querySelectorAll('button')].filter(visible)
    .map(button=>(button.getAttribute('aria-label')||button.getAttribute('title')||'').trim())
    .filter(label=>/^remove\s+\S/i.test(label)).map(label=>label.replace(/^remove\s+/i,''));
  return {count:names.length,names};
}

// Removes an unsent draft (text and attachments) left behind by a failed send, so Retry can start clean.
async function pg_chatgptClearComposer() {
  const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
  const editors=[...document.querySelectorAll('[contenteditable="true"][role="textbox"],#prompt-textarea,textarea')].filter(visible);
  const editor=editors.sort((a,b)=>b.getBoundingClientRect().width-a.getBoundingClientRect().width)[0];
  if(!editor)return {ok:false};
  const form=editor.closest('form') || editor.parentElement?.parentElement?.parentElement || document;
  for(let round=0;round<12;round++){
    const remove=[...form.querySelectorAll('button')].filter(visible).find(e=>/^(?:remove|delete)\b/i.test((e.getAttribute('aria-label')||e.getAttribute('title')||'').trim()));
    if(!remove)break;
    remove.click();await new Promise(r=>setTimeout(r,150));
  }
  editor.focus();
  if(editor.tagName==='TEXTAREA'){editor.value='';editor.dispatchEvent(new Event('input',{bubbles:true}));}
  else{document.execCommand('selectAll',false);document.execCommand('delete',false);}
  await new Promise(r=>setTimeout(r,200));
  return {ok:true,text:(editor.innerText||editor.value||'').trim().length,images:[...form.querySelectorAll('img')].filter(visible).length};
}

function chatgptPrompt(item) {
  const aspect={portrait:'9:16 vertical',landscape:'16:9 horizontal',square:'1:1 square'}[settings.aspectRatio];
  // A storyboard sheet already starts with its own "Create ONE vertical 9:16 image…": sent as it is (owner test 2026-10-25:
  // the same sheet asked for a reference image with the line below in front of it and was made without it).
  if (/^Create ONE vertical 9:16 image divided into FOUR\b/.test(item.generationText || '')) return item.generationText;
  return `Create exactly one image, ${aspect}. ${settings.mode==='image-to-image'?'Use the attached images as visual references. Match the references to the filenames mentioned below.':'Generate the image from this description.'}\n\n${item.generationText || item.text}`;
}

// Clicks Send and confirms ChatGPT took the message. Chrome's debugging banner shifts the page when the debugger
// attaches, so coordinates measured before attaching can miss the button (worse in a non-maximized window):
// re-measure after the banner appears, verify the message was sent, then fall back to a page-level click.
async function chatgptSubmitPrompt(tabId, snap, prompt, token) {
  const baseUsers=typeof snap.userCount==='number'?snap.userCount:null,baseUserId=snap.latestUserId||'';
  const sent=async()=>{
    const s=await exec(tabId,pg_chatgptSnapshot,[],'MAIN');
    if(typeof s.userCount!=='number')return true;
    return (baseUsers!==null && s.userCount>baseUsers) || (!!s.latestUserId && s.latestUserId!==baseUserId) || (chatgptPromptMatches(s.latestUserText,prompt) && !String(s.editorText||'').trim());
  };
  for(let attempt=1;attempt<=3;attempt++){
    assertRunActive(token);
    if(attempt<3){
      const target={tabId};let attached=false;
      try{
        try{await chrome.debugger.attach(target,'1.3');attached=true;}
        catch(error){if(!/another debugger|already attached/i.test(String(error?.message||error)))throw error;}
        if(attached)await sleep(800);
        const fresh=await exec(tabId,pg_chatgptSnapshot,[],'MAIN');
        if(!fresh.send){
          if(await sent())return true;
          continue;
        }
        await flowCdpClick(tabId,fresh.send.x,fresh.send.y,true);
      }finally{if(attached)await chrome.debugger.detach(target).catch(()=>{});}
    } else {
      await exec(tabId,pg_chatgptClickSend,[],'MAIN').catch(()=>false);
    }
    for(let i=0;i<8;i++){await sleep(500);assertRunActive(token);if(await sent())return true;}
    if(typeof log==='function')log(`ChatGPT Send attempt ${attempt}/3 was not accepted; trying again.`);
  }
  return false;
}

function pg_chatgptFocusForTyping(prompt) {
  const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
  const editor=[...document.querySelectorAll('[contenteditable="true"][role="textbox"],#prompt-textarea,textarea')].filter(visible).sort((a,b)=>b.getBoundingClientRect().width-a.getBoundingClientRect().width)[0];
  if(!editor)return {ok:false,error:'ChatGPT composer disappeared before typing'};
  const normalize=s=>String(s||'').normalize('NFKC').replace(/\s+/g,' ').trim();
  const actual=normalize(editor.innerText||editor.value||'');
  if(actual&&!normalize(prompt).startsWith(actual))return {ok:false,error:'ChatGPT draft changed; nothing was overwritten or sent'};
  editor.focus();
  if(editor.tagName==='TEXTAREA')editor.select();
  else{const range=document.createRange();range.selectNodeContents(editor);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);}
  return {ok:true};
}
async function chatgptWaitForSend(tabId,prompt,token,timeoutMs=20000,retype=null) {
  const normalize=text=>String(text||'').normalize('NFKC').replace(/\s+/g,' ').trim();
  const wanted=normalize(prompt),started=Date.now(),until=started+timeoutMs;
  let snap,retyped=false;
  while(true){
    assertRunActive(token);
    snap=await exec(tabId,pg_chatgptSnapshot,[],'MAIN');
    // A visible editor can precede ChatGPT's hydration and enabled Send button.
    // Verify the entire draft: a wrapper or a collapsed-prefix match is unsafe here.
    const complete=typeof snap?.editorText==='string'&&normalize(snap.editorText)===wanted;
    if(complete&&snap.send&&!snap.busy)return snap;
    if(snap?.limit)throw Object.assign(Error('ChatGPT usage or upload limit reached. Prompt was not sent.'),{chatgptLimit:true});
    const actual=normalize(snap?.editorText);
    if(!complete&&!snap?.busy&&!retyped&&retype&&Date.now()-started>=3000&&(!actual||wanted.startsWith(actual))){
      retyped=true;await retype();continue;
    }
    if(Date.now()>=until)break;
    await sleep(500);
  }
  if(normalize(snap?.editorText)!==wanted)throw Error('ChatGPT did not retain the complete prompt. Nothing was sent; wait for the page to finish loading, then Retry.');
  throw Error('ChatGPT Send did not become ready within 20 seconds. Nothing was sent; check uploads and account limits.');
}

// Files this extension attached in a ChatGPT tab and has not sent yet: {tabId, count, at}. Kept in storage so it survives
// a panel reopen (which empties the image library). Call with no argument to read, null to clear, an object to set.
async function chatgptPendingUpload(value) {
  try {
    if (value === undefined) return (await chrome.storage.local.get('chatgptPendingUpload')).chatgptPendingUpload || null;
    if (value === null) await chrome.storage.local.remove('chatgptPendingUpload');
    else await chrome.storage.local.set({chatgptPendingUpload: value});
  } catch { /* storage unavailable: fall back to matching file names only */ }
  return null;
}

async function runChatgptPrompt(item, slot, token) {
  const policyInput=JSON.stringify([settings.mode,item.generationText || item.text]);
  if(!item.attempts || item._chatgptPolicyInput!==policyInput){item.chatgptFlagAttempts=0;item._chatgptPolicyInput=policyInput;}
  item.platform='chatgpt';item.progressPercent=0;
  item.status='running';item.attempts=(item.attempts||0)+1;item.retryAt=null;renderQueue();
  let tab, composerDrafted=false, promptSent=false;
  try {
    assertRunActive(token);
    // Save-only retries belong to the exact prompt/mode that produced this result.
    const cached = item.chatgptResult;
    if (cached && ((cached.prompt !== undefined && cached.prompt !== chatgptPrompt(item)) || (cached.mode !== undefined && cached.mode !== settings.mode))) {
      delete item.chatgptResult;
      log(`${item.id}: prompt or mode changed; previous chatgpt result will not be reused.`);
    }
    if(item.chatgptResult) {
      // The finished image lives in a tab that may have been closed since: then generate again instead of failing forever.
      tab=await chatgptExactTab(item.chatgptResult.tabId).catch(()=>null);
      if(!tab){log(`${item.id}: the ChatGPT tab holding the finished image was closed; generating this prompt again.`);delete item.chatgptResult;}
    }
    if(!item.chatgptResult) {
      tab=await getChatgptTaskTab(slot);
      log(`${item.id}: using the task ChatGPT tab and its current conversation.`);
      // ChatGPT can report "loading" for minutes while its message box already works (owner 2026-10-28: the first prompt
      // sat 1.5 min after "using the task ChatGPT tab"; Stop + Run sent it at once). Wait 15 s at most, then use the composer.
      await waitForTabComplete(tab.id,15000).catch(e=>{if(/cancelled/i.test(e.message))throw e;log(`${item.id}: the ChatGPT tab still reports loading; continuing as soon as its message box is ready.`);});
      await sleep(1800);assertRunActive(token);await zoomChatgptTab(tab.id);
      let snap=await exec(tab.id,pg_chatgptSnapshot,[],'MAIN');
      for(const until=Date.now()+20000;!snap?.editor&&Date.now()<until;){await sleep(1000);assertRunActive(token);snap=await exec(tab.id,pg_chatgptSnapshot,[],'MAIN');}
      if(!snap?.editor)throw Error('ChatGPT composer not found. Sign in to ChatGPT and select Chat mode, then retry.');
      if(snap.busy){
        // Something is still generating in this chat (e.g. a reply that is slow to stop): wait for it instead of failing every
        // remaining prompt one after another. Still busy after 2 minutes = a soft retry later, never an immediate error.
        const busySince=Date.now();
        while(snap.busy&&Date.now()-busySince<120000){item.detail='waiting for ChatGPT to finish its current reply';renderQueue();await sleep(3000);assertRunActive(token);snap=await exec(tab.id,pg_chatgptSnapshot,[],'MAIN');}
        if(snap.busy)throw Object.assign(Error('ChatGPT is still generating a previous reply; this prompt will be retried'),{chatgptBusy:true});
        log(`${item.id}: ChatGPT finished its previous reply after ${Math.round((Date.now()-busySince)/1000)}s; continuing.`);
      }
      // Leftover from our own failed send — this prompt OR any other prompt of this queue (user report: p001's text stayed in
      // the box and p002–p010 each failed in 2 s): safe to clear. Anything else is the user's own draft: never overwritten,
      // and the queue pauses once with the fix instead of failing every remaining prompt.
      const draftOwner=String(snap.editorText || '').trim() ? [item,...(typeof queue!=='undefined'&&Array.isArray(queue)?queue:[])].find(q=>q?.text&&chatgptPromptMatches(snap.editorText,chatgptPrompt(q))) : null;
      if(draftOwner) {
        await exec(tab.id,pg_chatgptClearComposer,[],'MAIN').catch(()=>{});
        log(`${item.id}: cleared ${draftOwner===item?"this prompt's":`${draftOwner.id}'s`} unsent draft from an earlier failed send.`);
        snap=await exec(tab.id,pg_chatgptSnapshot,[],'MAIN');
      }
      if(String(snap.editorText || '').trim())throw Object.assign(Error('ChatGPT\'s message box has text this extension did not write, so nothing was sent. Open the ChatGPT tab, send or delete that text, then press Start again. It was not changed.'),{chatgptForeignDraft:true});
      const refs=settings.mode==='image-to-image'?imagesForItem(item):[];
      if(settings.mode==='image-to-image' && !refs.length)throw Error('No reference images selected for ChatGPT image-to-image. Add the required images or correct their filenames before retrying.');
      if(settings.mode==='image-to-image' && item.referenceNames?.length) {
        const missing=item.referenceNames.filter(name=>!refs.some(img=>img.name.toLowerCase()===name.toLowerCase()));
        if(missing.length)throw Error('Missing required ChatGPT reference images: '+missing.join(', '));
      }
      // Attachments still in the box (e.g. Stop pressed during an upload) would be sent again together with the new ones.
      const leftovers=await exec(tab.id,pg_chatgptComposerAttachments,[],'MAIN').catch(()=>null);
      if(leftovers?.count) {
        const library=new Set((typeof images!=='undefined'?images:[]).map(img=>String(img.name).toLowerCase()));
        // Ours when the names match the image library, or when this extension attached at least that many files in this
        // same tab and never sent them (remembered across panel reopen, which empties the library; also covers ChatGPT
        // labelling chips generically, e.g. "Remove file 1", where no filename can be matched).
        const pending=await chatgptPendingUpload();
        const ours=leftovers.names.every(name=>library.has(name.toLowerCase()))
          || (!!pending && pending.tabId===tab.id && leftovers.count<=pending.count && Date.now()-pending.at<12*3600000);
        if(!ours)throw Object.assign(Error(`ChatGPT's message box already has ${leftovers.count} attached file(s) that this extension did not add, so nothing was sent. Open the ChatGPT tab, remove those files (×) from the message box, then press Start again. They were not changed.`),{chatgptForeignAttachments:true});
        await exec(tab.id,pg_chatgptClearComposer,[],'MAIN').catch(()=>{});
        const remaining=await exec(tab.id,pg_chatgptComposerAttachments,[],'MAIN').catch(()=>null);
        if(remaining?.count)throw Error('Could not remove the earlier reference attachments from the ChatGPT composer. Remove them, then press Retry.');
        log(`${item.id}: removed ${leftovers.count} leftover reference attachment(s) from an earlier stopped or failed attempt.`);
        await chatgptPendingUpload(null);
      }
      let uploadBaseline;
      let names=[];
      if(refs.length) {
        names=refs.map(img=>img.name);
        log(`${item.id}: ChatGPT required references: ${names.join(', ')}.`);
        item.detail=`uploading ${refs.length} ChatGPT reference image(s)`;renderQueue();
        const files=refs.map(img=>{const {b64,type}=dataUrlToB64(img.dataUrl);return {name:img.name,base64:b64,type};});
        uploadBaseline=await exec(tab.id,pg_chatgptUploadStatus,[names],'MAIN');
        composerDrafted=true;
        await chatgptPendingUpload({tabId:tab.id,count:files.length,at:Date.now()});
        const uploaded=await exec(tab.id,pg_chatgptUpload,[files],'MAIN');if(!uploaded?.ok)throw Error(uploaded?.error||'ChatGPT upload failed');
        log(`${item.id}: ChatGPT reference upload requested via ${uploaded.method || 'file input'}.`);
        const start=Date.now();let ready=false,pasteTried=uploaded.method==='composer paste';
        while(Date.now()-start<180000){
          assertRunActive(token);const status=await exec(tab.id,pg_chatgptUploadStatus,[names,uploadBaseline],'MAIN');
          if(status.error)throw Error(status.error);
          if(status.ready){ready=true;break;}
          if(!pasteTried && Date.now()-start>=8000 && !status.newPreviewCount && !status.found?.length && !status.pending){
            pasteTried=true;const pasted=await exec(tab.id,pg_chatgptUpload,[files,true],'MAIN');
            if(!pasted?.ok)throw Error(pasted?.error||'ChatGPT reference paste failed');
            log(`${item.id}: file input produced no attachment previews; trying composer paste once.`);
          }
          item.detail=`waiting for ChatGPT reference uploads (${status.found?.length || status.newPreviewCount || 0}/${names.length})`;renderQueue();
          await sleep(1000);
        }
        if(!ready)throw Error('ChatGPT references did not finish uploading. Check the attachment previews before retrying.');
        log(`${item.id}: ChatGPT reference uploads confirmed: ${names.join(', ')}.`);
      }
      snap=await exec(tab.id,pg_chatgptSnapshot,[],'MAIN');
      if(!snap.point)throw Error('ChatGPT composer disappeared');
      const target={tabId:tab.id};let attached=false;
      composerDrafted=true;
      try {
        // Same tolerance as the Flow paths: another session of ours may already be attached.
        try{await chrome.debugger.attach(target,'1.3');attached=true;}
        catch(error){if(!/another debugger|already attached/i.test(String(error?.message||error)))throw error;}
        // The debugging banner shifts the page: measure the composer again once it is showing.
        if(attached){await sleep(800);const moved=await exec(tab.id,pg_chatgptSnapshot,[],'MAIN');if(moved.point)snap=moved;}
        if(typeof cdpHideMini==='function')await cdpHideMini((method,params)=>chrome.debugger.sendCommand(target,method,params));
        await chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{type:'mousePressed',...snap.point,button:'left',clickCount:1});
        await chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{type:'mouseReleased',...snap.point,button:'left',clickCount:1});
        const focus=await exec(tab.id,pg_chatgptFocusForTyping,[chatgptPrompt(item)],'MAIN');
        if(focus?.ok===false)throw Error(focus.error);
        await chrome.debugger.sendCommand(target,'Input.insertText',{text:chatgptPrompt(item)});
      }finally{if(attached)await chrome.debugger.detach(target).catch(()=>{});}
      await sleep(500);assertRunActive(token);
      if(names.length){const status=await exec(tab.id,pg_chatgptUploadStatus,[names,uploadBaseline],'MAIN');if(!status.ready)throw Error(status.error||'ChatGPT reference attachments are no longer ready; prompt was not sent.');}
      item.detail='waiting for ChatGPT to accept the complete prompt';renderQueue();
      snap=await chatgptWaitForSend(tab.id,chatgptPrompt(item),token,20000,async()=>{
        let ownsDebugger=false;
        try{
          await chrome.debugger.attach(target,'1.3');ownsDebugger=true;
          assertRunActive(token);
          const focus=await exec(tab.id,pg_chatgptFocusForTyping,[chatgptPrompt(item)],'MAIN');
          if(!focus?.ok)throw Error(focus?.error||'ChatGPT composer is not ready for typing');
          await chrome.debugger.sendCommand(target,'Input.insertText',{text:chatgptPrompt(item)});
          log(`${item.id}: ChatGPT lost the initial draft while loading; retyped once before Send.`);
        }finally{if(ownsDebugger)await chrome.debugger.detach(target).catch(()=>{});}
      });
      const baseline=snap.sources,baseline_user_id=snap.latestUserId||'';
      const baselineAssistantCount=snap.assistantCount || 0;
      const sentOk=await chatgptSubmitPrompt(tab.id,snap,chatgptPrompt(item),token);
      if(!sentOk){
        await exec(tab.id,pg_chatgptClearComposer,[],'MAIN').catch(()=>{});
        throw Error('ChatGPT did not accept the Send click (page layout may have shifted). The draft was cleared; press Retry.');
      }
      promptSent=true;await chatgptPendingUpload(null);
      // The ID of the message just sent: this prompt's reply is the one after it, even when its text is collapsed.
      const sentUserId=await exec(tab.id,pg_chatgptSnapshot,[],'MAIN').then(x=>x?.latestUserId&&x.latestUserId!==baseline_user_id?x.latestUserId:'').catch(()=>'');   // the attached files went out with the prompt
      item.detail='generating image in ChatGPT';renderQueue();log(`${item.id}: ChatGPT image request submitted.`);
      const started=Date.now();let source='',stableAt=0,detectionLogged=false,stallLogged=false;
      // ChatGPT images finish in 1-3 min: give up after 5 min (or a shorter Max wait), unless ChatGPT is visibly still
      // generating — then the Max wait setting is the limit. A prompt ChatGPT silently dropped (no reply, not busy) is
      // checked once with a reload after 75 s and retried 45 s later, instead of waiting out the whole limit.
      const waitLimit=Math.min(settings.maxWaitMinutes,5)*60000,busyLimit=Math.max(waitLimit,settings.maxWaitMinutes*60000);
      let reloadedAt=0,heartbeatAt=started,boundUserCount=null,questionAt=0,textAt=0;
      while(Date.now()-started<busyLimit) {
        assertRunActive(token);await zoomChatgptTab(tab.id);snap=await exec(tab.id,pg_chatgptSnapshot,[],'MAIN');
        const boundReply=typeof snap.assistantAfterLatestUser==='boolean';
        const promptMatch=chatgptPromptMatches(snap.latestUserText,chatgptPrompt(item))||(!!sentUserId&&snap.latestUserId===sentUserId);
        const matchedNow=boundReply ? snap.assistantAfterLatestUser && promptMatch : (snap.assistantCount || 0)>baselineAssistantCount;
        // Once this prompt's reply is confirmed, ChatGPT may re-render or collapse the long user message so the text match
        // fails later (user log, Oct 2026: a finished image was ignored for 4+ minutes). Keep the binding while no new user
        // turn has been sent in this chat.
        if(matchedNow&&boundReply&&Number.isFinite(snap.userCount))boundUserCount=snap.userCount;
        const newReply=matchedNow||(boundReply&&boundUserCount!==null&&snap.userCount===boundUserCount&&(snap.assistantAfterLatestUser||(snap.replySources||[]).length>0));
        if(!detectionLogged && Date.now()-started>=15000){
          log(`${item.id}: ChatGPT detection: ${snap.userCount ?? '?'} user turn(s), ${snap.latestUserText?.length || 0} user-text characters, prompt match ${promptMatch}${sentUserId?' (message ID '+(snap.latestUserId===sentUserId?'same':'changed')+')':snap.latestUserId?' (message ID did not change after send)':' (no message ID on page)'}, reply after user ${!!snap.assistantAfterLatestUser}, ${snap.replySources?.length || 0} current image(s), busy ${!!snap.busy}, flagged ${!!snap.denied}, failed ${!!snap.failed}.`);
          detectionLogged=true;
        }
        if(!stallLogged && Date.now()-started>=90000){stallLogged=true;log(`${item.id}: ChatGPT still waiting after 90s: ${JSON.stringify(snap.diag||{})}, ${snap.replySources?.length || 0} current image(s), busy ${!!snap.busy}.`);}
        const conversationReady=await refreshChatgptTaskTab(tab.id,{userText:snap.latestUserText,prompt:chatgptPrompt(item),sentAt:started,idMatch:!!sentUserId&&snap.latestUserId===sentUserId});
        if(conversationReady===false){item.detail='checking the submitted prompt after ChatGPT updated its URL';renderQueue();await sleep(500);continue;}
        const waited=Date.now()-started,noReply=!newReply&&!snap.busy&&!(snap.replySources||[]).length;
        if(Date.now()-heartbeatAt>=30000){heartbeatAt=Date.now();log(`${item.id}: still waiting for ChatGPT (${Math.round(waited/1000)}s): reply started ${!!newReply}, prompt match ${!!promptMatch}, busy ${!!snap.busy}, ${snap.replySources?.length || 0} image(s).`);}
        if(noReply&&!reloadedAt&&waited>=75000){
          log(`${item.id}: ChatGPT has not started a reply after ${Math.round(waited/1000)}s — reloading the conversation once to check.`);
          item.detail='ChatGPT has not replied — reloading the conversation to check';renderQueue();
          reloadedAt=Date.now();await chrome.tabs.reload(tab.id);await waitForTabComplete(tab.id);await sleep(2500);assertRunActive(token);continue;
        }
        if(noReply&&reloadedAt&&Date.now()-reloadedAt>=45000)
          throw Object.assign(Error('ChatGPT did not respond to the prompt (no reply, also after a reload)'),{chatgptTimeout:true,chatgptNoReply:true});
        // 5 minutes is the limit whenever ChatGPT is not visibly generating (image or not); only a busy chat may use Max wait.
        if(waited>=waitLimit&&!snap.busy)break;
        if(newReply&&snap.limit)throw Object.assign(Error('ChatGPT usage or upload limit reached. Wait before resuming.'),{chatgptLimit:true});
        if(newReply&&snap.denied&&!snap.busy){if(typeof flashQueueRejection==='function')flashQueueRejection();throw Object.assign(Error('ChatGPT flagged this image request'),{chatgptPolicyRefusal:true});}
        // ChatGPT answered with a question and no image (owner 2026-10-24, storyboard sheet): retry after 10 s instead of
        // waiting out the 5-minute limit.
        if(newReply&&snap.question&&!snap.busy&&!(snap.replySources||[]).length){questionAt=questionAt||Date.now();if(Date.now()-questionAt>=10000)throw Object.assign(Error('ChatGPT asked a question instead of making the image'),{chatgptGenerationFailed:true,chatgptAskedQuestion:true});}else questionAt=0;
        // A finished text-only answer (no image, not generating) for 30 s: say what ChatGPT wrote instead of waiting 5 minutes.
        if(newReply&&snap.textReply&&!snap.busy&&!snap.question&&!snap.failed&&!snap.denied&&!(snap.replySources||[]).length){textAt=textAt||Date.now();if(Date.now()-textAt>=30000)throw Object.assign(Error('ChatGPT answered with text instead of an image: "'+String(snap.text||'').replace(/\s+/g,' ').trim().slice(0,200)+'"'),{chatgptGenerationFailed:true,chatgptTextReply:true});}else textAt=0;
        if(newReply&&snap.failed&&!snap.busy)throw Object.assign(Error('ChatGPT image generation failed. Retry this prompt; no previous image was downloaded.'),{chatgptGenerationFailed:true});
        const resultSources=boundReply?(snap.replySources || []):snap.sources;
        const fresh=boundReply&&!newReply?[]:resultSources.filter(src=>!baseline.includes(src));
        if(fresh.length&&!snap.busy){if(source!==fresh[0]){source=fresh[0];stableAt=Date.now();}if(Date.now()-stableAt>=4000)break;}else{source='';stableAt=0;}
        item.progressPercent = Number.isFinite(snap.progressPercent) ? Math.max(item.progressPercent,Math.min(95,Math.round(snap.progressPercent*0.95))) : item.progressPercent;
        item.detail = source ? 'ChatGPT image finished — confirming before download' : Number.isFinite(item.progressPercent) ? `generating ChatGPT image (${item.progressPercent}% overall)` : fresh.length ? 'waiting for ChatGPT image to finish' : 'waiting for generated ChatGPT image';renderQueue();
        await sleep(2000);
      }
      if(!source||!stableAt||Date.now()-stableAt<4000){log(`${item.id}: ChatGPT timeout state: ${JSON.stringify(snap?.diag||{})}, assistant turns ${snap?.assistantCount}, sources ${snap?.sources?.length}, reply after user ${!!snap?.assistantAfterLatestUser}, busy ${!!snap?.busy}.`);
        // Our own generation is still running: stop it, so the next prompt does not find ChatGPT busy.
        if(snap?.busy){await exec(tab.id,pg_chatgptCancel,[],'MAIN').catch(()=>{});log(`${item.id}: stopped the unfinished ChatGPT generation after the wait limit.`);}
        throw Object.assign(Error(`Timed out waiting for a completed ChatGPT image (${Math.round((Date.now()-started)/60000)} min)`),{chatgptTimeout:true});}
      item.chatgptResult={tabId:tab.id,src:source,prompt:chatgptPrompt(item),mode:settings.mode};
    }
    assertRunActive(token);
    // Auto download off (Settings → Output): the image stays in the ChatGPT conversation.
    if(typeof autoDownloadOff==='function'&&autoDownloadOff('image',item)){finishWithoutDownload(item,'ChatGPT','image');return;}
    item.progressPercent=97;item.detail='downloading ChatGPT image (97%)';renderQueue();
    const buf=await downloadMediaBuffer(tab.id,{src:item.chatgptResult.src,host:'ChatGPT'},item.id);
    assertRunActive(token);
    if(!P().bufferHasImageSignature(buf))throw Error('ChatGPT download did not contain a supported image');
    item.progressPercent=99;item.detail='saving ChatGPT image (99%)';renderQueue();
    const saved=await saveOutput(item,buf,guessImageExt(buf,item.chatgptResult.src),typeof platformFileName==='function'?platformFileName(item.chatgptResult.src):'');
    item.progressPercent=100;item.status='done';item.outputName=saved.name;item.detail=`saved ${saved.name} → ${saved.where}`;log(`${item.id}: ${item.detail}`);
  }catch(e){
    if(tab&&!item.chatgptResult)await refreshChatgptTaskTab(tab.id).catch(()=>{});
    // Files someone else attached block every prompt the same way: pause once with the fix instead of failing the list.
    if(e.chatgptForeignAttachments){stopRequested=true;if(typeof queueStopReason!=='undefined')queueStopReason='ChatGPT message box has attached files to remove';}
    if(e.chatgptForeignDraft){stopRequested=true;if(typeof queueStopReason!=='undefined')queueStopReason='ChatGPT message box has text to send or delete';}
    if(e.chatgptConversationChanged){stopRequested=true;if(typeof queueStopReason!=='undefined')queueStopReason='ChatGPT conversation verification needs attention';}
    // A usage limit pauses the queue with its reason; it is not a user cancel.
    if(e.chatgptLimit){stopRequested=true;if(typeof queueStopReason!=='undefined')queueStopReason='ChatGPT usage or upload limit reached';}
    const cancelled=stopRequested||token!==runToken;
    item.status=cancelled?'pending':'error';item.detail=cancelled?'cancelled — ready to resume':String(e.message||e);item.retryAt=null;
    if(e.chatgptConversationChanged||e.chatgptLimit||e.chatgptForeignAttachments||e.chatgptForeignDraft)item.detail=e.message;
    if(!cancelled && e.chatgptPolicyRefusal) {
      item.chatgptFlagAttempts=(item.chatgptFlagAttempts || 0)+1;
      const limit=Number.isFinite(settings.maxAttempts)?Math.max(1,Math.min(10,Math.round(settings.maxAttempts))):3;
      if(item.chatgptFlagAttempts<limit) {
        const delay=Number.isFinite(settings.retryDelaySeconds)?settings.retryDelaySeconds:5;
        item.status='pending';item.retryAt=Date.now()+delay*1000;
        item.detail=`ChatGPT flagged attempt ${item.chatgptFlagAttempts}/${limit} — retrying the same prompt in ${delay}s before the next prompt`;
      } else item.detail=`ChatGPT flagged all ${limit} attempts — retry limit reached; continuing to the next prompt`;
    }
    // A storyboard sheet that ChatGPT answers with text is not retried: the same 4-scene text gets the same answer, and its
    // scenes are made as single images instead (AI Story after the run, manual queues at once).
    if(!cancelled && (e.chatgptGenerationFailed||e.chatgptTimeout||e.chatgptBusy)) {
      // ChatGPT's own "error on my side", a generation that ran past the wait limit, or a chat still busy with an earlier
      // reply are usually temporary: retry the same prompt up to the attempt limit (a busy chat waits longer).
      item.chatgptErrorAttempts=(item.chatgptErrorAttempts || 0)+1;
      const limit=Number.isFinite(settings.maxAttempts)?Math.max(1,Math.min(10,Math.round(settings.maxAttempts))):3;
      const what=e.chatgptNoReply?'did not respond':e.chatgptTimeout?'timed out':e.chatgptBusy?'ChatGPT busy':e.chatgptAskedQuestion?'asked a question instead of making the image':'image error';
      if(item.chatgptErrorAttempts<limit) {
        const delay=(Number.isFinite(settings.retryDelaySeconds)?settings.retryDelaySeconds:5)*(e.chatgptBusy?6:1);
        item.status='pending';item.retryAt=Date.now()+delay*1000;
        item.detail=`ChatGPT ${what} — attempt ${item.chatgptErrorAttempts}/${limit}, retrying the same prompt in ${delay}s`;
      } else item.detail=`ChatGPT ${e.chatgptNoReply?'did not respond':e.chatgptTimeout?'timed out':e.chatgptBusy?'stayed busy':'image generation failed'} on all ${limit} attempts — press Retry to try again`;
      if(e.chatgptTextReply&&(item.builderSheetIds?.length||item.manualSheetIds?.length)){item.status='error';item.retryAt=null;item.detail=`${e.message} — this storyboard sheet's scenes are made as single images instead`;}
    }
    // Stop or a failure before Send: remove the references/text this attempt put in the box, so the next attempt starts clean.
    if(composerDrafted&&!promptSent&&tab)await exec(tab.id,pg_chatgptClearComposer,[],'MAIN').catch(()=>{});
    if(cancelled&&tab&&!item.chatgptResult&&!e.chatgptConversationChanged)await exec(tab.id,pg_chatgptCancel,[],'MAIN').catch(()=>{});
    log(`${item.id}: ChatGPT ${item.detail}`);
  }finally{renderQueue();schedulePersist();}
}
