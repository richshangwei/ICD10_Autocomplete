const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../js/merge.js");

const item = (t, note = "") => ({ addedAt: 1, note, updatedAt: t });

test("union of favorites from two devices", () => {
  const a = { items: { E119: item(10) }, deleted: {} };
  const b = { items: { I10: item(20) }, deleted: {} };
  assert.deepEqual(Object.keys(M.merge(a, b).items).sort(), ["E119", "I10"]);
});

test("newer note wins", () => {
  const a = { items: { E119: item(10, "old") }, deleted: {} };
  const b = { items: { E119: item(30, "new") }, deleted: {} };
  assert.equal(M.merge(a, b).items.E119.note, "new");
  assert.equal(M.merge(b, a).items.E119.note, "new");
});

test("a later removal is not undone by an older copy", () => {
  const phone = { items: {}, deleted: { E119: 50 } };
  const laptop = { items: { E119: item(10) }, deleted: {} };
  const m = M.merge(laptop, phone);
  assert.equal(m.items.E119, undefined);
  assert.equal(m.deleted.E119, 50);
});

test("re-adding after a removal keeps the favorite", () => {
  const a = { items: {}, deleted: { E119: 50 } };
  const b = { items: { E119: item(60) }, deleted: {} };
  assert.ok(M.merge(a, b).items.E119);
});

test("merge is order-independent and idempotent", () => {
  const a = { items: { E119: item(10), J449: item(40, "x") }, deleted: { I10: 30 } };
  const b = { items: { I10: item(20) }, deleted: { J449: 35 } };
  assert.ok(M.same(M.merge(a, b), M.merge(b, a)));
  const m = M.merge(a, b);
  assert.ok(M.same(M.merge(m, m), m));
});

test("fromAny reads v1 export, v2 file and old localStorage shape; rejects junk", () => {
  const v1 = { format: "icd10cm-favorites", version: 1, items: { E119: { addedAt: 5, note: "n" } } };
  assert.equal(M.fromAny(v1).items.E119.note, "n");
  const legacy = { E119: { addedAt: 5, note: "", updatedAt: 6 } };
  assert.ok(M.fromAny(legacy).items.E119);
  const v2 = JSON.parse(M.serialize({ items: { I10: item(3) }, deleted: { E119: 9 } }));
  assert.equal(M.fromAny(v2).deleted.E119, 9);
  assert.throws(() => M.fromAny({ format: "something-else", items: {} }));
  assert.deepEqual(Object.keys(M.fromAny({ items: { "<script>": item(1) } }).items), []);
});
