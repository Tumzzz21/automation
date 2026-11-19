// Original DOM-only driver. The caller pins every operation to one project and run.
export async function motionPage({action,runId,expectedUrl,...args}) {
  const fail=error=>({ok:false,error});
  if(location.href!==expectedUrl)return fail('The selected Flow project changed. Return to it before continuing.');
  const visible=e=>!!e?.getClientRects().length && getComputedStyle(e).visibility!=='hidden';
  const buttons=()=>[...document.querySelectorAll('button')].filter(visible);
  const label=e=>{if(e.getAttribute('aria-label'))return e.getAttribute('aria-label');const copy=e.cloneNode(true);copy.querySelectorAll('[aria-hidden=true],mat-icon,svg').forEach(node=>node.remove());return copy.textContent.replace(/\s+/g,' ').trim();};
  const button=name=>buttons().find(e=>label(e)===name);
  const clickPoint=element=>{element.scrollIntoView({block:'nearest',inline:'nearest'});const rect=element.getBoundingClientRect();return {ok:true,ready:false,click:{x:rect.left+rect.width/2,y:rect.top+rect.height/2}};};
  const editor=()=>[...document.querySelectorAll('[contenteditable=true],textarea')].find(e=>visible(e)&&e.getAttribute('aria-label')==='What do you want to create?');
  const composer=()=>editor()?.closest('flow-base-prompt-box,.base-prompt-box');
  const text=()=>editor()?.value??editor()?.innerText??'';
  // Flow's contenteditable serializes visual line breaks as extra newlines.
  // Compare all words/punctuation exactly while ignoring layout whitespace.
  // Flow puts a space after an @ mention chip, so a space before punctuation is ignored too.
  const promptText=value=>String(value??'').replace(/\s+/g,' ').replace(/ ([.,;:!?])/g,'$1').trim();
  const promptMatches=()=>promptText(text())===promptText(args.prompt);
  const stateKey='__oxMotionNativeLab';
  // Flow's refusals (owner 2026-11-12): on the result tile, or only as a pop-up when no tile is made. Same sentences the
  // main engine reads (summarizeFlowFailure in control.js).
  const REFUSAL=/violat\w* (?:our )?polic|might violate|real people|unusual activity|(?:could ?n.t|could not|unable to|can.t) (?:generate|make|create)|something went wrong|hard time fulfilling|try a different prompt|(?:encountered|ran into) an error|generation failed|failed/i;
  const alertTexts=()=>[...document.querySelectorAll('[role="alert"],[role="status"],mat-snack-bar-container,.mat-mdc-snack-bar-container,[aria-live="assertive"]')].filter(visible).map(e=>(e.innerText||e.textContent||'').replace(/\s+/g,' ').trim()).filter(Boolean);
  // A tile Flow is still making: a short text with a percentage ("37%", "Generating 37%"). Owner runs 2026-11-13: our
  // prompt says "100% match to the attached character", and a finished tile showing that prompt read as "still
  // generating" forever; a rule that needed the percentage alone then missed Flow's progress and the result waited 5 min.
  const rendering=e=>!!e.querySelector('flow-pending-tile')||[e,...e.querySelectorAll('*')].some(x=>{const t=(x.innerText||'').trim();return t.length<=40&&/\b\d{1,3}\s*%/.test(t);});
  // A tile's media: the Flow id anywhere in a picture/video link (not only /image/<id>: Flow's thumbnails use other links
  // too, owner run 2026-11-13), else the https link itself.
  const assetsOf=tile=>[...tile.querySelectorAll('img,video,source')].map(e=>{const s=String(e.currentSrc||e.src||'');
    return s.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1]?.toLowerCase()||(/^https:/.test(s)?s.split('#')[0]:'');}).filter(Boolean);
  // Every result Motion already took on this page. Owner run 2026-11-13: Flow redrew piece 1's finished tile after piece
  // 2's Generate, and piece 2 took piece 1's video while its own was at 9%. A taken result is never a later piece's.
  const taken=window.__oxMotionTaken||(window.__oxMotionTaken=new Set());
  const take=tile=>{for(const id of assetsOf(tile))taken.add(id);};
  // Motion Studio pieces share one Flow project: before each piece the composer is emptied with Flow's own
  // Clear prompt button (text and reference chips), so the previous piece's references are never sent again.
  // Videos Flow is still making in this project (owner run 2026-11-12: a second piece sent while an earlier one was
  // still rendering made two "%" tiles, and Motion could not tell which was its own). Motion waits until there are none,
  // like the main engine, which never sends while Flow already has a rendering video.
  if(action==='busy'){
    const n=[...document.querySelectorAll('flow-video-tile')].filter(rendering).length;
    return {ok:true,busy:n};
  }
  // A new send for a piece the panel is making again (↻, or Continue after a refused/unclear piece): an older send this
  // page still remembers is no longer awaited by the panel, so it is forgotten (owner run 2026-11-12: "A previous
  // submission is unresolved" until the Flow tab was reloaded). A run being recovered never calls this.
  if(action==='release'){const old=window[stateKey];if(old&&old.runId!==runId)delete window[stateKey];return {ok:true,released:!!old&&old.runId!==runId};}
  if(action==='clearDraft'){
    if(window[stateKey]?.dispatched)return fail('A previous submission is unresolved. Recover its result instead of generating again.');
    if(!editor())return {ok:true,clean:false,waiting:'Waiting for Flow to finish loading.'};
    const chips=composer()?.querySelectorAll('img,video').length||0;
    if(!text().trim()&&!chips)return {ok:true,clean:true};
    const clear=button('Clear prompt');if(!clear||clear.disabled)return fail('The Flow prompt box has old text or references and no Clear button. Clear it in Flow, then retry.');
    return {...clickPoint(clear),clean:false};
  }
  if(action==='init'){
    if(window[stateKey]?.dispatched)return fail('A previous submission is unresolved. Recover its result instead of generating again.');
    if(!editor())return fail('Wait for Flow to finish loading.');
    if(text().trim())return fail('The Flow composer contains text. Use an empty project/composer for this test.');
    const settingsOpen=[...document.querySelectorAll('.cdk-overlay-pane')].some(el=>visible(el)&&el.querySelector('[role=radio]'));
    if(settingsOpen){button('Settings trigger')?.click();await new Promise(r=>setTimeout(r,150));}
    const picker=button('Add ingredients to the prompt box');if(picker?.getAttribute('aria-expanded')==='true'){picker.click();await new Promise(r=>setTimeout(r,150));}
    // Owner run 2026-11-12: piece 2 stopped on "Close Flow menus or dialogs" after piece 1 had worked: any visible overlay
    // counted, even a tooltip from the finished tile or a "saved" pop-up. Those are ignored now; a leftover menu or popover
    // is closed with Escape; only a real dialog (which may need the member) stops the piece, and the message names it.
    const PASSIVE='[role=tooltip],.mat-mdc-tooltip,.mdc-tooltip,mat-tooltip-component,mat-snack-bar-container,.mat-mdc-snack-bar-container,[role=status],[role=alert]';
    const DIALOG='[role=dialog],[role=alertdialog],mat-dialog-container';
    // Owner run 2026-11-13: Flow's "Your video has been downloaded! Dismiss" notice stopped piece 2. A notice whose only
    // buttons are Dismiss/Close/OK (no menu item, option, field or switch) is information, not a dialog: ignored.
    const notice=e=>!e.matches(DIALOG)&&!e.querySelector(DIALOG+',[role=menuitem],[role=option],input,[role=radio],[role=checkbox],select,textarea')
      &&[...e.querySelectorAll('button')].every(b=>/^(dismiss|close|ok|okay|got it)$/i.test(label(b)));
    const open=()=>[...document.querySelectorAll(DIALOG+',.cdk-overlay-pane,[role=menu],[role=listbox]')].filter(visible)
      .filter(e=>!e.matches(PASSIVE)&&!e.closest(PASSIVE)&&!(e.querySelector(PASSIVE)&&!e.querySelector('button,[role=menuitem],[role=option],input,[role=radio]')))
      .filter(e=>!notice(e))
      .filter(e=>e.matches(DIALOG+',[role=menu],[role=listbox]')||e.querySelector('button,[role=menuitem],[role=option],input,[role=radio],'+DIALOG));
    for(let i=0;i<3&&open().length&&!open().some(e=>e.matches(DIALOG)||e.querySelector(DIALOG));i++){
      for(const t of [document.activeElement||document.body,document])t.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,bubbles:true,cancelable:true}));
      await new Promise(r=>setTimeout(r,300));
    }
    const left=open();
    if(left.length){const what=(left[0].innerText||left[0].getAttribute('aria-label')||'').replace(/\s+/g,' ').trim().slice(0,80);return fail('A Flow dialog or menu is still open'+(what?' ("'+what+'")':'')+'. Close it in the Flow tab, then press ↻ on this piece. Nothing was sent.');}
    window[stateKey]={runId,files:new Map(),baseline:[],dispatched:false,clickedResult:false};
    return {ok:true};
  }
  const state=window[stateKey];
  if(!state||state.runId!==runId)return fail('The page was refreshed or another run took control. Check Flow before starting a new run.');
  const mediaId=url=>{try{return new URL(url,location.href).pathname.match(/(?:image|video)\/([a-f0-9-]{36})/i)?.[1]||null;}catch{return null;}};
  const attachedIds=()=>new Set([...composer()?.querySelectorAll('img,video,source')||[]].map(e=>mediaId(e.currentSrc||e.src)).filter(Boolean));
  if(action==='resumePreparation'){
    if(state.dispatched)return fail('This run was already submitted. Use Recover result.');
    return {ok:true};
  }
  // A file the panel uploaded for real (owner 2026-11-12, "unusual activity"): real clicks on "+" and "Upload media" and
  // Chrome's own file picker, through the main engine's flowUploadReal. Registered here so the attach and submit checks know it.
  // After the upload Flow leaves the file selected in its open picker (checked live 2026-11-13); "attachment" below
  // adds it with "Add to prompt".
  if(action==='beforeUpload'){if(state.dispatched)return fail('Cannot upload after submission.');return {ok:true};}
  if(action==='registerUpload'){if(state.dispatched)return fail('Cannot upload after submission.');state.files.set(args.key,{name:args.name,type:args.type,sent:true,chunks:[],next:0,real:true,registeredAt:Date.now()});return {ok:true};}
  if(action==='fileStatus')return {ok:true,sent:state.files.get(args.key)?.sent===true};
  if(action==='settings'){
    if(state.dispatched)return fail('Already submitted.');
    const trigger=button('Settings trigger');if(!trigger)return fail('Flow settings control is missing.');trigger.click();
    await new Promise(r=>setTimeout(r,250));
    for(const name of ['Video','Ingredients']){
      const candidates=[...document.querySelectorAll('[role=radio],button')].filter(e=>visible(e)&&label(e)===name);
      const candidate=candidates[0];if(!candidate)return fail(`Flow does not offer ${name} in this model. Choose a compatible model before retrying.`);
      if(candidate.getAttribute('aria-checked')!=='true')candidate.click();
      await new Promise(r=>setTimeout(r,120));
    }
    const durationButton=[...document.querySelectorAll('[role=radio],button')].find(e=>visible(e)&&label(e)===args.duration+'s');
    if(durationButton){if(durationButton.getAttribute('aria-checked')!=='true')durationButton.click();await new Promise(r=>setTimeout(r,120));}
    else return {ok:true,setDuration:args.duration}; // The host verifies Flow's actual Length control and rendered value.
    const one=[...document.querySelectorAll('[role=radio],button')].find(e=>visible(e)&&label(e)==='x1');
    if(!one)return fail('Flow does not offer x1 in this model. No video was submitted.');
    if(one.getAttribute('aria-checked')!=='true')one.click();trigger.click();return {ok:true};
  }
  if(action==='closeSettings'){button('Settings trigger')?.click();return {ok:true};}
  if(action==='finishSettings'){
    const one=[...document.querySelectorAll('[role=radio],button')].find(e=>visible(e)&&label(e)==='x1');
    if(!one)return fail('Flow does not offer x1 in this model. No video was submitted.');
    if(one.getAttribute('aria-checked')!=='true')one.click();
    const trigger=button('Settings trigger');if(!trigger)return fail('Flow settings control is missing.');trigger.click();return {ok:true};
  }
  if(action==='chunk'){
    if(state.dispatched)return fail('Cannot upload after submission.');
    let file=state.files.get(args.key);if(!file){file={chunks:[],name:args.name,type:args.type,next:0};state.files.set(args.key,file);}
    if(file.next!==args.index)return fail('File transfer order changed.');
    const bytes=Uint8Array.from(atob(args.base64),c=>c.charCodeAt(0));file.chunks.push(bytes);file.next++;
    return {ok:true};
  }
  if(action==='upload'){
    const file=state.files.get(args.key);if(!file||file.sent)return fail('Upload is missing or was already attempted.');
    const item=new File(file.chunks,file.name,{type:file.type});if(item.size!==args.size)return fail('Transferred file size does not match.');
    file.sent=true;file.chunks=[];
    const transfer=new DataTransfer();transfer.items.add(item);
    const accepts=e=>!e.disabled&&(!e.accept||e.accept.split(',').some(value=>{const token=value.trim().toLowerCase();return token===file.type||token===file.type.split('/')[0]+'/*'||token.startsWith('.')&&file.name.toLowerCase().endsWith(token);}));
    let input=null;
    const plus=button('Add ingredients to the prompt box');if(!plus)return fail('Flow Ingredients picker is unavailable.');
    if(plus.getAttribute('aria-expanded')!=='true'){plus.click();await new Promise(r=>setTimeout(r,200));}
    const upload=button('Upload media');
    if(upload){
      // Intercept only the native file-input activation caused by this upload
      // button, supplying the already selected file instead of opening an OS picker.
      const capture=event=>{if(event.target instanceof HTMLInputElement&&event.target.type==='file'&&accepts(event.target)){event.preventDefault();input=event.target;}};
      document.addEventListener('click',capture,true);
      try{upload.click();for(let i=0;!input&&i<20;i++)await new Promise(r=>setTimeout(r,50));}
      finally{document.removeEventListener('click',capture,true);}
    }
    if(!input)return fail('Flow did not expose its native upload input. No generation was sent.');
    input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    return {ok:true};
  }
  if(action==='attachment'){
    // Flow can ask the member to agree to its terms for an uploaded video (owner live test 2026-11-12). That is the
    // member's own agreement: never clicked here. Report it, wait, and go on once the member has answered in Flow.
    const consent=[...document.querySelectorAll('[role=dialog],[role=alertdialog],.cdk-overlay-pane,mat-dialog-container')].filter(visible).find(d=>[...d.querySelectorAll('button')].some(b=>visible(b)&&/\bagree\b|\baccept\b/i.test(label(b))));
    if(consent)return {ok:true,ready:false,consent:true,waiting:'Flow asks you to confirm your rights to the uploaded video. In the Flow tab, click "I agree, do not show again" (or "I agree"); Motion goes on by itself.'};
    const root=composer();if(!root)return fail('Flow composer is unavailable.');
    const labels=[...root.querySelectorAll('[aria-label],[title],img')].flatMap(e=>[e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('alt')]).filter(Boolean);
    const file=[...state.files.values()].find(f=>f.name===args.name);
    const ids=attachedIds();
    const attached=file?.mediaId?ids.has(file.mediaId):labels.some(v=>v.includes(args.name))||root.innerText.includes(args.name);
    if(attached)return {ok:true,ready:true};
    const base=args.name.replace(/\.(mp4|mov|webm|m4v|png|jpe?g|webp|gif)$/i,'');
    const rows=[...document.querySelectorAll('flow-add-menu-asset-item')].filter(row=>{const title=row.querySelector('.asset-title');return visible(title)&&[args.name,base].includes(title.textContent.trim());});
    if(rows.length>1)return fail('Multiple uploaded references have the same name. No asset was selected.');
    // Flow's picker, checked live 2026-11-13: the row Flow has selected carries "asset-item-active" and the preview beside
    // the list shows that file ("Preview of <name>" picture, or the video); "Add to prompt" adds whichever row is selected
    // (greyed while Flow still processes a new upload). After an upload Flow does NOT put the file in the prompt box and
    // does not always select it: in a project with older files the earlier selection stays. So: our row, processed, made
    // the selected one with a real click (never clicking it once it is selected, that would unselect it), its preview
    // showing our file, then one real click on "Add to prompt". The chip then carries the same media id as the row.
    if(rows.length===1){
      const row=rows[0],id=[...row.querySelectorAll('img,video,source')].map(e=>mediaId(e.currentSrc||e.src)).find(Boolean);
      const kind=/\.(png|jpe?g|webp|gif)$/i.test(args.name)?'picture':'video';
      if(!id)return {ok:true,ready:false,waiting:'Flow is processing the uploaded '+kind+'…'};
      if(file)file.mediaId=id;
      if(ids.has(id))return {ok:true,ready:true};
      // The class sits on the row's wrapping button (role=option), checked live 2026-11-13.
      const active=!!(row.closest('.asset-item-active')||row.querySelector('.asset-item-active'));
      const add=button('Add to prompt');
      let pane=add;while(pane&&!pane.contains(row))pane=pane.parentElement;
      const previewIds=new Set([...(pane||document).querySelectorAll('img,video,source')].filter(e=>!e.closest('flow-add-menu-asset-item')&&!e.closest('flow-base-prompt-box,.base-prompt-box')).map(e=>mediaId(e.currentSrc||e.src)).filter(Boolean));
      const st=file||(state.loose||(state.loose={}));
      if(!active){
        if(st.rowClickedAt&&Date.now()-st.rowClickedAt<3000)return {ok:true,ready:false};
        if((st.rowClicks||0)>=3)return fail('Flow did not select the uploaded '+kind+' in its picker. No video was sent.');
        st.rowClicks=(st.rowClicks||0)+1;st.rowClickedAt=Date.now();st.addClickedAt=0;
        return clickPoint(row.querySelector('.asset-title')||row);
      }
      if(previewIds.size&&!previewIds.has(id))return {ok:true,ready:false,waiting:'Waiting for Flow to show the selected '+kind+'.'};
      if(!add||add.disabled)return {ok:true,ready:false,waiting:'Flow is processing the uploaded '+kind+'…'};
      if(st.addClickedAt&&Date.now()-st.addClickedAt<4000)return {ok:true,ready:false};
      if((st.addAttempts||0)>=2)return fail('Flow did not confirm Add to prompt after two clicks. No generation was sent.');
      st.addAttempts=(st.addAttempts||0)+1;st.addClickedAt=Date.now();return clickPoint(add);
    }
    // Our row is not in view: open the picker and search for the file by name (real click, then Chrome types).
    const plus=button('Add ingredients to the prompt box');if(!plus)return fail('Flow did not enter Ingredients mode.');
    if(plus.getAttribute('aria-expanded')!=='true'){if(args.realTyping)return clickPoint(plus);plus.click();return {ok:true,ready:false};}
    const search=[...document.querySelectorAll('input')].find(e=>visible(e)&&(e.getAttribute('aria-label')==='Search assets'||e.placeholder==='Search assets'));
    if(search&&search.value!==base&&args.realTyping){
      if(document.activeElement!==search)return clickPoint(search);
      return {ok:true,ready:false,typeText:{text:base,clear:!!search.value}};
    }
    if(search&&search.value!==base){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(search,base);search.dispatchEvent(new Event('input',{bubbles:true}));return {ok:true,ready:false};}
    return {ok:true,ready:false,waiting:file?.real?'Waiting for Flow to list the uploaded file…':undefined};
  }
  if(action==='closePicker'){
    const plus=button('Add ingredients to the prompt box');if(plus?.getAttribute('aria-expanded')==='true'){if(args.realTyping)return clickPoint(plus);plus.click();}return {ok:true};
  }
  if(action==='fill'){
    // Pictures named in the prompt (character, background, continuity frame) become Flow @ mentions (owner 2026-11-13).
    // Checked live 2026-11-13: typing "@" opens Flow's asset picker with the cursor in "Search assets"; a search keeps one
    // row selected; "Add to prompt" puts span.mention-chip[data-mention-id=<media id>] where the "@" was, attaches the
    // picture once (no second chip when already attached), and puts the cursor after the chip. A video picked this way
    // gets no chip in the text, so only pictures are mentioned. Every step is a real click or real typing.
    if(state.mention&&state.mention.prompt!==args.prompt)state.mention=null;
    const mentionPlan=()=>[...state.files.values()].filter(f=>f.mediaId&&/\.(png|jpe?g|webp|gif)$/i.test(f.name)&&args.prompt.includes(f.name))
      .map(f=>({name:f.name,id:String(f.mediaId).toLowerCase(),index:args.prompt.indexOf(f.name)})).sort((a,b)=>a.index-b.index);
    const mentionStep=()=>{
      const m=state.mention||(state.mention={prompt:args.prompt,plan:mentionPlan(),at:0,pos:0,step:'start',since:Date.now(),clicks:0});
      const box=editor();if(!box)return fail('Flow composer is missing.');
      const wait=w=>({ok:true,filled:false,mentioning:true,...(w?{waiting:w}:{})});
      const go=(step,extra)=>{m.step=step;m.since=Date.now();return {ok:true,filled:false,mentioning:true,...extra};};
      const late=ms=>Date.now()-m.since>ms;
      const cur=m.plan[m.at],kind='picture '+(/-([a-z]+)\.[a-z0-9]+$/i.exec(cur?.name||'')?.[1]||'');
      const inBox=()=>document.activeElement===box||box.contains(document.activeElement);
      const search=()=>{const e=document.activeElement;return !!e&&e.tagName==='INPUT'&&/search assets/i.test((e.getAttribute('aria-label')||'')+' '+(e.placeholder||''))&&visible(e);};
      if(m.step!=='start'&&!text().trim())return fail('Flow emptied its prompt box while Motion was typing. No video was sent.');
      if(m.step==='start'){
        if(!inBox()){if(m.clicks++>=4)return fail('Flow’s prompt box did not take the cursor. Click into it once, then retry. No video was sent.');return {...clickPoint(box),filled:false,mentioning:true};}
        // The text first, then "@" as its own typing with a space before it: Flow opens its @ list only for an "@"
        // typed alone (owner run 2026-11-13, "@ list did not open"; the main engine's flowInsertNativeReferences does
        // the same).
        const before=args.prompt.slice(m.pos,cur.index);
        if(before)return go('at',{typeText:{text:before,clear:false}});
        m.step='at';
      }
      if(m.step==='at'){
        if(!inBox()){if(m.clicks++>=4)return fail('Flow’s prompt box did not take the cursor. Click into it once, then retry. No video was sent.');return {...clickPoint(box),filled:false,mentioning:true};}
        return go('opening',{typeText:{text:(/\S$/.test(box.textContent||'')?' ':'')+'@',clear:false}});
      }
      if(m.step==='opening'){
        if(search())return go('searching',{typeText:{text:cur.name.replace(/\.(png|jpe?g|webp|gif)$/i,''),clear:false}});
        if(late(6000))return fail('Flow’s @ list did not open for the '+kind+'. No video was sent.');
        return wait('Opening Flow’s @ list…');
      }
      // In the @ list a real click on a row can put the chip in at once and close the list (main engine notes).
      const placed=()=>[...box.querySelectorAll('.mention-chip[data-mention-id]')].some(c=>c.getAttribute('data-mention-id').toLowerCase()===cur.id);
      if(m.step==='searching'&&placed())m.step='adding';
      if(m.step==='searching'){
        const base=cur.name.replace(/\.(png|jpe?g|webp|gif)$/i,'');
        const rows=[...document.querySelectorAll('flow-add-menu-asset-item')].filter(row=>{const t=row.querySelector('.asset-title');return visible(t)&&[cur.name,base].includes(t.textContent.trim());});
        const row=rows.find(r=>[...r.querySelectorAll('img,video,source')].some(e=>String(mediaId(e.currentSrc||e.src)||'').toLowerCase()===cur.id));
        if(!row){if(late(10000))return fail('The '+kind+' was not found in Flow’s @ list. No video was sent.');return wait('Finding the '+kind+' in Flow’s @ list…');}
        const active=!!(row.closest('.asset-item-active')||row.querySelector('.asset-item-active'));
        if(!active){
          if(m.rowAt&&Date.now()-m.rowAt<1500)return wait();
          if((m.rowClicks||0)>=3)return fail('Flow did not select the '+kind+' in its @ list. No video was sent.');
          m.rowClicks=(m.rowClicks||0)+1;m.rowAt=Date.now();return {...clickPoint(row.querySelector('.asset-title')||row),filled:false,mentioning:true};
        }
        const add=button('Add to prompt');if(!add||add.disabled){if(late(15000))return fail('Flow’s Add to prompt stayed unavailable for the '+kind+'. No video was sent.');return wait();}
        return go('adding',{...clickPoint(add),filled:false});
      }
      if(m.step==='adding'){
        const chip=[...box.querySelectorAll('.mention-chip[data-mention-id]')].find(c=>c.getAttribute('data-mention-id').toLowerCase()===cur.id);
        if(!chip||!inBox()){if(late(8000))return fail('Flow did not put the '+kind+' in the prompt as an @ mention. No video was sent.');return wait();}
        m.pos=cur.index+cur.name.length;m.at++;m.rowClicks=0;m.rowAt=0;
        if(m.at<m.plan.length)return go('start');
        m.done=true;state.promptTyped=true;
        return {ok:true,filled:false,mentioning:true,typeText:{text:args.prompt.slice(m.pos),clear:false}};
      }
      return fail('Motion lost its place while typing the prompt. No video was sent.');
    };
    // Off by default (owner 2026-11-13): in the owner's Flow the @ list did not open for Motion's typing and Flow dropped
    // the ": " before the "@". The character still reaches Flow as an ingredient through the "+" attach. Kept for later.
    if(args.realTyping&&args.mentions===true&&(state.mention?!state.mention.done:(!text().trim()&&mentionPlan().length)))return mentionStep();
    if(text().trim() && !promptMatches())return fail('The composer was changed. Existing text was preserved.');
    const input=editor();if(!input)return fail('Flow composer is missing.');
    if(args.realTyping&&!text().trim()){
      // Real typing (owner 2026-11-12): a real click into the empty box, then Chrome types the prompt. Typed once only.
      if(state.promptTyped)return fail('Flow did not take the typed prompt. Click into Flow’s prompt box once, then retry. No video was sent.');
      if(document.activeElement!==input&&!input.contains(document.activeElement))return {...clickPoint(input),filled:false};
      state.promptTyped=true;return {ok:true,filled:false,typeText:{text:args.prompt,clear:false}};
    }
    if(!args.realTyping){input.focus();if(!text().trim())document.execCommand('insertText',false,args.prompt);}
    for(let i=0;i<10&&!promptMatches();i++)await new Promise(r=>setTimeout(r,100));
    if(!promptMatches())return fail('Flow did not accept the entire prompt.');
    state.promptTyped=false;
    state.baseline=[...document.querySelectorAll('flow-video-tile')];state.baselineAssets=[...new Set(state.baseline.flatMap(assetsOf))];
    return {ok:true};
  }
  if(action==='submit'){
    if(state.dispatched)return fail('This run was already submitted.');
    if(!promptMatches())return fail('The prepared prompt changed before submission.');
    const root=composer();const labels=root&&[...root.querySelectorAll('[aria-label],[title],img')].flatMap(e=>[e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('alt')]).filter(Boolean);
    const ids=attachedIds();
    // A chip carries the same Flow media id as the picker row it was added from (checked live 2026-11-13).
    const files=[...state.files.values()];
    const present=file=>file.mediaId?ids.has(file.mediaId):labels.some(v=>v.includes(file.name))||root.innerText.includes(file.name);
    const missing=root?files.filter(f=>!present(f)):files;
    const lostMention=(state.mention?.done&&state.mention.prompt===args.prompt?state.mention.plan:[]).filter(p=>![...(editor()?.querySelectorAll('.mention-chip[data-mention-id]')||[])].some(c=>c.getAttribute('data-mention-id').toLowerCase()===p.id));
    if(lostMention.length)return fail('An @ mention was removed from Flow’s prompt before submission ('+lostMention.map(p=>/-([a-z]+)\.[a-z0-9]+$/i.exec(p.name)?.[1]||p.name).join(', ')+'). No video was sent.');
    if(missing.length)return fail('A required reference was removed before submission ('+missing.map(f=>/-([a-z]+)\.[a-z0-9]+$/i.exec(f.name)?.[1]||f.name).join(', ')+' not in Flow’s prompt box). No video was sent.');
    const start=button('Start generation');if(!start||start.disabled)return fail('Flow Generate is unavailable. Check model and references.');
    // Mark before click. A timeout must never cause an automatic second submission.
    state.dispatched=true;state.submittedAt=Date.now();state.alertBaseline=alertTexts();state.sawPending=false;state.claimed=null;state.firstSeen=new Map();return clickPoint(start);
  }
  // The runner took a result named by Flow's reply (no page check): remember its media too.
  if(action==='taken'){for(const s of args.media||[]){const id=String(s).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1]?.toLowerCase();if(id)taken.add(id);}return {ok:true,count:taken.size};}
  if(action==='poll'){
    if(!state.dispatched)return fail('No submission recorded on this page.');
    // Never click a result: Flow opens its editor page on click (owner live test 2026-11-12) and the project URL changes.
    const old=new Set(state.baselineAssets||[]);
    // Flow's grid also lists uploaded clips as video tiles (owner live test 2026-11-12: this run's and an earlier run's
    // oxm-… source clips). Our uploads are never results: skip their Flow ids and anything named oxm-<run>.
    const uploaded=new Set([...state.files.values()].map(f=>String(f.mediaId||'').toLowerCase()).filter(Boolean));
    const ours=e=>assetsOf(e).some(id=>uploaded.has(id))||/\boxm-[0-9a-f]{8}/i.test(e.innerText||e.textContent||'');
    let fresh=[...document.querySelectorAll('flow-video-tile')].filter(e=>!state.baseline.includes(e)&&!assetsOf(e).some(id=>old.has(id)||taken.has(id))&&!ours(e));
    // A refusal pop-up that appeared after our Generate (Flow may not make a tile at all).
    const before=state.alertBaseline||[],seen=new Map();
    for(const t of alertTexts()){seen.set(t,(seen.get(t)||0)+1);if(REFUSAL.test(t)&&seen.get(t)>before.filter(b=>b===t).length)return fail(t.slice(0,500));}
    const refused=fresh.find(e=>REFUSAL.test(e.innerText||''));if(refused)return fail((refused.innerText||'').slice(0,500));
    // Which tile is ours (owner runs 2026-11-12, same rule as the main engine's pg_flowStartResultTracking): the new
    // tile that shows progress ("%" or Flow's pending overlay) is claimed and followed until it is finished. Before
    // that nothing counts as a result: an older finished tile Flow redraws right after Generate (piece 2 got another
    // video) and Flow's blank new tile before its "%" (it was written off and the run never ended) are both skipped,
    // never ignored for good. Only if no progress was ever seen, a single new finished tile that first showed up 20 s
    // or more after Generate may count, after 3 minutes.
    const pending=rendering;
    const firstSeen=state.firstSeen||(state.firstSeen=new Map());
    for(const e of fresh)if(!firstSeen.has(e))firstSeen.set(e,Date.now());
    if(state.claimed&&!state.claimed.isConnected){
      // Flow re-created our tile: take it back only when exactly one new tile is in progress or carries our title.
      const back=fresh.filter(pending);
      state.claimed=back.length===1?back[0]:null;
      if(!state.claimed&&!back.length){const named=fresh.filter(e=>/reference.video/i.test(e.innerText||'')&&(firstSeen.get(e)||0)-(state.submittedAt||0)>=20000);if(named.length===1)state.claimed=named[0];}
      if(!state.claimed)state.lostClaim=true;
    }
    if(!state.claimed){
      let running=fresh.filter(pending);
      // Owner run 2026-11-12: Flow also shows our just-uploaded clip as a "processing" tile before its name appears. Our
      // generation's tile carries the prompt's first words ("REFERENCE-VIDEO MOTION STUDY"), so that one is preferred.
      if(running.length>1){const named=running.filter(e=>/reference.?video/i.test(e.innerText||e.textContent||''));if(named.length===1)running=named;}
      if(running.length>1)return fail('More than one new video is being made in this Flow project. Check Flow manually; no result was selected.');
      if(running.length===1){state.claimed=running[0];state.sawPending=true;}
    }
    let tile=state.claimed;
    if(!tile){
      if(Date.now()-(state.submittedAt||0)<180000)return {ok:true,ready:false};
      const late=fresh.filter(e=>!pending(e)&&(firstSeen.get(e)||0)-(state.submittedAt||0)>=20000);
      if(late.length>1)return fail('More than one new video appeared. Check Flow manually; no result was selected.');
      tile=late[0];if(!tile)return {ok:true,ready:false};
    }
    if(pending(tile))return {ok:true,ready:false};
    const video=tile.querySelector('video');let url=video?.currentSrc||video?.src;
    // A finished video is a poster (/image/<id>) until a real mouse rests on it, which mounts /video/<id>.
    const poster=[...tile.querySelectorAll('img')].map(i=>i.currentSrc||i.src).find(src=>/\/image\/[0-9a-f-]{36}/i.test(src));
    // Motion Studio downloads through Flow's own Download menu (main engine): it only needs this tile's sources.
    // Any picture counts (owner live test 2026-11-12: a finished "Reference video" tile stayed "Generating" because its
    // thumbnail was not an /image/<id> link); the tile is already past the progress check above.
    const pictures=[...tile.querySelectorAll('img')].map(i=>i.currentSrc||i.src).filter(src=>/^(https:|blob:)/.test(src||''));
    if(args.sourcesOnly&&(poster||url||pictures.length)){take(tile);return {ok:true,ready:true,url:url||null,posters:pictures};}
    if(!url&&poster){
      state.hovers=(state.hovers||0)+1;
      if(state.hovers<=4){const r=tile.getBoundingClientRect();if(r.width&&r.height){tile.scrollIntoView({block:'nearest'});const b=tile.getBoundingClientRect();return {ok:true,ready:false,hover:{x:b.left+b.width/2,y:b.top+b.height/2}};}}
      else url=poster.replace(/\/image\/([0-9a-f-]{36})/i,'/video/$1');
    }
    if(!url)return {ok:true,ready:false};
    if(!/^(https:|blob:)/.test(url))return fail('The result has no downloadable media URL.');
    take(tile);state.resultUrl=url;return {ok:true,ready:true,url};
  }
  if(action==='fetchResult'){
    if(!state.resultUrl)return fail('No confirmed result URL.');
    let response;try{response=await fetch(state.resultUrl,{credentials:'include'});}catch(e){return fail('Could not read the generated clip ('+(e?.message||e)+').');}if(!response.ok)return fail('Could not read the generated clip (HTTP '+response.status+').');
    const blob=await response.blob();if(blob.size>80*1024*1024||!blob.type.startsWith('video/'))return fail('The generated media is not a supported video under 80 MB.');
    state.resultBytes=new Uint8Array(await blob.arrayBuffer());return {ok:true,size:blob.size,type:blob.type};
  }
  if(action==='resultChunk'){
    if(!state.resultBytes)return fail('Result data expired.');
    const part=state.resultBytes.subarray(args.offset,args.offset+262144);let binary='';for(let i=0;i<part.length;i+=8192)binary+=String.fromCharCode(...part.subarray(i,i+8192));return {ok:true,base64:btoa(binary)};
  }
  if(action==='finish'){state.files.clear();delete state.resultBytes;state.dispatched=false;
    // Close the result viewer opened to read the video, so the next piece finds the composer free.
    state.hovers=0;delete state.resultUrl;return {ok:true};}
  return fail('Unknown motion operation.');
}
