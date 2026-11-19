// Source media stays intact. Saved ranges are measured in seconds of the original clip.
export const MIN_TRIM_SECONDS=0.1;
export function trimRange(duration,trim){
  if(!Number.isFinite(duration)||duration<=0)throw Error('The clip duration is not available.');
  if(!trim)return {start:0,end:duration,duration};
  const start=Number(trim.start),end=Number(trim.end);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>duration+0.001||end-start<MIN_TRIM_SECONDS-0.000001)throw Error('Choose a start and end within the clip, keeping at least 0.1 seconds.');
  const safeEnd=Math.min(end,duration);
  return {start,end:safeEnd,duration:safeEnd-start};
}
// Intersect an audio packet's source interval with the kept video range.
export function audioCut(timestamp,bufferDuration,start,end){
  const from=Math.max(timestamp,start),to=Math.min(timestamp+bufferDuration,end);
  return to>from?{at:from-start,skip:from-timestamp,length:to-from}:null;
}
