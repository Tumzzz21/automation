// Character identity records and reference files stay in this extension's local IndexedDB.
export const MAX_CAST=6,MAX_CHARACTERS=100,MAX_REFERENCE_BYTES=20*1024*1024,MAX_LIBRARY_BYTES=500*1024*1024;
const limits={name:60,appearance:600,outfit:300,voice:300,style:100,sourcePrompt:16000};
export function characterFields(value){
  const out={};for(const [key,max] of Object.entries(limits)){const text=String(value?.[key]||'').trim();if(text.length>max)throw Error(key+' is too long (maximum '+max+' characters).');out[key]=text;}
  if(!out.name||!out.appearance)throw Error('Enter a character name and appearance description.');return out;
}
// The picked file is copied into memory once: Android takes back the right to read a picked photo (Google Photos, cloud),
// so reading the File again at Save failed with "The requested file could not be read" (user report 2026-10-30).
export async function referenceImage(blob){
  if(!(blob instanceof Blob)||!blob.size||blob.size>MAX_REFERENCE_BYTES)throw Error('Choose a PNG, JPEG or WebP image under 20 MB.');
  let data;try{data=await blob.arrayBuffer();}catch(e){if(['NotReadableError','NotFoundError'].includes(e?.name))throw Error('This photo could not be read. Choose it again; if it is in Google Photos or the cloud, save it to your device first.');throw e;}
  const bytes=new Uint8Array(data.slice(0,12));
  const png=bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71;
  const jpg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  const webp=String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';
  if(!png&&!jpg&&!webp)throw Error('Choose an actual PNG, JPEG or WebP image.');
  const copy=new Blob([data],{type:png?'image/png':jpg?'image/jpeg':'image/webp'});
  if(typeof createImageBitmap==='function'){const image=await createImageBitmap(copy);try{if(!image.width||!image.height||image.width>16384||image.height>16384)throw Error('Choose an image up to 16384 pixels per side.');}finally{image.close();}}
  const digest=await crypto.subtle.digest('SHA-256',data);
  return {blob:copy,sha256:Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('')};
}
let database;
function db(){return database ||= new Promise((resolve,reject)=>{const r=indexedDB.open('flow-character-library',1);r.onupgradeneeded=()=>r.result.createObjectStore('characters',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
export async function listCharacters({archived=false}={}){const d=await db();return new Promise((resolve,reject)=>{const tx=d.transaction('characters','readonly'),r=tx.objectStore('characters').getAll();tx.oncomplete=()=>resolve(r.result.filter(c=>archived||!c.archivedAt).sort((a,b)=>b.updatedAt-a.updatedAt));tx.onerror=()=>reject(tx.error);});}
export async function getCharacter(id){return (await listCharacters({archived:true})).find(c=>c.id===id)||null;}
export async function saveCharacter(value,{ifAbsent=false}={}){
  const fields=characterFields(value),image=await referenceImage(value.image?.blob||value.image),id=value.id||'char_'+crypto.randomUUID();
  if(!/^char_[a-zA-Z0-9-]{8,80}$/.test(id))throw Error('Invalid character ID.');
  const d=await db();return new Promise((resolve,reject)=>{
    const tx=d.transaction('characters','readwrite'),store=tx.objectStore('characters'),r=store.getAll();let saved,error;
    r.onsuccess=()=>{const records=r.result,old=records.find(c=>c.id===id);if(old&&ifAbsent){saved=old;return;}if(!old&&records.length>=MAX_CHARACTERS){error=Error('The library holds up to 100 characters.');tx.abort();return;}
      if(records.filter(c=>c.id!==id).reduce((n,c)=>n+c.image.blob.size,image.blob.size)>MAX_LIBRARY_BYTES){error=Error('The character library exceeds 500 MB.');tx.abort();return;}
      saved={...fields,id,image,createdAt:old?.createdAt||Date.now(),updatedAt:Date.now(),archivedAt:old?.archivedAt||null};store.put(saved);
    };tx.oncomplete=()=>resolve(saved);tx.onerror=()=>reject(error||tx.error);tx.onabort=()=>reject(error||tx.error||Error('Character could not be saved.'));
  });
}
export async function archiveCharacter(id,archived=true){const d=await db();await new Promise((resolve,reject)=>{const tx=d.transaction('characters','readwrite'),store=tx.objectStore('characters'),r=store.get(id);r.onsuccess=()=>{if(r.result)store.put({...r.result,archivedAt:archived?Date.now():null,updatedAt:Date.now()});};tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
export async function castSnapshot(ids=[]){
  if(!Array.isArray(ids)||ids.length>MAX_CAST||new Set(ids).size!==ids.length)throw Error('Choose up to '+MAX_CAST+' different characters.');
  const all=await listCharacters();const cast=ids.map(id=>all.find(c=>c.id===id));if(cast.some(c=>!c))throw Error('A selected character is unavailable or archived. Choose your cast again.');
  const names=cast.map(c=>c.name.normalize('NFKC').toLocaleLowerCase());if(new Set(names).size!==names.length)throw Error('Give cast members distinct names before using them together.');
  return cast.map(c=>({...c,image:{...c.image}}));
}
// Shorten a note at a word boundary (the full note stays in the library).
function clipNote(text,max){const t=String(text||'').trim();if(t.length<=max)return t;const cut=t.slice(0,max),space=cut.lastIndexOf(' ');return (space>max*0.6?cut.slice(0,space):cut).replace(/[\s,;:.-]+$/,'')+'…';}
// Setup notes for the story writer (Builder presetContext, max 2000 characters). Detailed notes are shortened
// automatically to fit instead of failing (review 2026-10-19: two characters with long descriptions already failed);
// the reference IMAGE carries the identity. Characters are drawn in the STORY's style: a photorealistic reference in
// an anime story defines who the person is, never the art style.
export function castContext(base,cast,wardrobe='story'){
  if(!cast.length)return base||'';
  const clothing=wardrobe==='saved'?'OUTFIT LOCK: each wears the exact outfit of their saved picture and outfit note in every scene, replacing any template outfit; no added hats. Outfit "as in the saved picture": write only "in their saved outfit".':'The images are IDENTITY references, not costume locks. Choose scene-appropriate clothes for work, home, weddings or other events. State each character’s outfit explicitly in every scene image/video prompt; keep it continuous within the same event. Do not copy reference clothing automatically.';
  const intro='SAVED CHARACTER CAST: Keep exact names, faces, age, hair and voice. The picture sets face, skin, age and hair: never write others. Draw every cast member in this story’s chosen visual style; a reference image defines who the person is, never the art style. '+clothing+' Make a separate reusable CHARACTER asset for each cast member, put their exact name in its imagePrompt, and reference it in every scene where they appear. Do not use a character image as a location or prop. ';
  // Owner 2026-11-04: when the notes still do not fit, the extra lines other steps added go first (the idea request's avoid list, the
  // recurring-names line, the image-workflow line), so a saved character is never refused because of text it did not cause.
  const DROP=[/\nSuggest genuinely new stories[\s\S]*$/,/^Use these recurring character names for the suggested ideas: .*$/m,/^Image workflow: .*$/m];
  const trimmed=[base||''];for(const re of DROP){const last=trimmed[trimmed.length-1],next=last.replace(re,'').replace(/\n{2,}/g,'\n').trim();if(next!==last)trimmed.push(next);}
  for(const baseText of trimmed)
  // 0.12/0.08 and the lower floors let six saved characters fit (owner 2026-10-29: up to 6, Free and Pro).
  for(const k of [1,0.7,0.5,0.35,0.25,0.18,0.12,0.08]){
    const a=Math.max(45,Math.round(600*k)),o=Math.max(35,Math.round(300*k)),v=Math.max(20,Math.round(300*k));
    const text=[baseText,intro+JSON.stringify(cast.map(c=>({name:c.name,appearance:clipNote(c.appearance,a),...(wardrobe==='saved'?{outfit:clipNote(c.outfit,o)||'as in the saved picture'}:{}),voice:clipNote(c.voice,v)})))].filter(Boolean).join('\n');
    if(text.length<=2000)return text;
  }
  throw Error('Cast notes exceed the story setup space. Shorten the character notes or choose fewer characters.');
}
export function resolveCastBindings(project,cast){
 const bindings=suggestedBindings(project.assets,cast),missing=cast.filter(c=>!bindings[c.id]||!project.scenes.some(s=>(s.references||[]).includes(bindings[c.id])));
 if(missing.length)return {bindings:null,missing:missing.map(c=>c.name)};
 return {bindings,missing:[]};
}
export function castWardrobePrompts(project,cast,bindings,wardrobe='story'){
 const marker='SAVED CAST WARDROBE — ';
 // Member 2026-11-13: a scene prompt said "long straight dark brown hair, monolid eyes" for a saved character whose picture is a blonde
 // bob, and Flow followed the words. The identity line goes FIRST and says the picture beats any different words.
 const lock=present=>'IDENTITY LOCK — '+present.map(c=>c.name).join(', ')+': face, eyes, skin tone, age, hair colour, hair length and hairstyle come only from '+(present.length>1?'their attached character reference pictures':'the attached character reference picture')+'; ignore any different face or hair words below.\n\n';
 const assets=(project.assets||[]).map(asset=>{const who=cast.filter(c=>bindings[c.id]===asset.id);if(!who.length||!asset.imagePrompt||asset.imagePrompt.includes('IDENTITY LOCK — '))return asset;return {...asset,imagePrompt:lock(who)+asset.imagePrompt};});
 return {...project,...(Array.isArray(project.assets)?{assets}:{}),scenes:project.scenes.map(scene=>{
  const present=cast.filter(c=>(scene.references||[]).includes(bindings[c.id]));if(!present.length)return scene;
  const rule=marker+present.map(c=>c.name).join(', ')+': preserve identity, face, age and hair from the character references, drawn in this story’s visual style. '+(wardrobe==='saved'?'Keep the saved reference outfits exactly as in the character reference pictures: '+present.map(c=>c.name+' wears '+(String(c.outfit||'').trim()||'exactly the clothes, colours and accessories shown in their attached reference picture')).join('; ')+'. The same outfit, colours and accessories in every frame; ignore any other clothing, hat or beanie written above for them.':'Use the clothes specified for this scene; reference-image clothing is not a costume lock. If clothing is unspecified, choose clothing appropriate to the story event and maintain continuity.');
  const result={...scene};for(const key of ['imagePrompt','videoPrompt']){if(!scene[key]||scene[key].includes(marker))continue;const head=lock(present);if(head.length+scene[key].length+rule.length+2>16000)throw Error('The scene prompt is too long for saved-character clothing guidance. Rebuild this story.');result[key]=head+scene[key]+'\n\n'+rule;}return result;
 })};
}
export function suggestedBindings(assets,cast){
  const normalize=t=>String(t).normalize('NFKC').toLocaleLowerCase();const out={},used=new Set();
  for(const c of cast){const name=normalize(c.name),escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),pattern=new RegExp('(?<![\\p{L}\\p{N}])'+escaped+'(?![\\p{L}\\p{N}])','u');const matches=assets.filter(a=>pattern.test(normalize(a.imagePrompt)));if(matches.length===1&&!used.has(matches[0].id)){out[c.id]=matches[0].id;used.add(matches[0].id);}}
  return out;
}
export function mappedReferences(project,cast,bindings){
  const used=new Set();return cast.map(c=>{const id=bindings[c.id];if(!project.assets.some(a=>a.id===id))throw Error('Choose a reference card for '+c.name+'.');if(used.has(id))throw Error('Each character needs a different reference card.');used.add(id);if(!c.image?.blob?.size)throw Error('Saved image missing for '+c.name+'.');return {assetId:id,characterId:c.id,name:c.name,image:c.image};});
}
export async function exportCharacter(record){
  const bytes=new Uint8Array(await record.image.blob.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
  return {format:'0xflow-character',version:1,character:characterFields(record),image:{type:record.image.blob.type,data:btoa(binary)}};
}
export async function importCharacter(file){
  if(file.size>30*1024*1024)throw Error('Choose a character backup under 30 MB.');let data;try{data=JSON.parse(await file.text());}catch{throw Error('This is not a character backup.');}
  if(data?.format!=='0xflow-character'||data.version!==1||typeof data.image?.data!=='string'||data.image.data.length>MAX_REFERENCE_BYTES*1.4)throw Error('Unsupported character backup.');
  let bytes;try{bytes=Uint8Array.from(atob(data.image.data),c=>c.charCodeAt(0));}catch{throw Error('The character image is invalid.');}
  return saveCharacter({...characterFields(data.character),image:new Blob([bytes],{type:String(data.image.type||'')})});
}
