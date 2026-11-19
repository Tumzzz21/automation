export function setupMobileWorkspace(doc, nav) {
  const mobile=/Android|iPhone|iPad|iPod/i.test(nav.userAgent||'') || (/Macintosh/i.test(nav.userAgent||'')&&nav.maxTouchPoints>1);
  if(!mobile)return false;
  doc.documentElement.classList.add('mobile-workspace');
  const controls=doc.querySelector('.export-controls');if(controls)controls.hidden=true;
  const banner=doc.createElement('p');banner.className='mobile-workspace-note';
  banner.textContent='Your finished clips are saved in your phone’s Downloads. Review or regenerate a scene here, then combine your clips in CapCut or your preferred video editor.';
  doc.querySelector('.workspace-toolbar')?.after(banner);
  return true;
}
export async function mobileWorkspaceWindow(api) {
  const owner=await api.windows.getCurrent();
  const page=api.runtime.getURL('control.html');
  const tabs=await api.tabs.query({windowId:owner.id});
  const panels=tabs.filter(t=>String(t.url||'').split(/[?#]/)[0]===page);
  if(!Number.isInteger(owner.id)||panels.length!==1)throw Error('Keep one 0xFlow Control tab open in this browser window, then try Regenerate again.');
  return owner.id;
}
