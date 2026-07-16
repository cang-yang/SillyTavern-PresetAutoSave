const OBJECT_STORE = 'kv';
const KEY_SEPARATOR = '\u0000';

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.addEventListener('success', () => resolve(request.result), { once: true });
        request.addEventListener('error', () => reject(request.error), { once: true });
    });
}

function transactionComplete(transaction) {
    return new Promise((resolve, reject) => {
        transaction.addEventListener('complete', resolve, { once: true });
        transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
        transaction.addEventListener('error', () => reject(transaction.error), { once: true });
    });
}

function openDatabase(name) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.addEventListener('upgradeneeded', () => {
            if (!request.result.objectStoreNames.contains(OBJECT_STORE)) {
                request.result.createObjectStore(OBJECT_STORE);
            }
        });
        request.addEventListener('success', () => resolve(request.result), { once: true });
        request.addEventListener('error', () => reject(request.error), { once: true });
        request.addEventListener('blocked', () => reject(new Error(`IndexedDB open blocked: ${name}`)), { once: true });
    });
}

function namespacePrefix(name, storeName) {
    return `${JSON.stringify([String(name), String(storeName)])}${KEY_SEPARATOR}`;
}

function rangeFor(prefix) {
    return IDBKeyRange.bound(prefix, `${prefix}\uffff`);
}

function payloadBytes(value) {
    if (!Array.isArray(value)) return 0;
    return value.reduce((sum, entry) => sum + (Number(entry?.size) || 0), 0);
}

export function createIndexedDbLocalforage({
    databaseName = 'pas-browser-harness',
    onOperation = () => {},
} = {}) {
    const database = openDatabase(databaseName);

    return Object.freeze({
        createInstance({ name = 'localforage', storeName = 'keyvaluepairs' } = {}) {
            const prefix = namespacePrefix(name, storeName);
            const storageKey = key => `${prefix}${String(key)}`;

            return Object.freeze({
                async getItem(key) {
                    const db = await database;
                    const transaction = db.transaction(OBJECT_STORE, 'readonly');
                    const completed = transactionComplete(transaction);
                    const value = await requestResult(transaction.objectStore(OBJECT_STORE).get(storageKey(key)));
                    await completed;
                    const result = value ?? null;
                    onOperation({
                        operation: 'getItem',
                        storeName,
                        key: String(key),
                        payloadBytes: payloadBytes(result),
                    });
                    return result;
                },

                async setItem(key, value) {
                    const db = await database;
                    const transaction = db.transaction(OBJECT_STORE, 'readwrite');
                    const completed = transactionComplete(transaction);
                    transaction.objectStore(OBJECT_STORE).put(value, storageKey(key));
                    await completed;
                    onOperation({
                        operation: 'setItem',
                        storeName,
                        key: String(key),
                        payloadBytes: payloadBytes(value),
                    });
                    return value;
                },

                async removeItem(key) {
                    const db = await database;
                    const transaction = db.transaction(OBJECT_STORE, 'readwrite');
                    const completed = transactionComplete(transaction);
                    transaction.objectStore(OBJECT_STORE).delete(storageKey(key));
                    await completed;
                    onOperation({ operation: 'removeItem', storeName, key: String(key), payloadBytes: 0 });
                },

                async keys() {
                    const db = await database;
                    const transaction = db.transaction(OBJECT_STORE, 'readonly');
                    const completed = transactionComplete(transaction);
                    const keys = await requestResult(
                        transaction.objectStore(OBJECT_STORE).getAllKeys(rangeFor(prefix)),
                    );
                    await completed;
                    return keys.map(key => String(key).slice(prefix.length));
                },

                async clear() {
                    const db = await database;
                    const read = db.transaction(OBJECT_STORE, 'readonly');
                    const readCompleted = transactionComplete(read);
                    const keys = await requestResult(
                        read.objectStore(OBJECT_STORE).getAllKeys(rangeFor(prefix)),
                    );
                    await readCompleted;
                    if (keys.length === 0) return;
                    const write = db.transaction(OBJECT_STORE, 'readwrite');
                    const writeCompleted = transactionComplete(write);
                    const store = write.objectStore(OBJECT_STORE);
                    for (const key of keys) store.delete(key);
                    await writeCompleted;
                },
            });
        },
    });
}
