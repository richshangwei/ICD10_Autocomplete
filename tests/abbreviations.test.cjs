// The abbreviation dictionary (dict/abbreviations.js) against the default version.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Core, loadIndex, loadManifest } = require("../scripts/lib/load_index.cjs");
const { check } = require("../scripts/check_abbreviations.cjs");

const index = loadIndex(loadManifest().default);
const codes = (r) => r.items.map((e) => e.dot);
const top = (q, n) => codes(Core.search(index, q)).slice(0, n || 1);

test("the dictionary passes every check (codes exist, phrases find codes, pinned codes come first)", () => {
  const r = check(index, Core.DICT);
  assert.deepEqual(r.errors, []);
  assert.ok(r.abbreviations >= 300, `only ${r.abbreviations} abbreviations`);
});

test("common abbreviations give the usual code first", () => {
  const expected = {
    htn: "I10", dm: "E11.9", t2dm: "E11.9", copd: "J44.9", ami: "I21.9", chf: "I50.9", af: "I48.91",
    cad: "I25.10", ckd: "N18.9", esrd: "N18.6", uti: "N39.0", uri: "J06.9", gerd: "K21.9", cva: "I63.9",
    bph: "N40.0", hcc: "C22.0", osa: "G47.33", ra: "M06.9", sle: "M32.9", ida: "D50.9"
  };
  for (const [abbr, code] of Object.entries(expected)) assert.deepEqual(top(abbr), [code], abbr);
});

test("case, spaces and punctuation in the abbreviation do not matter", () => {
  assert.deepEqual(top("HTN"), ["I10"]);
  assert.deepEqual(top("  Htn "), ["I10"]);
  for (const q of ["c/s", "C/S", "cs", "CS"]) assert.deepEqual(top(q), ["10D00Z1"], q);
  assert.deepEqual(top("covid-19"), ["U07.1"]);
});

test("an abbreviation with several meanings lists the first code of each meaning first", () => {
  assert.deepEqual(top("ms", 2), ["G35", "I05.0"]);
  assert.deepEqual(top("pd", 2), ["G20", "3E1M39Z"]);
  const r = Core.search(index, "ar");
  assert.deepEqual(codes(r).slice(0, 2), ["I35.1", "J30.9"]);
  assert.equal(r.query.expanded[0].meanings.length, 2);
});

test("the expansion shown to the user names the abbreviation and its meanings", () => {
  assert.deepEqual(Core.search(index, "hcm").query.expanded,
    [{ abbr: "HCM", meanings: [{ zh: "肥厚性心肌病變", en: "hypertrophic cardiomyopathy" }] }]);
});

test("abbreviations found in official text still match literally", () => {
  assert.ok(codes(Core.search(index, "nstemi")).includes("I21.4"));
  assert.ok(codes(Core.search(index, "stemi")).some((c) => c.startsWith("I21")));
  // TURP is a main term of the official PCS Index.
  assert.ok(codes(Core.search(index, "turp")).includes("0VT07ZZ"));
});

test("as typed, an abbreviation only matches whole words", () => {
  // "gi" must not match "gingival".
  assert.ok(Core.search(index, "gi").items.every((e) => !/\bgingiv/i.test(e.desc) || /gastrointestinal/i.test(e.desc)));
});

test("abbreviation combined with other words: no pinned codes, all words must match", () => {
  assert.ok(codes(Core.search(index, "fx femur")).slice(0, 5).some((c) => c.startsWith("S72")));
  const r = Core.search(index, "dm2 kidney");
  assert.ok(codes(r).includes("E11.22"));
  assert.ok(!codes(r).includes("E11.9"), "E11.9 has no kidney wording, so it must not be pinned here");
});

test("procedure abbreviations reach ICD-10-PCS codes", () => {
  assert.ok(top("cabg")[0].startsWith("0210"));
  assert.ok(codes(Core.search(index, "cabg")).includes("Z95.1"));
  assert.deepEqual(top("turp"), ["0VT08ZZ"]);
  assert.deepEqual(top("lc", 2), ["K74.60", "0FT44ZZ"]);
  assert.ok(top("tkr")[0].startsWith("0SRC"));
});

test("Chinese lay terms work like abbreviations", () => {
  assert.deepEqual(top("高血壓"), ["I10"]);
  assert.deepEqual(top("盲腸炎"), ["K35.80"]);
  assert.deepEqual(top("洗腎", 2), ["Z99.2", "5A1D70Z"]);
  assert.deepEqual(top("肺癌"), ["C34.90"]);
  assert.deepEqual(top("中風", 2), ["I63.9", "I61.9"]);
});

test("in a version that lacks a pinned code, the code is skipped and the rest still works", () => {
  const us = loadIndex("2027");
  assert.equal(codes(Core.search(us, "htn"))[0], "I10");
  // No PCS in U.S. releases: the diagnosis-side meaning is still found.
  assert.ok(codes(Core.search(us, "cabg")).includes("Z95.1"));
  assert.ok(Core.search(us, "c/s").items.length > 0);
});
