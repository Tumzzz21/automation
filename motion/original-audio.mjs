import * as M from '../vendor/mediabunny-1.61.6.mjs';

// Copy encoded video; only the reference audio is decoded/encoded. No provider calls.
export async function restoreOriginalAudio(videoBlob, sourceBlob, {signal,onProgress=()=>{}}={}) {
  const check=()=>{if(signal?.aborted)throw new DOMException('Audio restoration paused.','AbortError');};
  for(const blob of [videoBlob,sourceBlob])if(!(blob instanceof Blob)||!blob.size||blob.size>40*1024*1024)throw Error('Audio restoration needs two saved videos under 40 MB.');
  const generated=new M.Input({source:new M.BlobSource(videoBlob),formats:M.ALL_FORMATS});
  const original=new M.Input({source:new M.BlobSource(sourceBlob),formats:M.ALL_FORMATS});
  let output,finished=false;
  try {
    check();
    const video=await generated.getPrimaryVideoTrack(),audio=await original.getPrimaryAudioTrack(),sourceVideo=await original.getPrimaryVideoTrack();
    if(!video)throw Error('The generated file has no video track.');
    if(!audio)throw Error('The reference has no audio track. Your generated take is kept.');
    const start=await video.getFirstTimestamp(),end=await video.computeDuration(),length=end-start;
    const sourceStart=sourceVideo?await sourceVideo.getFirstTimestamp():await audio.getFirstTimestamp();
    if(!(length>0&&length<=15.1))throw Error('Audio restoration supports generated clips up to 15 seconds.');
    const format=new M.Mp4OutputFormat({fastStart:'in-memory'});
    if(!format.getSupportedVideoCodecs().includes(video.codec))throw Error('This video codec cannot be copied into MP4. Your take is kept.');
    if(!await audio.canDecode()||!await M.canEncodeAudio('aac',{sampleRate:audio.sampleRate,numberOfChannels:audio.numberOfChannels,bitrate:192000}))throw Error('This browser cannot restore this audio to AAC. Try current desktop Chrome. Your take is kept.');
    const target=new M.BufferTarget();output=new M.Output({format,target});
    const picture=new M.EncodedVideoPacketSource(video.codec),sound=new M.AudioSampleSource({codec:'aac',bitrate:192000});
    output.addVideoTrack(picture,{rotation:video.rotation});output.addAudioTrack(sound);
    await output.start();
    const config=await video.getDecoderConfig();
    for await(const packet of new M.EncodedPacketSink(video).packets()){
      check();await picture.add(packet.clone({timestamp:packet.timestamp-start}),{decoderConfig:config});
    }
    picture.close();let samples=0;
    for await(const sample of new M.AudioSampleSink(audio).samples(sourceStart,sourceStart+length)){
      let selected=sample;
      try {
        check();
        const from=Math.max(0,Math.round((sourceStart-sample.timestamp)*sample.sampleRate));
        const to=Math.min(sample.numberOfFrames,Math.round((sourceStart+length-sample.timestamp)*sample.sampleRate));
        if(to<=from)continue;
        if(from||to<sample.numberOfFrames)selected=sample.trim(from,to);
        selected.setTimestamp(Math.max(0,selected.timestamp-sourceStart));
        await sound.add(selected);samples++;
        onProgress(Math.min(99,Math.round((selected.timestamp+selected.duration)/length*100)));
      } finally {if(selected!==sample)selected.close();sample.close();}
    }
    if(!samples)throw Error('No reference audio overlaps this video. Your take is kept.');
    sound.close();check();await output.finalize();finished=true;onProgress(100);
    return new Blob([target.buffer],{type:'video/mp4'});
  } finally {
    if(output&&!finished)await output.cancel().catch(()=>{});
    generated.dispose();original.dispose();
  }
}
