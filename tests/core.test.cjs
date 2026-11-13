// Search engine basics, on a U.S. release (English diagnosis codes only).
// Run all tests: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const { Core, loadIndex, loadChanges, loadData } = require("../scripts/lib/load_index.cjs");

const t0 = Date.now();
const us = loadData("2027");
const index = Core.createIndex(us.cm, us.pcs);
const buildMs = Date.now() - t0;
const codes = (items) => items.map((e) => e.dot);

test("index builds quickly with every code", () => {
  assert.equal(index.entries.length, 98403);
  assert.equal(index.hasPcs, false);
  assert.equal(index.hasZh, false);
  assert.ok(index.terms.length > 80000);
  assert.ok(buildMs < 4000, `index build took ${buildMs}ms`);
});

test("parseQuery classifies codes, ranges and keywords", () => {
  assert.deepEqual(Core.parseQuery("e11.9"), { kind: "code", q: "e11.9", code: "E119" });
  assert.equal(Core.parseQuery("0dtj4zz").code, "0DTJ4ZZ");
  assert.equal(Core.parseQuery("A00-B99").kind, "range");
  assert.equal(Core.parseQuery("E13 - E08").start, "E08");
  assert.equal(Core.parseQuery("type 2 diabetes").kind, "keyword");
  assert.equal(Core.parseQuery("糖尿病").kind, "keyword");
  assert.equal(Core.parseQuery("   ").kind, "empty");
});

test("exact code comes first, then its descendants", () => {
  assert.equal(Core.search(index, "E11.9").items[0].dot, "E11.9");
  const e11 = Core.search(index, "e11").items;
  assert.equal(e11[0].dot, "E11");
  assert.equal(e11[0].billable, false);
  assert.ok(e11.every((e) => e.code.startsWith("E11")));
});

test("code search keeps the official order, not plain alphabetical order", () => {
  // C4A (Merkel cell carcinoma) sits between C43 and C44 in the Tabular List.
  const c4 = codes(Core.search(index, "C4").items).filter((c) => c.length === 3);
  assert.ok(c4.indexOf("C4A") > c4.indexOf("C43") && c4.indexOf("C4A") < c4.indexOf("C44"), c4.join(","));
});

test("range search returns categories at the range depth", () => {
  const r = Core.search(index, "E08-E13");
  assert.deepEqual(codes(r.items), ["E08", "E09", "E10", "E11", "E13"]);
  assert.ok(r.all.length > 400);
});

test("ranking puts the usual code first", () => {
  assert.equal(Core.search(index, "hypertension").items[0].dot, "I10");
  assert.equal(Core.search(index, "type 2 diab").items[0].dot, "E11");
  assert.equal(Core.search(index, "chest pain").items[0].dot, "R07.9");
  assert.equal(Core.search(index, "copd").items[0].dot, "J44.9");
});

test("words are tried as keywords before codes; input with a digit is a code first", () => {
  assert.equal(Core.search(index, "ch").query.kind, "keyword");
  assert.equal(Core.search(index, "e11").query.kind, "code");
  // Looks like a code, but no code starts with it: falls back to keywords.
  const b12 = Core.search(index, "b12");
  assert.equal(b12.query.kind, "keyword");
  assert.ok(b12.items.some((e) => /vitamin b12/i.test(e.desc)));
});

test("Alphabetic Index finds codes whose description lacks the word", () => {
  const sugar = Core.search(index, "sugar");
  assert.equal(sugar.items[0].dot, "E11.9");
  assert.ok(sugar.via.has(sugar.items[0]));
  assert.equal(Core.search(index, "high blood pressure").items[0].dot, "I10");
});

test("see cross-references are followed", () => {
  assert.ok(codes(Core.search(index, "heart attack").items).includes("I21.9"));
});

test("drug and neoplasm tables are searchable", () => {
  const asp = Core.search(index, "aspirin").tables.drug;
  assert.ok(asp.length >= 1);
  assert.equal(asp[0].cells[0], "T39.011");
  const lung = Core.search(index, "neoplasm lung").tables.neoplasm;
  assert.ok(lung.some((r) => r.cells[0] && r.cells[0].startsWith("C34")));
});

test("misspellings get a suggestion", () => {
  assert.equal(Core.search(index, "diabetis").suggestion, "diabetes");
  assert.equal(Core.search(index, "pnuemonia").suggestion, "pneumonia");
  assert.equal(Core.search(index, "diabetes").suggestion, undefined);
});

test("personal boost reorders keyword results", () => {
  const plain = Core.search(index, "hypertension").items;
  const target = plain[5].code;
  const boosted = Core.search(index, "hypertension", { boost: (c) => (c === target ? 10 : 0) }).items;
  assert.equal(boosted[0].code, target);
});

test("index codes with a trailing dash resolve to the closest code", () => {
  assert.equal(Core.resolve(index, "C79.8-").dot, "C79.8");
  assert.equal(Core.resolve(index, "E08.-").dot, "E08");
});

test("hierarchy: parents, children, section and chapter", () => {
  const e = Core.get(index, "E11.9");
  assert.deepEqual(codes(Core.ancestors(e)), ["E11"]);
  assert.equal(Core.sectionOf(index, e).id, "E08-E13");
  assert.equal(Core.chapterOf(index, e).n, "4");
  assert.deepEqual(codes(Core.ancestors(Core.get(index, "T36.0X1A"))), ["T36", "T36.0", "T36.0X", "T36.0X1"]);
  assert.ok(Core.seventhChar(index, Core.get(index, "S72.001A")).defs.some(([c]) => c === "A"));
});

test("suggest is fast enough for typing", () => {
  const t = Date.now();
  for (const q of ["d", "di", "dia", "diab", "diabe", "diabet", "diabetes", "diabetes m"]) Core.suggest(index, q, 8);
  const per = (Date.now() - t) / 8;
  assert.ok(per < 100, `suggest averaged ${per}ms`);
});

test("a version without Chinese names or PCS still answers such input gracefully", () => {
  assert.equal(Core.search(index, "腎盂腎炎").items.length, 0);
  // Lay terms from the dictionary still lead to their pinned codes.
  assert.equal(Core.search(index, "糖尿病").items[0].dot, "E11.9");
  assert.equal(Core.search(index, "0DTJ4ZZ").items.length, 0);
  assert.equal(Core.display(index, "0DTJ4ZZ"), "0DTJ4ZZ");
  assert.equal(Core.display(index, "E119"), "E11.9");
});

test("older versions load and differ from the latest", () => {
  const old = loadIndex("2025");
  assert.equal(old.entries.length, 97584);
  const pair = loadChanges().find((p) => p.to === "2027");
  for (const [code] of pair.added) assert.ok(index.byCode.has(code));
});
