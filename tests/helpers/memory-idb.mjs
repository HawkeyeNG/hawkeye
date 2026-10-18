/**
 * An in-memory IndexedDB, as much of it as app/outbox.js touches: open with
 * upgrade, one store per transaction, add/put/get/delete/getAll, and the
 * transaction's complete / abort events.
 *
 * `abortAdds` makes every transaction that added something fail at COMMIT the
 * way a full disk does: each request succeeds, then the transaction is rolled
 * back and only `abort` fires (error = QuotaExceededError), never `error`.
 */
export function memoryIndexedDB({ abortAdds = false } = {}) {
  const dbs = new Map();
  const soon = (fn) => setTimeout(fn, 0);

  function storeApi(state, queue, mark) {
    const req = (work) => {
      const r = {};
      queue.push(() => { r.result = work(); if (r.onsuccess) r.onsuccess(); });
      return r;
    };
    return {
      add(value) {
        mark();
        return req(() => {
          const copy = structuredClone(value);
          const id = state.next++;
          if (state.keyPath) copy[state.keyPath] = id;
          state.rows.set(id, copy);
          return id;
        });
      },
      put: (value, key) => req(() => { state.rows.set(key ?? value[state.keyPath], structuredClone(value)); return key; }),
      get: (key) => req(() => structuredClone(state.rows.get(key))),
      delete: (key) => req(() => { state.rows.delete(key); }),
      getAll: () => req(() => [...state.rows.values()].map((v) => structuredClone(v))),
    };
  }

  function database(stores) {
    return {
      close() {},
      createObjectStore(name, opts = {}) {
        stores.set(name, { keyPath: opts.keyPath, next: 1, rows: new Map() });
      },
      transaction(name) {
        const state = stores.get(name);
        const queue = [];
        let added = false;
        const txn = { error: null };
        txn.objectStore = () => storeApi(state, queue, () => { added = true; });
        soon(() => {
          const snapshot = new Map(state.rows);
          queue.forEach((run) => run());
          if (!(abortAdds && added)) { if (txn.oncomplete) txn.oncomplete(); return; }
          state.rows = snapshot;
          txn.error = Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
          if (txn.onabort) txn.onabort();
        });
        return txn;
      },
    };
  }

  return {
    open(name) {
      const request = {};
      soon(() => {
        const isNew = !dbs.has(name);
        if (isNew) dbs.set(name, new Map());
        request.result = database(dbs.get(name));
        if (isNew && request.onupgradeneeded) request.onupgradeneeded();
        if (request.onsuccess) request.onsuccess();
      });
      return request;
    },
  };
}
