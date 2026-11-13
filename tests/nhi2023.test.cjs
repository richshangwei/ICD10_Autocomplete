// The 2023 NHI (Taiwan) edition: every code can be selected, Chinese names, ICD-10-PCS.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Core, loadIndex, loadManifest, loadChanges } = require("../scripts/lib/load_index.cjs");

const ID = "2023-nhi";
const manifest = loadManifest();
const index = loadIndex(ID);
const codes = (r) => r.items.map((e) => e.dot);

// Size of the code set in the NHI workbook "2023年中文版ICD-10-CM/PCS" (see data/verify-2023-nhi.txt).
// The code set of the 2023 edition is fixed; NHI only revises Chinese names. If NHI ever adds or
// removes a code, update these numbers together with the workbook.
const NHI_CM = 96802, NHI_CM_BILLABLE = 73681, NHI_PCS = 78530;

test("it is the default version and holds exactly the NHI code set", () => {
  assert.equal(manifest.default, ID);
  const v = manifest.versions.find((x) => x.id === ID);
  assert.equal(v.count, NHI_CM);
  assert.equal(v.billable, NHI_CM_BILLABLE);
  assert.equal(v.pcs.count, NHI_PCS);
  assert.equal(index.cmCount, NHI_CM);
  assert.equal(index.entries.length, NHI_CM + NHI_PCS);
  assert.equal(index.byCode.size, NHI_CM + NHI_PCS, "every code is unique across CM and PCS");
  assert.equal(index.entries.filter((e) => e.sys === "cm" && e.billable).length, NHI_CM_BILLABLE);
  assert.ok(index.entries.filter((e) => e.sys === "pcs").every((e) => e.billable && e.code.length === 7));
});

test("every code has an English and a Chinese name, with no broken characters", () => {
  const bad = index.entries.filter((e) => !e.desc || !e.zh || /[?�]/.test(e.zh));
  assert.deepEqual(bad.map((e) => e.dot), []);
});

test("EVERY code is selectable: typing it finds it first, and its page opens", () => {
  const failed = [];
  for (const e of index.entries) {
    // What the search box does on Enter: a known code opens its page directly.
    const pq = Core.parseQuery(e.dot);
    if (pq.kind !== "code" || Core.get(index, pq.code) !== e) { failed.push(e.dot + " (Enter)"); continue; }
    // What the suggestion list shows while typing: the code itself is the first suggestion.
    if (Core.suggest(index, e.dot, 8).items[0] !== e) failed.push(e.dot + " (suggest)");
    // The form without a dot works too.
    if (e.sys === "cm" && Core.get(index, e.code) !== e) failed.push(e.dot + " (no dot)");
  }
  assert.deepEqual(failed.slice(0, 20), [], `${failed.length} codes cannot be selected by typing`);
});

test("EVERY code is reachable by browsing", () => {
  const lost = [];
  for (const e of index.entries) {
    if (e.sys === "pcs") {
      // Section -> body system -> table -> 4th character -> code.
      const parts = Core.pcsParts(index, e.code);
      if (!parts || parts.length !== 7 || parts.some((p) => !p.label)) lost.push(e.dot);
      continue;
    }
    // Chapter -> section -> top-level code -> children.
    let root = e;
    while (root.parent) root = root.parent;
    if (!Core.sectionOf(index, root) || !Core.chapterOf(index, root)) lost.push(e.dot);
  }
  assert.deepEqual(lost.slice(0, 20), [], `${lost.length} codes are not reachable by browsing`);
  const counts = Core.pcsCounts(index);
  assert.equal(index.pcs.sections.reduce((n, s) => n + counts[s[0]], 0), NHI_PCS);
});

test("NHI-only codes and the April 2023 additions are present", () => {
  for (const c of ["I60.0000", "I60.0005", "U00.0REH", "Z59.10", "T74.A1XA", "Y07.010", "Z91.141"]) {
    assert.ok(Core.get(index, c), c);
  }
  assert.equal(Core.get(index, "I60.0000").zh, "中風殘疾患者評估(MRS 0)");
  assert.equal(Core.get(index, "U00.0REH").dot, "U00.0REH");
  assert.equal(Core.search(index, "u00").items[0].dot, "U00.0REH");
  // Headers that NHI lists as not billable.
  assert.equal(Core.get(index, "Z59.1").billable, false);
});

test("repaired Chinese names (a lost character in the NHI workbook)", () => {
  assert.equal(Core.get(index, "K38.3").zh, "闌尾瘻管");
  assert.ok(codes(Core.search(index, "闌尾瘻管")).includes("K38.3"));
});

