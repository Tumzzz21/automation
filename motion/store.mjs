const dbPromise = new Promise((resolve, reject) => {
  const request = indexedDB.open('oxflow-motion-lab', 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('projects', {keyPath: 'id'});
    request.result.createObjectStore('media');
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
export async function read(store, key) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function listProjects(){const db=await dbPromise;return new Promise((resolve,reject)=>{const request=db.transaction('projects').objectStore('projects').getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
export async function save(project, media = []) {
  const db = await dbPromise;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['projects', 'media'], 'readwrite');
    for (const [key, blob] of media) tx.objectStore('media').put(blob, key);
    tx.objectStore('projects').put(project);
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || Error('Local save failed.'));
    tx.onerror = () => reject(tx.error);
  });
  localStorage.setItem('motionLatest', project.id);
}
