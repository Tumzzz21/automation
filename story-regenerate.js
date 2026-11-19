// Only this side panel's own extension workspace may request generation.
(() => {
  if(!chrome.runtime?.onMessage||!chrome.windows?.getCurrent)return;
  let preparing=false,last=null;
  chrome.windows.getCurrent().then(owner=>{
    chrome.runtime.onMessage.addListener((message,sender,reply)=>{
      if(!['story-regenerate','story-regenerate-status'].includes(message?.type))return false;
      const page=chrome.runtime.getURL('story-workspace.html');
      if(sender.id!==chrome.runtime.id||!sender.url||sender.url.split('?')[0]!==page||message.ownerWindowId!==owner.id)return false;
      if(typeof message.projectId!=='string'||!message.projectId||message.projectId.length>100)return false;
      if(message.type==='story-regenerate-status'){
        if(!last||last.projectId!==message.projectId){reply({ok:true,state:'idle'});return false;}
        const item=queue.find(x=>(x.builderProjectId||x.manualProjectId)===last.projectId&&(x.builderSceneId||x.manualSceneId)===last.sceneId);
        const state=preparing?'starting':!item?'idle':running?'running':item.status==='done'?'done':['error','skipped'].includes(item.status)?'failed':'waiting';
        reply({ok:true,state,sceneId:last.sceneId,captured:item?.workspaceVideoCaptured===true,detail:String(item?.detail||'').slice(0,500)});return false;
      }
      if(preparing||running){reply({ok:false,error:'A generation queue is already active. Wait for it to finish.'});return false;}
      if(typeof message.sceneId!=='string'||!/^scene_\d+$/.test(message.sceneId)){reply({ok:false,error:'Choose a valid scene.'});return false;}
      preparing=true;last={projectId:message.projectId,sceneId:message.sceneId};
      Promise.resolve().then(()=>window.FlowBuilderUI.regenerateScene(message.projectId,message.sceneId))
        .then(()=>reply({ok:true,state:'running',sceneId:message.sceneId}))
        .catch(e=>{last=null;reply({ok:false,error:e.message});})
        .finally(()=>{preparing=false;});
      return true;
    });
  }).catch(e=>console.warn('Workspace regeneration unavailable:',e));
})();
// Plan for the Story Workspace: 1080p export is a Pro feature (owner 2026-10-19). Answers only this extension's workspace page.
(() => {
  if(!globalThis.chrome?.runtime?.onMessage)return;
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(message?.type!=='story-plan')return false;
    const page=chrome.runtime.getURL('story-workspace.html');
    if(sender.id!==chrome.runtime.id||!sender.url||sender.url.split('?')[0]!==page)return false;
    Promise.resolve(typeof usageRefresh==='function'?usageRefresh():null)
      .then(state=>reply({ok:true,plan:state?.plan||'free',pro:!!state?.unlimited}))
      .catch(()=>reply({ok:true,plan:'unknown',pro:false}));
    return true;
  });
})();


// Cover jobs use the same trusted Workspace/owning-panel boundary as scene regeneration.
(() => {
  if(!chrome.runtime?.onMessage||!chrome.windows?.getCurrent)return;
  let preparing=null;
  chrome.windows.getCurrent().then(owner=>chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(!['story-cover','story-cover-status'].includes(message?.type))return false;
    if(sender.id!==chrome.runtime.id||sender.url?.split('?')[0]!==chrome.runtime.getURL('story-workspace.html')||message.ownerWindowId!==owner.id)return false;
    if(typeof message.projectId!=='string'||!message.projectId||message.projectId.length>100)return false;
    const requestId=message.requestId;
    if(typeof requestId!=='string'||!/^[a-zA-Z0-9-]{10,80}$/.test(requestId)){reply({ok:false,error:'Invalid cover request.'});return false;}
    if(message.type==='story-cover-status'){
      const item=queue.find(x=>x.builderProjectId===message.projectId&&x.builderCoverRequestId===requestId);
      const state=preparing===requestId?'starting':!item?'idle':item.workspaceCoverCaptured?'done':running?'running':item.status==='done'?'missing':['error','skipped'].includes(item.status)?'failed':'waiting';
      reply({ok:true,state,captured:item?.workspaceCoverCaptured===true,detail:String(item?.detail||'').slice(0,500)});return false;
    }
    if(preparing||running){reply({ok:false,error:'Wait for the active generation queue to finish.'});return false;}
    preparing=requestId;
    const options={requestId,sceneId:message.sceneId,platform:message.platform,referenceIds:message.referenceIds,moment:message.moment,headline:message.headline,position:message.position};
    Promise.resolve().then(()=>window.FlowBuilderUI.generateCover(message.projectId,options))
      .then(()=>reply({ok:true,requestId})).catch(e=>reply({ok:false,error:e.message})).finally(()=>{preparing=null;});
    return true;
  })).catch(e=>console.warn('Workspace cover unavailable:',e));
})();
