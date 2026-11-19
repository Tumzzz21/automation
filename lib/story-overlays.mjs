// Local text overlays and audio levels shared by preview and MP4 export.
export const MAX_MUSIC_BYTES=30*1024*1024;
export function captionSettings(value){
  const text=String(value?.text||'').trim();if(text.length>240)throw Error('Keep each scene caption under 240 characters.');
  return {enabled:!!value?.enabled&&!!text,text,style:value?.style==='bold'?'bold':'clean'};
}
export function audioSettings(value={}){
  const level=(x,fallback)=>{const n=x===undefined?fallback:Number(x);if(!Number.isFinite(n)||n<0||n>1)throw Error('Audio volume must be between 0 and 100%.');return n;};
  // duck (opt-in): the music is lowered while someone speaks (Finish Phase 2).
  return {originalVolume:level(value.originalVolume,1),musicVolume:level(value.musicVolume,.35),duck:value.duck===true};
}
export function musicFade(time,total){return Math.max(0,Math.min(1,time/.5,(total-time)/.5));}
export function drawCaption(ctx,width,height,value){
  const c=captionSettings(value);if(!c.enabled)return;
  ctx.save();let size=Math.round((width>height?height*.9:width)*(c.style==='bold'?.06:.048)),lines=[];
  const text=c.style==='bold'?c.text.toUpperCase():c.text;
  for(;size>=14;size-=2){
    ctx.font=`${c.style==='bold'?800:650} ${size}px Arial, sans-serif`;lines=[];
    for(const word of text.split(/\s+/)){const last=lines.length-1;if(last>=0&&ctx.measureText(lines[last]+' '+word).width<width*.84)lines[last]+=' '+word;else lines.push(word);}
    if(lines.length<=4&&lines.every(line=>ctx.measureText(line).width<width*.88))break;
  }
  // Long unbroken text is clipped to the safe area rather than overflowing the frame.
  const lineHeight=size*1.25,padding=size*.45,boxHeight=lines.length*lineHeight+padding*2,y=height*.83-boxHeight;
  ctx.fillStyle='rgba(9,7,16,.78)';ctx.fillRect(width*.06,y,width*.88,boxHeight);
  ctx.textAlign='center';ctx.textBaseline='top';ctx.fillStyle=c.style==='bold'?'#f8df86':'#ffffff';
  lines.forEach((line,i)=>ctx.fillText(line,width/2,y+padding+i*lineHeight,width*.84));ctx.restore();
}
