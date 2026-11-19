// Cover and post text are separate from scene prompts, clips and subtitle edits.
export const MAX_COVER_BYTES=20*1024*1024;
export function publishDraft(value={}){
  return {headline:String(value.headline||'').slice(0,90),caption:String(value.caption||'').slice(0,2200),sceneId:String(value.sceneId||'').slice(0,100),position:['top','bottom'].includes(value.position)?value.position:'bottom',source:value.source==='generated'?'generated':'scene'};
}
export function suggestedPost(p){
  const title=String(p.project?.title||'My story').trim();
  const tagalog=/tagalog|filipino/i.test(String(p.setup?.language||'')+' '+String(p.setup?.niche||''));
  const opening=String(p.project?.scenes?.[0]?.speech||'').replace(/\[[^\]]*\]/g,'').split(/\n/).find(x=>x.trim())?.trim().slice(0,180)||'';
  return publishDraft({headline:title,sceneId:p.project?.scenes?.[0]?.id,caption:[title,opening?`“${opening}”`:'',tagalog?'Ikaw, ano ang gagawin mo? Panoorin ang buong kuwento.':'What would you do? Watch the full story.',tagalog?'#AIStory #TagalogStory #0xFlow':'#AIStory #0xFlow'].filter(Boolean).join('\n\n')});
}
export function coverReferences(p){
  return (p.project?.assets||[]).filter(a=>p.media?.[a.id]?.blob?.size);
}
export function defaultCoverReferences(p){
  const all=coverReferences(p);
  const bound=Object.values(p.libraryBindings||{}).filter(id=>all.some(a=>a.id===id));
  // Prefer character sheets; users can inspect/select any saved reference.
  const people=all.filter(a=>/character|person|portrait|face|actor|woman|man\b/i.test(a.imagePrompt||''));
  return [...new Set([...bound,...(people.length?people:all).map(a=>a.id)])].slice(0,3);
}
export function coverReferenceLabel(p,id,index){return String((p.libraryCast||[]).find(c=>p.libraryBindings?.[c.id]===id)?.name||'Reference '+(index+1)).slice(0,40);}
export function fallbackCoverScene(p,savedId){
  const scenes=p.project?.scenes||[];
  return scenes.find(s=>s.id===savedId&&p.media?.[s.id]?.blob?.size)?.id||scenes.find(s=>p.media?.[s.id]?.blob?.size)?.id||scenes[0]?.id||'';
}
export function coverTitle(p,headline){
  if(headline!==undefined&&(typeof headline!=='string'||headline.length>90))throw Error('Keep the cover title under 90 characters.');
  return (headline?.trim()||String(p.project?.title||'My story').trim()).slice(0,90);
}
export function coverPreviewDraft(draft,generated){
  // New posters already contain their title. Legacy artwork/scene images use the editable overlay.
  return draft.source==='generated'&&generated?.headline?{...draft,headline:''}:draft;
}
// Wide 16:9 stories (owner 2026-11-11) get a wide 1920x1080 cover (a YouTube-style thumbnail); vertical stays 1080x1920.
export const coverWide=p=>String(p?.aspect||'')==='16:9';
export const coverSize=wide=>wide?[1920,1080]:[1080,1920];
export function coverPrompt(p,{sceneId,referenceIds,moment='',headline,position='bottom'}){
  const scenes=p.project?.scenes||[];
  if(!scenes.length||sceneId&&!scenes.some(s=>s.id===sceneId))throw Error('Choose a scene for the cover.');
  if(!Array.isArray(referenceIds)||referenceIds.length>3||new Set(referenceIds).size!==referenceIds.length||referenceIds.some(id=>!coverReferences(p).some(a=>a.id===id)))throw Error('Choose up to three saved reference images.');
  if(typeof moment!=='string'||moment.length>600)throw Error('Keep the cover moment under 600 characters.');
  const title=coverTitle(p,headline);
  const budget=Math.max(100,Math.floor(6500/scenes.length));
  const context=scenes.map((s,i)=>`Story beat ${i+1}: `+String(s.imagePrompt||s.videoPrompt||s.speech||'').replace(/\bImage\s+\d+\b/gi,'the corresponding story subject').slice(0,budget)).join('\n').slice(0,7000);
  const wide=coverWide(p);
  return [wide?'Design ONE finished premium story COVER / video THUMBNAIL, wide horizontal 16:9 landscape. Include the title in the generated image. This is a promotional cover, not a routine scene screenshot.':'Design ONE finished premium story POSTER / social-video COVER, 9:16 portrait. Include the title in the generated image. This is a promotional cover, not a routine scene screenshot.',
    'Use large, expressive main characters as the focal point: strong foreground presence, readable emotion, opposing gazes or layered character depth that communicates the story tension. Simplify the setting into an atmospheric backdrop, with strong rim light, rich contrast and intentional color grading. Match the story genre and reference art style.',
    'Use one unified cinematic composition, never a collage, panels or a reference-sheet layout. Do not add logos, watermarks, credits, subtitles or extra slogans.',
    'Make both the characters and title readable at '+(wide?'small video-thumbnail':'phone-thumbnail')+' size. Keep faces and the entire title inside an 8% safe margin. Do not place the title over eyes or important facial expressions.',
    'Story title: '+String(p.project.title).slice(0,200),
    referenceIds.length?'Use the attached reference images to preserve the identities/appearance of the selected story subjects. Use scene-appropriate clothing; do not reproduce a character sheet layout.':'Keep the subjects consistent with the scene description.',
    ...referenceIds.map((id,i)=>`Image ${i+1} is the saved story reference ${id}.`),
    p.setup?.topic?'Story premise (context only, do not reveal the ending): '+String(p.setup.topic).slice(0,2000):'',
    'This is ONE cover for the COMPLETE compiled story. Use the overall premise, recurring characters and central conflict; do not make a separate cover for each scene.',
    'Whole-story visual context only (discard scene-format directions such as no-text or reference-sheet instructions; do not depict ending spoilers): '+context,
    moment.trim()?'Cover direction requested by the user: '+moment.trim():'Create an arresting promotional composition expressing the whole story’s central tension. Do not merely copy a scene’s camera framing or reveal its ending.',
    'REQUIRED VISIBLE TITLE — render these exact words, preserving spelling and punctuation: '+JSON.stringify(title),
    'Typography: a large, bold professional cinematic display title in the '+(position==='top'?'upper':'lower')+' third, arranged in 2–3 balanced lines when needed. Use high-contrast ivory/white lettering with a restrained warm gold or story-appropriate accent, a subtle shadow and an integrated dark backdrop. No small plain caption or UI label. The title must be part of the finished artwork, clearly readable. This title requirement overrides any no-text direction in the visual context.'
  ].join('\n\n');
}
export function coverLines(ctx,text,maxWidth,maxLines=4){
  const tokens=String(text||'').trim().split(/\s+/u),lines=[];let line='';
  for(const token of tokens){
    if(line&&ctx.measureText(line+token).width>maxWidth){lines.push(line.trim());line='';}
    // Split long words so any language/user input remains inside the safe area.
    for(const part of [...token]){
      const next=line+part;
      if(ctx.measureText(next).width>maxWidth&&line){lines.push(line.trim());line=part;}else line=next;
    }
    if(line)line+=' ';
  }
  if(line.trim())lines.push(line.trim());
  if(lines.length>maxLines){lines.length=maxLines;let last=lines[maxLines-1];while(last&&ctx.measureText(last+'…').width>maxWidth)last=last.slice(0,-1);lines[maxLines-1]=last+'…';}
  return lines;
}
export async function drawCover(canvas,blob,draft,{wide=false}={}){
  // Vertical keeps its exact layout; wide uses the same title size (short side 1080) with up to 3 wider lines.
  const [W,H]=coverSize(wide),band=wide?470:820,bandTop=H-band;
  canvas.width=W;canvas.height=H;const ctx=canvas.getContext('2d');ctx.fillStyle='#151020';ctx.fillRect(0,0,W,H);
  if(blob){const bitmap=await createImageBitmap(blob);try{const ratio=Math.max(W/bitmap.width,H/bitmap.height),w=bitmap.width*ratio,h=bitmap.height*ratio;ctx.drawImage(bitmap,(W-w)/2,(H-h)/2,w,h);}finally{bitmap.close();}}
  else{ctx.fillStyle='#c5a6ff';ctx.font='500 40px Segoe UI, sans-serif';ctx.textAlign='center';ctx.fillText('Choose or generate your cover',W/2,H/2-60);}
  if(!draft.headline.trim())return;
  const top=draft.position==='top',gradient=ctx.createLinearGradient(0,top?0:bandTop,0,top?band:H);
  gradient.addColorStop(0,top?'#080510ed':'#08051000');gradient.addColorStop(1,top?'#08051000':'#080510ed');ctx.fillStyle=gradient;ctx.fillRect(0,top?0:bandTop,W,band);
  ctx.font='800 88px Segoe UI, sans-serif';const lines=coverLines(ctx,draft.headline,wide?1560:900,wide?3:4);ctx.textAlign='center';ctx.textBaseline='top';
  const start=top?(wide?90:200):(wide?H-120:1680)-lines.length*108;
  for(const [i,line] of lines.entries()){ctx.lineWidth=9;ctx.strokeStyle='#100b1bcc';ctx.strokeText(line,W/2,start+i*108);ctx.fillStyle='#ffffff';ctx.fillText(line,W/2,start+i*108);}
}
