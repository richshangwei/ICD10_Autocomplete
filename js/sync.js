/*
 * Optional sync through a JSON file the user picks, e.g. inside a OneDrive / Google Drive / Dropbox folder.
 * The cloud client syncs the file between devices; this page reads, merges and writes it.
 * Uses the File System Access API (Chrome / Edge). Depends on Store and FavMerge.
 */
(function (root) {
  "use strict";
  var Store = root.Store, M = root.FavMerge;
  var DB = "icd10cm-sync", STORE = "handles", KEY = "file";
  var supported = typeof root.showSaveFilePicker === "function" && typeof root.showOpenFilePicker === "function";
  var handle = null, status = "off", lastSync = 0, lastError = "", busy = false, writeTimer = null;
  var listeners = [];

  function emit() { listeners.forEach(function (fn) { fn(); }); }
  function setStatus(s, err) { status = s; lastError = err || ""; emit(); }

  /* --- IndexedDB keeps the file handle across visits (handles cannot go in localStorage) --- */
  function idb(mode, fn) {
    return new Promise(function (resolve, reject) {
      var open = indexedDB.open(DB, 1);
      open.onupgradeneeded = function () { open.result.createObjectStore(STORE); };
      open.onerror = function () { reject(open.error); };
      open.onsuccess = function () {
        var tx = open.result.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
        tx.oncomplete = function () { resolve(req && req.result); open.result.close(); };
        tx.onerror = function () { reject(tx.error); };
      };
    });
  }
  var saveHandle = function (h) { return idb("readwrite", function (s) { return s.put(h, KEY); }); };
  var loadHandle = function () { return idb("readonly", function (s) { return s.get(KEY); }); };
  var dropHandle = function () { return idb("readwrite", function (s) { return s.delete(KEY); }); };

  var PICKER_TYPES = [{ description: "ICD-10-CM favorites", accept: { "application/json": [".json"] } }];

  function permission(h, ask) {
    var opts = { mode: "readwrite" };
    return h.queryPermission(opts).then(function (p) {
      if (p === "granted" || !ask) return p;
      return h.requestPermission(opts);
    });
  }

  /** Read the file, merge it with local data, and write the result back if anything differs. */
  function syncNow() {
    if (!handle || busy) return Promise.resolve();
    busy = true;
    return handle.getFile().then(function (file) { return file.text(); }).then(function (text) {
      var remote = M.empty();
      if (text.trim()) remote = M.fromAny(JSON.parse(text));
      Store.mergeIn(remote, "sync");
      var merged = Store.getState();
      if (M.same(merged, remote) && text.trim()) return null;
      return handle.createWritable().then(function (w) {
        return w.write(M.serialize(merged)).then(function () { return w.close(); });
      });
    }).then(function () {
      lastSync = Date.now(); busy = false; setStatus("on");
    }).catch(function (err) {
      busy = false;
      if (err && err.name === "NotAllowedError") setStatus("needs-permission");
      else setStatus("error", err && err.message || String(err));
    });
  }

  function scheduleWrite() {
    clearTimeout(writeTimer);
    writeTimer = setTimeout(syncNow, 800);
  }

  function attach(h, isNew) {
    handle = h;
    return saveHandle(h).then(function () {
      if (isNew) {
        // A brand-new file: write local data first so syncNow sees valid JSON.
        return h.createWritable().then(function (w) {
          return w.write(M.serialize(Store.getState())).then(function () { return w.close(); });
        });
      }
    }).then(syncNow);
  }

  function isAbort(err) { return err && err.name === "AbortError"; }

  root.Sync = {
    get supported() { return supported; },
    get status() { return status; },           // off | on | needs-permission | error
    get fileName() { return handle ? handle.name : ""; },
    get lastSync() { return lastSync; },
    get lastError() { return lastError; },
    onChange: function (fn) { listeners.push(fn); },

    /** Create a new sync file (choose a cloud-drive folder). */
    create: function () {
      return root.showSaveFilePicker({ suggestedName: "icd10cm-favorites.json", types: PICKER_TYPES })
        .then(function (h) { return attach(h, true); })
        .catch(function (err) { if (!isAbort(err)) setStatus("error", err.message); });
    },
    /** Link an existing sync file (e.g. created on another computer). */
    link: function () {
      return root.showOpenFilePicker({ types: PICKER_TYPES, multiple: false })
        .then(function (hs) { return permission(hs[0], true).then(function () { return attach(hs[0], false); }); })
        .catch(function (err) { if (!isAbort(err)) setStatus("error", err.message); });
    },
    /** Re-grant access after the browser forgot it (must run from a click). */
    reconnect: function () {
      if (!handle) return Promise.resolve();
      return permission(handle, true).then(function (p) {
        if (p === "granted") return syncNow();
        setStatus("needs-permission");
      });
    },
    disconnect: function () {
      handle = null; clearTimeout(writeTimer);
      return dropHandle().then(function () { setStatus("off"); });
    },
    syncNow: syncNow
  };

  // Write after local edits; pull again whenever the page regains focus.
  Store.onChange(function (source) { if (handle && status === "on" && source !== "sync") scheduleWrite(); });
  window.addEventListener("focus", function () { if (handle && status === "on") syncNow(); });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && handle && status === "on") syncNow();
  });

  if (supported && root.indexedDB) {
    loadHandle().then(function (h) {
      if (!h) return;
      handle = h;
      return permission(h, false).then(function (p) {
        if (p === "granted") return syncNow();
        setStatus("needs-permission");
      });
    }).catch(function () { /* IndexedDB unavailable: sync stays off */ });
  }
})(window);
