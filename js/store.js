/*
 * Favorites, personal notes and usage history, stored only in this browser's localStorage.
 * Depends on FavMerge (js/merge.js).
 */
(function (root) {
  "use strict";
  var M = root.FavMerge;
  var KEY = "icd10cm.favorites.v2", OLD_KEY = "icd10cm.favorites.v1", USAGE_KEY = "icd10cm.usage.v1";
  var state = M.empty(), usage = {}, available = true;

  function read(key) { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }

  function load() {
    try {
      var v2 = read(KEY);
      if (v2) state = M.fromAny(v2);
      else {
        var v1 = read(OLD_KEY);
        state = v1 ? M.fromAny(v1) : M.empty();
        if (v1) save();
      }
      usage = read(USAGE_KEY) || {};
    } catch (e) { available = false; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); return true; }
    catch (e) { available = false; return false; }
  }
  function saveUsage() { try { localStorage.setItem(USAGE_KEY, JSON.stringify(usage)); } catch (e) { /* not critical */ } }
  load();

  var listeners = [];
  function emit(source) { listeners.forEach(function (fn) { fn(source || "local"); }); }

  // Keep several open tabs in sync.
  window.addEventListener("storage", function (ev) {
    if (ev.key === KEY) { load(); emit("tab"); }
  });

  function touch(code) {
    var now = Date.now();
    if (!state.items[code]) state.items[code] = { addedAt: now, note: "", updatedAt: now };
    state.items[code].updatedAt = now;
    delete state.deleted[code];
    return state.items[code];
  }

  var DAY = 86400000;

  root.Store = {
    get available() { return available; },
    onChange: function (fn) { listeners.push(fn); },
    isFav: function (code) { return !!state.items[code]; },
    get: function (code) { return state.items[code] || null; },
    count: function () { return Object.keys(state.items).length; },
    all: function () {
      return Object.keys(state.items).map(function (code) {
        return Object.assign({ code: code }, state.items[code]);
      }).sort(function (a, b) { return b.addedAt - a.addedAt; });
    },
    add: function (code) { touch(code); save(); emit(); },
    remove: function (code) { delete state.items[code]; state.deleted[code] = Date.now(); save(); emit(); },
    setNote: function (code, note) { touch(code).note = note; var ok = save(); emit(); return ok; },

    /* --- whole-state access for sync, export and import --- */
    getState: function () { return JSON.parse(JSON.stringify(state)); },
    /** Merge another state in; returns true when something changed. */
    mergeIn: function (other, source) {
      var merged = M.merge(state, other);
      if (M.same(merged, state)) return false;
      state = merged; save(); emit(source || "merge");
      return true;
    },
    exportJSON: function () { return M.serialize(state); },
    importJSON: function (text) {
      var incoming = M.fromAny(JSON.parse(text));
      this.mergeIn(incoming, "import");
      return Object.keys(incoming.items).length;
    },

    /* --- usage history: personal ranking and "recently viewed" --- */
    recordView: function (code) {
      var u = usage[code] || { n: 0, last: 0 };
      u.n += 1; u.last = Date.now();
      usage[code] = u;
      // Keep the history small.
      var keys = Object.keys(usage);
      if (keys.length > 500) {
        keys.sort(function (a, b) { return usage[a].last - usage[b].last; })
          .slice(0, keys.length - 500).forEach(function (k) { delete usage[k]; });
      }
      saveUsage();
    },
    /** Ranking bonus: favorites and codes you open often or recently float up. */
    boost: function (code) {
      var b = state.items[code] ? 1.5 : 0, u = usage[code];
      if (u) {
        var age = (Date.now() - u.last) / DAY;
        b += Math.min(2.5, Math.log2(1 + u.n)) * (age > 90 ? 0.4 : age > 30 ? 0.7 : 1);
      }
      return b;
    },
    recent: function (n) {
      return Object.keys(usage).sort(function (a, b) { return usage[b].last - usage[a].last; }).slice(0, n || 8);
    },
    clearUsage: function () { usage = {}; saveUsage(); emit("usage"); }
  };
})(window);
