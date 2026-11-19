// Browser-only 720p MP4 assembly. Source files never leave the device.
import * as M from '../vendor/mediabunny-1.61.6.mjs';
import {drawCaption,audioSettings,musicFade,MAX_MUSIC_BYTES} from './story-overlays.mjs';
import {trimRange,audioCut} from './story-trim.mjs';
import {MAX_TOTAL_BYTES} from './story-workspace.mjs';
import {MAX_NARRATION_BYTES,MAX_NARRATION_SECONDS} from './story-narration.mjs';
import {drawSubtitle,drawTitle,drawEndCard,voiceSegments,END_CARD_SECONDS,frameLook,drawFrame,drawOverlay,duckCurve} from './story-finish.mjs';
export async function inspectClip(blob){
  const input=new M.Input({source:new M.BlobSource(blob),formats:M.ALL_FORMATS});
  try{
    const video=await input.getPrimaryVideoTrack();
    if(!video||!await video.canDecode())throw Error('This video format cannot be played here. Choose an MP4 supported by Chrome.');
    const start=await video.getFirstTimestamp(),duration=(await video.computeDuration())-start;
    if(!Number.isFinite(duration)||duration<=0||duration>120)throw Error('Each clip must be between 0 and 120 seconds.');
    return {duration,width:video.displayWidth,height:video.displayHeight,audio:!!await input.getPrimaryAudioTrack()};
  }finally{input.dispose();}
}
export async function inspectMusic(blob){
  if(!(blob instanceof Blob)||!blob.size||blob.size>MAX_MUSIC_BYTES)throw Error('Choose an audio file under 30 MB.');
  const input=new M.Input({source:new M.BlobSource(blob),formats:M.ALL_FORMATS});
  try{const audio=await input.getPrimaryAudioTrack();if(!audio||!await audio.canDecode())throw Error('Choose an audio file supported by Chrome.');const duration=(await audio.computeDuration())-await audio.getFirstTimestamp();if(!Number.isFinite(duration)||duration<=0||duration>600)throw Error('Choose background music up to 10 minutes.');return {duration};}finally{input.dispose();}
}
// A narration take is checked from its bytes (not its name or type): decodable audio, 0.5 s - 10 min, under 30 MB.
export async function inspectNarration(blob){
  if(!(blob instanceof Blob)||!blob.size||blob.size>MAX_NARRATION_BYTES)throw Error('Choose a narration file under 30 MB.');
  const input=new M.Input({source:new M.BlobSource(blob),formats:M.ALL_FORMATS});
  try{
    const audio=await input.getPrimaryAudioTrack();if(!audio||!await audio.canDecode())throw Error('This file is not audio Chrome can play. Use WAV, MP3 or M4A.');
    const duration=(await audio.computeDuration())-await audio.getFirstTimestamp();
    if(!Number.isFinite(duration)||duration<0.5||duration>MAX_NARRATION_SECONDS)throw Error('Narration must be between 0.5 seconds and 10 minutes.');
    return {duration,sampleRate:audio.sampleRate,channels:audio.numberOfChannels};
  }catch(e){throw /Narration|narration|audio/.test(e.message)?e:Error('This narration file could not be read. Use WAV, MP3 or M4A.');}finally{input.dispose();}
}
// Where voices are heard in a clip (seconds of the ORIGINAL clip), for automatic subtitle timing. Mono, 16 kHz.
export async function analyzeVoice(blob){
  const input=new M.Input({source:new M.BlobSource(blob),formats:M.ALL_FORMATS});
  try{
    const audio=await input.getPrimaryAudioTrack();if(!audio||!await audio.canDecode())return [];
    const base=await audio.getFirstTimestamp(),rate=16000,parts=[];let length=0;
    for await(const item of new M.AudioBufferSink(audio).buffers()){
      const b=item.buffer,step=b.sampleRate/rate,n=Math.floor(b.length/step),at=Math.max(0,Math.round((item.timestamp-base)*rate)),mono=new Float32Array(n);
      for(let i=0;i<n;i++){let v=0;const k=Math.floor(i*step);for(let c=0;c<b.numberOfChannels;c++)v+=b.getChannelData(c)[k];mono[i]=v/b.numberOfChannels;}
      parts.push([at,mono]);length=Math.max(length,at+n);
    }
    const all=new Float32Array(length);for(const [at,mono] of parts)all.set(mono.subarray(0,Math.max(0,Math.min(mono.length,length-at))),at);
    return voiceSegments(all,rate,{minGap:0.12,minLength:0.08});   // fine pauses: sentence breaks are placed on them
  }catch{return [];}finally{input.dispose();}
}
// finish (lib/story-finish.mjs): automatic subtitles (clips[i].cues, clip time), hook title, end card. A scene with its
// own manual caption keeps it. width x height 1080x1920 exports at a higher bitrate.
// narration (optional, lib/narration-timeline.mjs): {blob, slices:[{at,from,length}] in story time, volume}. Played once,
// never looped, from the same slices the preview uses; clips[i].cues/voice are then the narration's (story-workspace.js).
export async function renderStory(clips,{signal,onProgress=()=>{},width=720,height=1280,audio:mix={},finish=null,narration=null}={}){
  // Constant quality (owner 2026-11-05, 'Ang Huling Sayaw ni Lola' blurred for ~1 s after each scene start and at 0:33):
  // with a fixed 4 Mbps budget the hardware encoder spent it on one big frame and starved the next ~30. QUALITY_VERY_HIGH
  // asks the encoder for a constant quantizer where it supports one, else a higher bitrate; checkBitrate is only the
  // capability check.
  const bitrate=M.QUALITY_VERY_HIGH,checkBitrate=Math.min(width,height)>=1080?8e6:4e6;
  if(!clips.length||clips.some(c=>!c?.blob))throw Error('Add a clip for every scene before exporting.');
  if(clips.reduce((n,c)=>n+c.blob.size,0)>MAX_TOTAL_BYTES)throw Error('Choose a project smaller than 1 GB.');
  const abort=()=>{if(signal?.aborted)throw new DOMException('Export cancelled.','AbortError');};
  abort();
  if(!await M.canEncodeVideo('avc',{width,height,bitrate:checkBitrate,frameRate:30})||!await M.canEncodeAudio('aac',{sampleRate:48000,numberOfChannels:2,bitrate:128000}))throw Error('MP4 export needs H.264 and AAC encoding support. Try the current desktop Chrome or Edge. Your clips are kept.');
  const metadata=[];for(const c of clips){abort();metadata.push(await inspectClip(c.blob));}
  const ranges=metadata.map((m,i)=>trimRange(m.duration,clips[i].trim));
  const durations=ranges.map(r=>Math.ceil(r.duration*30)/30),total=durations.reduce((a,b)=>a+b,0);
  if(total>600)throw Error('This first version exports stories up to 10 minutes.');
  // End card = an extra ending AFTER the last scene (last frame, darkened), so it never covers dialogue (owner test 2026-10-19).
  const tail=finish?.end?.enabled&&String(finish.end.text||'').trim()?END_CARD_SECONDS:0,storyTotal=total+tail;
  const levels=audioSettings(mix);let music=null;
  if(mix.music){if(mix.music.size>MAX_MUSIC_BYTES)throw Error('Choose background music under 30 MB.');const decoder=new OfflineAudioContext(2,1,48000);try{music=await decoder.decodeAudioData(await mix.music.arrayBuffer());}catch{throw Error('Background music could not be decoded. Replace the track.');}if(music.duration>600)throw Error('Choose background music up to 10 minutes.');}
  let voiceTrack=null;
  if(narration?.blob){const decoder=new OfflineAudioContext(2,1,48000);try{voiceTrack=await decoder.decodeAudioData(await narration.blob.arrayBuffer());}catch{throw Error('The narration could not be decoded. Import the take again.');}}
  // Narration slices that overlap [start, start+length) of the story, placed into an OfflineAudioContext.
  function addNarration(offline,start,length){
    if(!voiceTrack||!(narration.volume>0))return;
    for(const s of narration.slices||[]){
      const a=Math.max(start,s.at),b=Math.min(start+length,s.at+s.length,s.at+voiceTrack.duration-s.from);if(b<=a)continue;
      const node=offline.createBufferSource(),gain=offline.createGain();node.buffer=voiceTrack;gain.gain.value=narration.volume;node.connect(gain);gain.connect(offline.destination);
      node.start(a-start,s.from+(a-s.at),b-a);
    }
  }
  abort();
  const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d',{alpha:false}),lastFrame=tail?new OffscreenCanvas(width,height):null;
  const target=new M.BufferTarget(),output=new M.Output({format:new M.Mp4OutputFormat({fastStart:'in-memory'}),target});
  const videoSource=new M.CanvasSource(canvas,{codec:'avc',bitrate}),audioSource=new M.AudioBufferSource({codec:'aac',bitrate:128000});
  output.addVideoTrack(videoSource,{frameRate:30});output.addAudioTrack(audioSource);
  let offset=0,completed=false;
  try{
    await output.start();
    for(let index=0;index<clips.length;index++){
      abort();const input=new M.Input({source:new M.BlobSource(clips[index].blob),formats:M.ALL_FORMATS});
      try{
        const track=await input.getPrimaryVideoTrack(),base=await track.getFirstTimestamp(),duration=durations[index],count=Math.round(duration*30);
        const sink=new M.CanvasSink(track,{width,height,fit:'contain',alpha:false,poolSize:2});
        function* timestamps(){for(let frame=0;frame<count;frame++)yield base+ranges[index].start+Math.min(frame/30,ranges[index].duration-0.000001);}
        let frame=0;
        for await(const sample of sink.canvasesAtTimestamps(timestamps())){
          abort();if(!sample)throw Error('A video frame could not be decoded. Replace clip '+(index+1)+'.');
          const look=finish?frameLook(finish.effects,index,clips.length,frame/30,duration):null;
          ctx.fillStyle='#000';ctx.fillRect(0,0,width,height);drawFrame(ctx,sample.canvas,width,height,look);if(lastFrame&&index===clips.length-1)lastFrame.getContext('2d').drawImage(canvas,0,0);drawOverlay(ctx,width,height,look);drawCaption(ctx,width,height,clips[index].caption);
          if(finish){const storyTime=offset+frame/30;if(!clips[index].caption?.enabled)drawSubtitle(ctx,width,height,clips[index].cues,ranges[index].start+frame/30,finish.subtitles);drawTitle(ctx,width,height,finish.title,storyTime);}
          await videoSource.add(offset+frame/30,1/30,{keyFrame:frame===0});frame++;
          if(frame%15===0)onProgress({percent:Math.min(98,Math.round((offset+frame/30)/storyTotal*98)),scene:index+1,total:clips.length});
        }
        abort();
        // Place decoded original audio at its original offset. Pad missing audio with silence,
        // and resample each scene to the exact video duration so subsequent clips stay in sync.
        const offline=new OfflineAudioContext(2,Math.round(duration*48000),48000),audio=await input.getPrimaryAudioTrack();
        // Fade transition: the clip's own sound dips with the picture at each cut.
        const clipBus=offline.createGain();clipBus.connect(offline.destination);
        if(finish?.effects?.transition==='fade'){const half=(finish.effects.transitionSeconds||0.4)/2;
          if(index>0){clipBus.gain.setValueAtTime(0,0);clipBus.gain.linearRampToValueAtTime(1,Math.min(half,duration/2));}
          if(index<clips.length-1){clipBus.gain.setValueAtTime(1,Math.max(0,duration-half));clipBus.gain.linearRampToValueAtTime(0,duration);}}
        if(audio&&levels.originalVolume>0){
          if(!await audio.canDecode())throw Error('Audio could not be decoded in clip '+(index+1)+'. No silent replacement was exported.');
          for await(const item of new M.AudioBufferSink(audio).buffers()){
            abort();const cut=audioCut(item.timestamp-base,item.buffer.duration,ranges[index].start,ranges[index].end);
            if(cut){const {at,skip,length}=cut;const node=offline.createBufferSource();node.buffer=item.buffer;const gain=offline.createGain();gain.gain.value=levels.originalVolume;node.connect(gain);gain.connect(clipBus);node.start(at,skip,length);}
          }
        }
        if(music&&levels.musicVolume>0){
          const node=offline.createBufferSource(),gain=offline.createGain();node.buffer=music;node.loop=true;
          // Music level: fades at the story's start/end, and lowered while someone speaks only when enabled.
          const voice=!levels.duck?[]:(clips[index].voice||[]).map(v=>({start:v.start-ranges[index].start,end:v.end-ranges[index].start})).filter(v=>v.end>0&&v.start<duration);
          const duck=duckCurve(voice,duration,{step:0.02}),curve=new Float32Array(duck.length);
          for(let k=0;k<duck.length;k++)curve[k]=Math.max(0,levels.musicVolume*musicFade(offset+Math.min(duration,k*0.02),storyTotal)*duck[k]);
          gain.gain.setValueCurveAtTime(curve,0,duration);
          node.connect(gain);gain.connect(offline.destination);node.start(0,offset%music.duration,duration);
        }
        addNarration(offline,offset,duration);
        const mixed=await offline.startRendering();abort();await audioSource.add(mixed);offset+=duration;
      }finally{input.dispose();}
    }
    if(tail){
      const frames=Math.round(tail*30);
      for(let frame=0;frame<frames;frame++){abort();ctx.drawImage(lastFrame,0,0);drawEndCard(ctx,width,height,finish.end,tail-frame/30);await videoSource.add(offset+frame/30,1/30,{keyFrame:frame===0});}
      const offline=new OfflineAudioContext(2,Math.round(tail*48000),48000);
      if(music&&levels.musicVolume>0){const node=offline.createBufferSource(),gain=offline.createGain();node.buffer=music;node.loop=true;gain.gain.setValueAtTime(levels.musicVolume*musicFade(offset,storyTotal),0);gain.gain.linearRampToValueAtTime(0,tail);node.connect(gain);gain.connect(offline.destination);node.start(0,offset%music.duration,tail);}
      addNarration(offline,offset,tail);
      await audioSource.add(await offline.startRendering());abort();offset+=tail;
    }
    videoSource.close();audioSource.close();abort();await output.finalize();abort();completed=true;
    onProgress({percent:100,scene:clips.length,total:clips.length});
    return new Blob([target.buffer],{type:'video/mp4'});
  }finally{if(!completed)await output.cancel().catch(()=>{});}
}
