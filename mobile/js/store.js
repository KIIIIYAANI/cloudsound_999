// Tiny IndexedDB wrapper. Samples (audio) live in "samples"; everything else is one JSON doc in "kv".
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('cs999-mobile', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('samples', { keyPath: 'id' }); r.result.createObjectStore('kv'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
function tx(store, mode, fn) {
  return db().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => res(r && 'result' in r ? r.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}
export const store = {
  allSamples: () => tx('samples', 'readonly', s => s.getAll()),
  putSample: (rec) => tx('samples', 'readwrite', s => s.put(rec)),
  delSample: (id) => tx('samples', 'readwrite', s => s.delete(id)),
  get: (k) => tx('kv', 'readonly', s => s.get(k)),
  set: (k, v) => tx('kv', 'readwrite', s => s.put(v, k)),
  wipe: () => Promise.all([tx('samples', 'readwrite', s => s.clear()), tx('kv', 'readwrite', s => s.clear())])
};
