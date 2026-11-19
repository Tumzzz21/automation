// Coordinate native tile players and saved cuts without modifying the original media.
export function createTilePlayback({getOrder,getRange=()=>null,onSelect=()=>{},onFinished=()=>{},onError=()=>{}}){
  const players=new Map();let selected=null,sequential=false;
  function cancel(p){clearTimeout(p.timer);p.timer=null;}
  const pauseOthers=id=>{for(const [key,p] of players)if(key!==id){cancel(p);p.video.pause();}};
  function range(id){const r=getRange(id);return r&&Number.isFinite(r.start)&&Number.isFinite(r.end)?r:null;}
  function finish(id){
    const p=players.get(id);if(!p||p.finished||selected!==id)return;p.finished=true;cancel(p);p.video.pause();
    if(!sequential){onSelect(id,false,false);return;}
    const order=getOrder(),next=order[order.indexOf(id)+1];
    if(next&&players.has(next))void play(next,true);
    else{sequential=false;if(next)onError(next,Error('This scene has no playable clip.'));else onFinished();}
  }
  function watch(id){
    const p=players.get(id);if(!p)return;cancel(p);const r=range(id);
    if(!r||p.video.paused||p.video.seeking||p.finished)return;
    if(p.video.currentTime>=r.end-0.005){finish(id);return;}
    p.timer=setTimeout(()=>watch(id),Math.max(10,(r.end-p.video.currentTime)/Math.max(.1,p.video.playbackRate||1)*1000));
  }
  function seekStart(id){const p=players.get(id),r=range(id);if(r&&(p.video.currentTime<r.start||p.video.currentTime>=r.end-0.005))p.video.currentTime=r.start;}
  async function play(id,all=false){
    const p=players.get(id);if(!p)return false;
    sequential=all;selected=id;p.finished=false;pauseOthers(id);seekStart(id);onSelect(id,all);
    try{await p.video.play();watch(id);return true;}catch(e){if(e.name!=='AbortError'){sequential=false;onError(id,e);}return false;}
  }
  function stop(){sequential=false;pauseOthers(null);}
  function remove(id){const p=players.get(id);if(!p)return;cancel(p);p.video.pause();for(const [name,fn] of Object.entries(p.events))p.video.removeEventListener(name,fn);players.delete(id);if(selected===id){selected=null;sequential=false;onSelect(null,false);}}
  function add(id,video){
    remove(id);
    const events={play:()=>{if(selected!==id)sequential=false;selected=id;players.get(id).finished=false;pauseOthers(id);seekStart(id);onSelect(id,sequential);watch(id);},pause:()=>{cancel(players.get(id));if(selected===id&&!video.ended)onSelect(id,sequential,false);},ended:()=>finish(id),timeupdate:()=>watch(id),seeked:()=>{if(!video.paused)seekStart(id);watch(id);},ratechange:()=>watch(id),error:()=>{cancel(players.get(id));sequential=false;onError(id,Error('This clip could not be played. Replace it with a supported video.'));}};
    players.set(id,{video,events,timer:null,finished:false});for(const [name,fn] of Object.entries(events))video.addEventListener(name,fn);
  }
  function clear(){stop();for(const id of [...players.keys()])remove(id);}
  return {add,remove,play,stop,clear};
}
