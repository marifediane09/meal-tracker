// Small promise wrapper around IndexedDB. All data stays on this device.
const DB_NAME = 'kain-log';
const DB_VERSION = 1;
const STORES = ['meals', 'favorites', 'reviews', 'kv'];

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meals')) {
        const meals = db.createObjectStore('meals', { keyPath: 'id' });
        meals.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('favorites')) db.createObjectStore('favorites', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('reviews')) db.createObjectStore('reviews', { keyPath: 'weekStart' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function put(name, value, key) {
  return wrap((await store(name, 'readwrite')).put(value, key));
}
export async function get(name, key) {
  return wrap((await store(name)).get(key));
}
export async function del(name, key) {
  return wrap((await store(name, 'readwrite')).delete(key));
}
export async function all(name) {
  return wrap((await store(name)).getAll());
}

// Meals between two YYYY-MM-DD dates, inclusive.
export async function mealsBetween(from, to) {
  const index = (await store('meals')).index('date');
  const rows = await wrap(index.getAll(IDBKeyRange.bound(from, to)));
  return rows.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

export const setting = (key) => get('kv', key);
export const saveSetting = (key, value) => put('kv', value, key);

export async function exportAll() {
  const data = { app: 'kain-log', version: 1, exportedAt: new Date().toISOString() };
  for (const name of ['meals', 'favorites', 'reviews']) data[name] = await all(name);
  // Settings are exported without the API key so a backup file is safe to keep in Drive.
  data.settings = { profile: await setting('profile') };
  return data;
}

export async function importAll(data, { replace = false } = {}) {
  if (!data || data.app !== 'kain-log') throw new Error('This file is not a Kain Log backup.');
  const db = await open();
  const names = ['meals', 'favorites', 'reviews'];
  await new Promise((resolve, reject) => {
    const tx = db.transaction([...names, 'kv'], 'readwrite');
    for (const name of names) {
      const os = tx.objectStore(name);
      if (replace) os.clear();
      for (const row of data[name] || []) os.put(row);
    }
    if (data.settings?.profile) tx.objectStore('kv').put(data.settings.profile, 'profile');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAll() {
  const db = await open();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORES, 'readwrite');
    for (const name of STORES) tx.objectStore(name).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
