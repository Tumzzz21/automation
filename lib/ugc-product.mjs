export const PRODUCT_ASSET_ID='asset_001';
export const MAX_PRODUCT_BYTES=15*1024*1024;
export const FORMATS=[['Presenter + product','Character host and B-roll'],['Hands-only demo','Hands-only process'],['Product showcase','B-roll with narration']];
export function defaults(a={}){
 return {...a,niche:'56',topicMode:'Creative brief',topic:a.topic||'Create an ad from the supplied product brief.',language:a.language||'English',sceneDuration:a.sceneDuration||'10',sceneCount:a.sceneCount||'3',format:FORMATS.some(([,v])=>v===a.format)?a.format:FORMATS[0][1],style:'Photorealistic cinematic',imageMode:'Extension image queue',exportProfile:'Scene image + video',imageWorkflow:'Reference images first',destination:'Save in extension',ugcVoice:a.ugcVoice||'Male',ugcTheme:a.ugcTheme||'Problem → solution',ugcLocation:a.ugcLocation||'Auto'};
}
export function validateProductImage(file){
 if(!(file instanceof Blob)||!file.size||file.size>MAX_PRODUCT_BYTES||!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('Upload a PNG, JPG or WEBP product image under 15 MB.');
 return file;
}
export async function productMedia(file){
 validateProductImage(file);
 const bytes=await file.arrayBuffer(),digest=await crypto.subtle.digest('SHA-256',bytes);
 return {blob:file,name:'p01_asset_001.'+({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[file.type]),sha256:Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join(''),source:'uploaded-product'};
}