test("Chinese search: any part of the name, several conditions, small wording differences", () => {
  assert.equal(codes(Core.search(index, "心房顫動"))[0], "I48.91");
  assert.ok(codes(Core.search(index, "糖尿病 腎")).includes("E11.22"));
  assert.ok(codes(Core.search(index, "第2型糖尿病")).includes("E11.9"), "第2型 = 第二型");
  assert.ok(codes(Core.search(index, "B型肝炎")).includes("B18.1"), "B型肝炎 finds B型病毒性肝炎");
  assert.ok(codes(Core.search(index, "乳房 惡性腫瘤")).some((c) => c.startsWith("C50")));
  assert.ok(codes(Core.search(index, "胃癌")).includes("C16.9"), "癌 = 惡性腫瘤");
  assert.ok(codes(Core.search(index, "闌尾 切除")).includes("0DTJ4ZZ"), "Chinese finds procedure codes too");
  // Chinese and English in one query.
  assert.ok(codes(Core.search(index, "糖尿病 kidney")).includes("E11.22"));
});

test("ICD-10-PCS: codes, prefixes, tables and the official index", () => {
  const e = Core.get(index, "0DTJ4ZZ");
  assert.equal(e.sys, "pcs");
  assert.equal(e.dot, "0DTJ4ZZ");
  assert.equal(e.zh, "經皮內視鏡闌尾全部切除術");
  assert.deepEqual(Core.pcsParts(index, "0DTJ4ZZ").map((p) => p.label), [
    "Medical and Surgical", "Gastrointestinal System", "Resection", "Appendix",
    "Percutaneous Endoscopic", "No Device", "No Qualifier"]);
  const pre = Core.search(index, "0DTJ");
  assert.deepEqual(codes(pre), ["0DTJ0ZZ", "0DTJ4ZZ", "0DTJ7ZZ", "0DTJ8ZZ"]);
  assert.equal(pre.pcsTables[0].code, "0DT");
  assert.equal(Core.pcsGroups(index, "0DT").find((g) => g.ch === "J").label, "Appendix");
  // "appendectomy" is not in any code name; the PCS Index leads to the codes.
  const r = Core.search(index, "appendectomy");
  assert.ok(codes(r).includes("0DTJ4ZZ"));
  assert.ok(r.via.get(Core.get(index, "0DTJ4ZZ")).path[0].startsWith("Appendectomy"));
  assert.ok(Core.indexTermsFor(index, e).length >= 1);
});

test("codes that could be confused are told apart", () => {
  // PCS codes are shown without a dot, CM codes with one.
  assert.equal(Core.display(index, "0210093"), "0210093");
  assert.equal(Core.display(index, "S72001A"), "S72.001A");
  // A CM category and a PCS table can share three characters (B00); the code B00 is the diagnosis.
  assert.equal(Core.get(index, "B00").sys, "cm");
  assert.ok(Core.pcsTable(index, "B00"), "PCS table B00 exists as a table, not as a code");
  // Letters only: words first ("ch" is not the PCS prefix CH), unless nothing matches as words.
  assert.equal(Core.search(index, "ch").query.kind, "keyword");
  assert.equal(Core.search(index, "xrg").query.kind, "code");
  assert.equal(Core.search(index, "gzhzzzz").items[0].dot, "GZHZZZZ");
  // Mixed results keep both systems.
  const mixed = Core.search(index, "appendix").items;
  assert.ok(mixed.some((x) => x.sys === "cm") && mixed.some((x) => x.sys === "pcs"));
});

test("version changes compare diagnosis codes only", () => {
  const pair = loadChanges().find((p) => p.from === ID);
  assert.ok(pair.added.length > 0);
  assert.ok(pair.deleted.every(([c]) => Core.get(index, c).sys === "cm"));
  assert.ok(pair.deleted.some(([c]) => c === "U000REH"), "NHI-only codes show as not in the U.S. release");
});

test("typing stays fast with both code systems and Chinese names loaded", () => {
  const inputs = ["h", "ht", "htn", "糖", "糖尿", "糖尿病", "0D", "0DT", "0DTJ", "diab", "diabetes m", "append", "appendectomy", "ms", "cabg"];
  const t = Date.now();
  for (const q of inputs) Core.suggest(index, q, 8);
  const per = (Date.now() - t) / inputs.length;
  assert.ok(per < 150, `suggest averaged ${per.toFixed(0)}ms`);
});
