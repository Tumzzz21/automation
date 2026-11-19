// Session-only project import. Each scene text file remains one prompt.
let projectImportBusy = false;
document.getElementById('clearProjectBtn').addEventListener('click', () => {
  if (running || projectImportBusy) return;
  resetPanelSession();
  $('projectImportStatus').textContent = 'Project cleared. Select a folder to load another project.';
});
async function scanProjectFolder(root) {
  const files = [];
  async function walk(dir, prefix = '') {
    for await (const [name, handle] of dir.entries()) {
      const path = prefix + name;
      if (handle.kind === 'directory') {
        if (!/^(03_video_outputs|node_modules|\.git|backups)$/i.test(name)) await walk(handle, path + '/');
      } else files.push({path, name, handle});
    }
  }
  await walk(root);
  const normalize = path => String(path || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  function resolve(path, image = false) {
    const key = normalize(path);
    const candidates = files.filter(f => image ? /\.(png|jpe?g|webp)$/i.test(f.name) : /\.txt$/i.test(f.name));
    let found = candidates.filter(f => normalize(f.path) === key || normalize(f.path).endsWith('/' + key));
    if (!found.length) found = candidates.filter(f => normalize(f.name) === key.split('/').pop());
    if (!found.length && image) {
      const tag = key.match(/(?:char|loc|prop|outfit)_\d+/)?.[0];
      if (tag) found = candidates.filter(f => normalize(f.name).startsWith(tag + '_') || normalize(f.name).startsWith(tag + '.'));
    }
    if (found.length !== 1) throw new Error(`${found.length ? 'Ambiguous' : 'Missing'} project file: ${path}`);
    return found[0];
  }
  const manifests = files.filter(f => /(^|\/)automation_manifest\.csv$/i.test(f.path));
  const plans = files.filter(f => /reference_upload_plan\.csv$/i.test(f.name));
  const entries = [];
  for (const table of manifests.length ? manifests : plans) {
    const rows = P().parseDelimited(await (await table.handle.getFile()).text());
    if (!rows.length) throw new Error(`Empty project manifest: ${table.path}`);
    const headers = rows.shift().map(h => h.trim().toLowerCase());
    for (const cells of rows) {
      const row = Object.fromEntries(headers.map((h,i)=>[h,cells[i] || '']));
      if (manifests.length && String(row.type || '').toLowerCase() !== 'video') continue;
      if (!row.prompt_file && !String(row.scene || '').trim()) throw new Error(`Manifest row needs a prompt_file or scene column: ${table.path}`);
      const part = table.name.match(/part(\d+)/i)?.[1];
      const id = `p${String(row.part || part || 1).padStart(2,'0')}_s${String(row.scene).padStart(2,'0')}`;
      const prompt = row.prompt_file ? resolve(row.prompt_file) : files.find(f => f.name.toLowerCase().startsWith(id + '_') && /\.txt$/i.test(f.name));
      if (!prompt) throw new Error(`Missing prompt for ${id}`);
      entries.push({prompt, refs:(row.reference_order || [row.reference_image,row.character_images].filter(Boolean).join(';')).split(';').map(v=>v.includes('=')?v.slice(v.indexOf('=')+1):v).filter(Boolean), plannedOutputName:row.save_as || row.output_file || ''});
    }
  }
  if (!entries.length) {
    const folder = files.some(f=>f.path.startsWith('02_video_prompts_veo/')) ? '02_video_prompts_veo/' : '02_video_prompts/';
    for (const prompt of files.filter(f => f.path.startsWith(folder) && /\.txt$/i.test(f.name)).sort((a,b)=>a.path.localeCompare(b.path,undefined,{numeric:true}))) entries.push({prompt,refs:[]});
  }
  if (!entries.length) throw new Error('No video prompts found. Use 02_video_prompts, 02_video_prompts_veo, or an automation manifest.');
  const library = new Map(); const imported = [];
  for (const entry of entries) {
    const text = (await (await entry.prompt.handle.getFile()).text()).trim();
    if (!text) throw new Error(`Empty prompt: ${entry.prompt.path}`);
    const refs = new Map();
    for (const reference of entry.refs) { const file = resolve(reference,true); refs.set(file.path,{file,name:file.name}); }
    for (const match of text.matchAll(/@([\p{L}\p{N}_-]+)/gu)) {
      // @Maria may be Maria.png, .jpg, .jpeg or .webp. The library name keeps the
      // mention as its stem (Flow's @ picker matches it) and the real extension.
      let file = null;
      for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
        try { file = resolve(`${match[1]}.${ext}`, true); break; }
        catch (error) { if (/^Ambiguous/.test(error.message)) throw error; }
      }
      if (!file) throw new Error(`Missing project file: ${match[1]}.png/.jpg/.jpeg/.webp (referenced as @${match[1]} in ${entry.prompt.path})`);
      const ext = file.name.match(/\.[^.]+$/)?.[0].toLowerCase() || '.png';
      refs.set(file.path,{file,name:match[1]+ext});
    }
    for (const {file,name} of refs.values()) {
      if (library.has(name) && library.get(name).path !== file.path) throw new Error(`Duplicate image name: ${name}`);
      library.set(name,{...file, name});
    }
    imported.push({text,referenceNames:[...refs.values()].map(r=>r.name),plannedOutputName:entry.plannedOutputName});
  }
  const loaded = [];
  for (const file of library.values()) {
    const blob = await file.handle.getFile();
    const dataUrl = await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});
    loaded.push({name:file.name,type:blob.type,size:blob.size,dataUrl});
  }
  return {imported,loaded};
}
async function existingProjectOutputs(destination, items) {
  const completed = [];
  for (const item of items) {
    const current = outputNameForItem(item, 'mp4');
    const legacy = item.plannedOutputName ? item.plannedOutputName.split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g,'_').replace(/\.[^.]+$/, '')+'.mp4' : '';
    for (const name of [...new Set([current,legacy].filter(Boolean))]) {
      let file;
      try { file = await (await destination.getFileHandle(name)).getFile(); }
      catch (error) { if (error.name === 'NotFoundError') continue; throw error; }
      // A filename alone is not proof of completion: reject empty/partial files.
      if (file.size < 100 * 1024) continue;
      const header = await file.slice(0,512).arrayBuffer();
      if (!P().bufferHasMp4Signature(header)) continue;
      completed.push({item,name});break;
    }
  }
  return completed;
}
document.getElementById('loadProjectBtn').addEventListener('click', async () => {
  if (running) return;
  const button = document.getElementById('loadProjectBtn'); button.disabled = true;
  projectImportBusy = true;
  $('clearProjectBtn').disabled = true;
  try {
    const root = await window.showDirectoryPicker({mode:'readwrite'});
    $('projectImportStatus').textContent = 'Scanning project…';
    const result = await scanProjectFolder(root);
    const destination = await root.getDirectoryHandle('03_video_outputs',{create:true});
    images = result.loaded;
    $('promptText').value = result.imported.map(item=>item.text).join('\n\n');
    applyPromptsToQueue(result.imported);
    queue.forEach((item,i)=>Object.assign(item,{referenceNames:result.imported[i].referenceNames,plannedOutputName:result.imported[i].plannedOutputName}));
    outputDir=destination;outputDirName=root.name+'/03_video_outputs';
    const completed = await existingProjectOutputs(destination,queue);
    for (const {item,name} of completed) {
      item.status='done';item.outputName=name;item.detail='Already saved in project folder — generation skipped';
    }
    sheetPrompts=[];renderImages();renderQueue();loadSettingsIntoForm();
    $('projectImportStatus').textContent = `${root.name} · ${queue.length} prompts · ${images.length} reference images · ${completed.length} already saved`;
    log(`Project loaded: ${root.name}; outputs: ${outputDirName}`);
  } catch(error) { if(error.name!=='AbortError') {$('projectImportStatus').textContent=error.message;log(`Project import failed: ${error.message}`);} }
  finally { projectImportBusy=false;button.disabled=running;$('clearProjectBtn').disabled=running; }
});
