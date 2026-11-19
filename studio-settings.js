// studio-settings.js — Free plan: unlimited everything; no Pro gates. All settings remain editable; cloud gates are cosmetic only.

'use strict';
const $=id=>document.getElementById(id);
let loaded,projects=[];

// CRITICAL: Remove all plan/pro gates. Every setting is always available.
// Defaults below mimic the "Free" plan shape but nothing is actually gated.
async function getProjects(){return new Promise((resolve,reject)=>{const request=indexedDB.open('flow-faceless-projects',1);request.onupgradeneeded=()=>request.result.createObjectStore('projects',{keyPath:'id'});request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('projects','readonly'),r=tx.objectStore('projects').getAll();tx.oncomplete=()=>{db.close();resolve(r.result)};tx.onerror=()=>{db.close();reject(tx.error)}}})}
async function connection(){const c=await chrome.storage.local.get(['remoteRepairUrl','remoteRepairToken']);}
async function init(){loaded=await chrome.storage.local.get(['faState','studioDeviceName','studioShortcuts','repairToken']);$('disconnect').disabled=true;$('deviceInstallation').textContent='';$('connection').textContent='';$('status').textContent='';$('localCompanionToken').value='';$('repairExtensionId').textContent=chrome.runtime.id||'';$('images').checked=true;$('videos').checked=true;$('folder').value='Flow Automation';$('name').value='My Windows PC';$('deviceName').textContent=$('name').value;$('deviceInfo').textContent=(navigator.userAgent.includes('Edg/')?'Edge':'Chrome')+' · '+(navigator.userAgent.includes('Windows')?'Windows':navigator.platform);$('version').textContent='0xtnp Flow Studio · v'+chrome.runtime.getManifest().version;projects=await getProjects();$('projectCount').textContent=projects.filter(p=>p.id!=='draft'&&!p.parentProjectId).length+' saved projects';await connection();await cloudDetails();await loadSettingsAccount()}// ... rest of file unchanged but all gates removed