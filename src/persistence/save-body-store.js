const DEFAULT_DB_NAME = 'frontline_roads_save_v1';
const DEFAULT_STORE_NAME = 'save_bodies';

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export class SaveBodyStore {
  constructor({ indexedDB = globalThis.indexedDB, dbName = DEFAULT_DB_NAME, storeName = DEFAULT_STORE_NAME } = {}) {
    this.indexedDB = indexedDB ?? null;
    this.dbName = dbName;
    this.storeName = storeName;
    this.databasePromise = null;
  }

  isAvailable() {
    return Boolean(this.indexedDB?.open);
  }

  async open() {
    if (!this.isAvailable()) return null;
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const request = this.indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(this.storeName)) database.createObjectStore(this.storeName, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
      request.onblocked = () => reject(new Error('IndexedDB open blocked'));
    }).catch(error => {
      this.databasePromise = null;
      throw error;
    });
    return this.databasePromise;
  }

  async get(key) {
    const database = await this.open();
    if (!database) return null;
    const transaction = database.transaction(this.storeName, 'readonly');
    const record = await requestResult(transaction.objectStore(this.storeName).get(key));
    return record?.payload ?? null;
  }

  async put(key, payload, metadata = {}) {
    const database = await this.open();
    if (!database) return false;
    const transaction = database.transaction(this.storeName, 'readwrite');
    await requestResult(transaction.objectStore(this.storeName).put({
      key,
      payload,
      savedAt: metadata.savedAt ?? Date.now(),
      schemaVersion: metadata.schemaVersion ?? null,
      bytes: metadata.bytes ?? null
    }));
    return true;
  }

  async remove(key) {
    const database = await this.open();
    if (!database) return false;
    const transaction = database.transaction(this.storeName, 'readwrite');
    await requestResult(transaction.objectStore(this.storeName).delete(key));
    return true;
  }

  async removeAll() {
    const database = await this.open();
    if (!database) return false;
    const transaction = database.transaction(this.storeName, 'readwrite');
    await requestResult(transaction.objectStore(this.storeName).clear());
    return true;
  }

  close() {
    this.databasePromise?.then(database => database?.close?.()).catch(() => {});
    this.databasePromise = null;
  }
}

export class MemorySaveBodyStore {
  constructor({ delay = 0 } = {}) {
    this.records = new Map();
    this.delay = delay;
  }

  isAvailable() { return true; }

  async get(key) {
    if (this.delay) await new Promise(resolve => setTimeout(resolve, this.delay));
    return this.records.get(key)?.payload ?? null;
  }

  async put(key, payload, metadata = {}) {
    if (this.delay) await new Promise(resolve => setTimeout(resolve, this.delay));
    this.records.set(key, {
      key,
      payload: typeof payload === 'string' ? payload : structuredClone(payload),
      savedAt: metadata.savedAt ?? Date.now(),
      schemaVersion: metadata.schemaVersion ?? null,
      bytes: metadata.bytes ?? null
    });
    return true;
  }

  async remove(key) {
    this.records.delete(key);
    return true;
  }

  async removeAll() {
    this.records.clear();
    return true;
  }

  close() {}
}
