// Each AI Story saves in its own Downloads folder named after the story (owner 2026-10-29); Part 2/3 use Part 1's title.
// The same rules as control.js downloadFolder()/storyFolderName(), which save the scene images and videos.
const BAD = /[<>:"/\\|?*\x00-\x1f]/g;
export function storyFolderName(title) {
  return String(title || '').replace(BAD, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).replace(/[. ]+$/g, '').trim();
}
export function baseFolder(setting) {
  return String(setting || 'Flow Automation').replace(BAD, '_').replace(/[. ]+$/g, '').trim() || 'Flow Automation';
}
export function storyRoot(project, records = []) {
  return project?.parentProjectId ? records.find(r => r.id === project.parentProjectId) || project : project;
}
export function storyFolderPath(setting, project, records = []) {
  const base = baseFolder(setting), root = storyRoot(project, records), name = storyFolderName(root?.project?.title || project?.project?.title);
  return name ? base + '/' + name : base;
}
// "Ang Lihim - Part 2" for a series part, the plain title otherwise.
export function exportBaseName(project) {
  const title = String(project?.project?.title || 'My story').replace(BAD, '').trim().slice(0, 100) || 'My story';
  const total = Number(project?.setup?.partsTotal || 1), part = Number(project?.setup?.partNumber || 1);
  return total > 1 && !/part\s*\d/i.test(title) ? title + ' - Part ' + part : title;
}
// Wait for the exact browser download, not just acknowledgment of its creation.
export async function waitForStoryDownload(id,{signal,timeoutMs=10*60000,pollMs=500}={}) {
  if(!Number.isInteger(id)||id<0)throw Error('Browser did not identify this download. Check Downloads before retrying.');
  const until=Date.now()+timeoutMs;
  for(;;){
    if(signal?.aborted){await chrome.downloads.cancel?.(id).catch(()=>{});throw new DOMException('Export cancelled.','AbortError');}
    const [record]=await chrome.downloads.search({id});
    if(record?.state==='complete')return;
    if(record?.state==='interrupted')throw Error('Download interrupted'+(record.error?' ('+record.error+')':'')+'. Your source clips are kept.');
    if(Date.now()>=until)throw Error('Download completion could not be confirmed. Check browser Downloads before retrying. Your source clips are kept.');
    await new Promise(r=>setTimeout(r,pollMs));
  }
}
// A fallback anchor may start a save, but cannot acknowledge completion to Factory.
export async function saveToStoryFolder(blob,fileName,project,records=[],options={}) {
  if(options.signal?.aborted)throw new DOMException('Export cancelled.','AbortError');
  const url=URL.createObjectURL(blob);let completed=false;
  try {
    const setting=(await chrome.storage.local.get('faState')).faState?.settings?.downloadSubfolder;
    const folder=storyFolderPath(setting,project,records);let id;
    try{id=await chrome.downloads.download({url,filename:folder+'/'+fileName,conflictAction:'uniquify',saveAs:false});}
    catch(error){
      if(options.signal?.aborted)throw new DOMException('Export cancelled.','AbortError');
      const a=document.createElement('a');a.href=url;a.download=fileName;a.click();
      throw Error('Browser save started, but completion cannot be verified here. Check Downloads before retrying.');
    }
    await waitForStoryDownload(id,options);completed=true;return folder;
  } finally {
    if(completed)URL.revokeObjectURL(url);
    else {const timer=setTimeout(()=>URL.revokeObjectURL(url),120000);timer?.unref?.();}
  }
}
