/*
 * Favorites state and merge rules (pure logic, testable in Node).
 *
 * State: { items: { CODE: { addedAt, note, updatedAt } }, deleted: { CODE: deletedAt } }
 * The newest event per code wins, so a removal on one device is not undone by an older copy elsewhere.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FavMerge = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var CODE = /^[A-Z]\d[0-9A-Z]{1,5}$/;

  function empty() { return { items: {}, deleted: {} }; }

  function cleanItem(it) {
    if (!it || typeof it !== "object") return null;
    var now = Date.now();
    return {
      addedAt: Number(it.addedAt) || now,
      note: typeof it.note === "string" ? it.note : "",
      updatedAt: Number(it.updatedAt) || Number(it.addedAt) || now
    };
  }

  /** Accept the export / sync file (v1 or v2), the v1 localStorage shape, or a state object. */
  function fromAny(obj) {
    var out = empty();
    if (!obj || typeof obj !== "object") throw new Error("bad format");
    var items = obj.items, deleted = obj.deleted;
    if (obj.format === undefined && items === undefined) items = obj; // v1 localStorage: { CODE: item }
    else if (obj.format !== undefined && obj.format !== "icd10cm-favorites") throw new Error("bad format");
    if (!items || typeof items !== "object") throw new Error("bad format");
    Object.keys(items).forEach(function (code) {
      var it = cleanItem(items[code]);
      if (CODE.test(code) && it) out.items[code] = it;
    });
    if (deleted && typeof deleted === "object") {
      Object.keys(deleted).forEach(function (code) {
        var t = Number(deleted[code]);
        if (CODE.test(code) && t) out.deleted[code] = t;
      });
    }
    return out;
  }

  function merge(a, b) {
    var out = empty(), codes = {};
    [a, b].forEach(function (s) {
      Object.keys(s.items).forEach(function (c) { codes[c] = 1; });
      Object.keys(s.deleted).forEach(function (c) { codes[c] = 1; });
    });
    Object.keys(codes).forEach(function (c) {
      var ia = a.items[c], ib = b.items[c];
      var item = ia && ib ? (ib.updatedAt > ia.updatedAt ? ib : ia) : ia || ib;
      var del = Math.max(a.deleted[c] || 0, b.deleted[c] || 0);
      if (item && item.updatedAt >= del) out.items[c] = { addedAt: item.addedAt, note: item.note, updatedAt: item.updatedAt };
      else if (del) out.deleted[c] = del;
    });
    return out;
  }

  function serialize(state) {
    return JSON.stringify({
      format: "icd10cm-favorites", version: 2, savedAt: new Date().toISOString(),
      items: state.items, deleted: state.deleted
    }, null, 2);
  }

  function same(a, b) {
    function key(s) {
      return JSON.stringify([Object.keys(s.items).sort().map(function (c) { var i = s.items[c]; return [c, i.note, i.updatedAt]; }),
        Object.keys(s.deleted).sort().map(function (c) { return [c, s.deleted[c]]; })]);
    }
    return key(a) === key(b);
  }

  return { empty: empty, fromAny: fromAny, merge: merge, serialize: serialize, same: same };
});
