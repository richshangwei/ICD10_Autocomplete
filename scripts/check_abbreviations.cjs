#!/usr/bin/env node
/*
 * 檢查縮寫字典 dict/abbreviations.js。
 *
 *   node scripts/check_abbreviations.cjs              檢查（有錯誤時結束碼為 1）
 *   node scripts/check_abbreviations.cjs --list       另外列出每個縮寫的指定代碼與名稱，方便人工核對
 *   node scripts/check_abbreviations.cjs --version 2027   改用指定版本檢查（預設為 data/versions.js 的預設版本）
 *
 * 錯誤（必須修正）：
 *   - 欄位缺漏或格式不對、同一行重複
 *   - 指定代碼在該版本不存在
 *   - 搜尋詞查不到任何代碼
 *   - 只輸入縮寫時，排在最前面的不是指定代碼
 *   - 縮寫和某個完整代碼一模一樣（會讓那個代碼無法用輸入的方式選取）
 * 提醒（不影響結果，只是告知）：
 *   - 縮寫本身也是某些代碼的開頭（輸入它時會優先當縮寫）
 *   - 指定代碼在其他版本不存在（該版本會自動略過）
 */
const { Core, loadManifest, loadIndex } = require("./lib/load_index.cjs");

function check(index, dict, opts) {
  opts = opts || {};
  const errors = [], notes = [], listing = [];
  const rows = dict.abbreviations || [];
  const seen = new Set();
  const byKey = new Map();

  rows.forEach((row, n) => {
    const where = `第 ${n + 1} 筆 ${JSON.stringify(row.abbr || "")}`;
    if (!row.abbr || typeof row.abbr !== "string") { errors.push(`${where}：缺少 abbr`); return; }
    const key = Core.abbrKey(row.abbr);
    if (!key) { errors.push(`${where}：abbr 沒有可用的字元`); return; }
    if (/\s/.test(row.abbr.trim())) errors.push(`${where}：abbr 不能有空白（使用者輸入的空白會把它拆成兩個字）`);
    if (!row.zh) errors.push(`${where}：缺少 zh（中文意思）`);
    if (!row.search && !row.codes) errors.push(`${where}：search 和 codes 至少要有一個`);
    const unknown = Object.keys(row).filter((k) => !["abbr", "zh", "search", "codes"].includes(k));
    if (unknown.length) errors.push(`${where}：不認得的欄位 ${unknown.join(", ")}`);
    const sig = key + "\u0000" + (row.search || "") + "\u0000" + (row.codes || "");
    if (seen.has(sig)) errors.push(`${where}：和前面某一行完全重複`);
    seen.add(sig);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);

    // Each search phrase must find something.
    String(row.search || "").split("|").map((s) => s.trim()).filter(Boolean).forEach((phrase) => {
      if (!Core.searchLiteral(index, phrase).items.length) errors.push(`${where}：搜尋詞「${phrase}」查不到任何代碼`);
    });

    // Each pinned code must exist.
    String(row.codes || "").split(/[\s,]+/).filter(Boolean).forEach((spec) => {
      const prefix = spec.endsWith("*");
      const found = prefix ? Core.prefixEntries(index, spec.slice(0, -1)) : [Core.get(index, spec)].filter(Boolean);
      if (!found.length) errors.push(`${where}：指定代碼 ${spec} 在這個版本不存在`);
      else if (!prefix && !found[0].billable) notes.push(`${where}：指定代碼 ${spec} 是不可申報的標題碼`);
    });
  });

  // Typing the abbreviation alone must put the pinned codes first, in order.
  byKey.forEach((list, key) => {
    const label = list[0].abbr;
    const res = Core.search(index, label);
    const expected = [];
    const specs = list.map((r) => String(r.codes || "").split(/[\s,]+/).filter(Boolean));
    for (let i = 0; specs.some((s) => i < s.length); i++) {
      specs.forEach((s) => {
        if (i >= s.length) return;
        const found = s[i].endsWith("*") ? Core.prefixEntries(index, s[i].slice(0, -1)) : [Core.get(index, s[i])].filter(Boolean);
        found.forEach((e) => { if (!expected.includes(e)) expected.push(e); });
      });
    }
    if (res.query.kind !== "keyword" || !res.query.expanded.length) {
      errors.push(`${JSON.stringify(label)}：輸入後沒有被當成縮寫（被解讀為 ${res.query.kind}）`);
    } else {
      const top = res.items.slice(0, expected.length);
      const wrong = expected.findIndex((e, i) => top[i] !== e);
      if (wrong !== -1) {
        errors.push(`${JSON.stringify(label)}：第 ${wrong + 1} 個結果應為 ${expected[wrong].dot}，實際為 ${top[wrong] ? top[wrong].dot : "（無）"}`);
      }
      if (!res.items.length) errors.push(`${JSON.stringify(label)}：輸入後沒有任何結果`);
    }
    if (Core.get(index, key)) {
      errors.push(`${JSON.stringify(label)}：和代碼 ${Core.get(index, key).dot} 完全相同，會讓這個代碼無法用輸入的方式選取`);
    } else if (/\d/.test(key) && Core.prefixEntries(index, key.toUpperCase(), 1).length) {
      notes.push(`${JSON.stringify(label)}：也是代碼的開頭（${key.toUpperCase()}…）；輸入時會優先當縮寫`);
    }
    if (opts.list) {
      listing.push(`${label}`);
      list.forEach((r) => {
        listing.push(`    ${r.zh}  ←  ${r.search || "（只用指定代碼）"}`);
        String(r.codes || "").split(/[\s,]+/).filter(Boolean).forEach((spec) => {
          if (spec.endsWith("*")) {
            const all = Core.prefixEntries(index, spec.slice(0, -1));
            listing.push(`        ${spec}  ${all.length} 個代碼，例如 ${all.slice(0, 2).map((e) => e.dot + " " + e.desc).join("；")}`);
          } else {
            const e = Core.get(index, spec);
            listing.push(`        ${e ? e.dot : spec}  ${e ? e.desc + (e.zh ? "｜" + e.zh : "") : "（不存在）"}`);
          }
        });
      });
      const first = res.items.slice(0, 3).map((e) => e.dot).join(", ");
      listing.push(`    → 實際前 3 筆：${first || "（無）"}`);
    }
  });

  // Chinese synonyms: both sides must be non-empty and different.
  (dict.zhSynonyms || []).forEach((pair, n) => {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair[0] || !pair[1] || pair[0] === pair[1]) {
      errors.push(`zhSynonyms 第 ${n + 1} 筆：需要兩個不同的字串`);
    }
  });

  return { errors, notes, listing, count: rows.length, abbreviations: byKey.size };
}

function main() {
  const args = process.argv.slice(2);
  const manifest = loadManifest();
  const vi = args.indexOf("--version");
  const version = vi >= 0 ? args[vi + 1] : manifest.default || manifest.latest;
  const index = loadIndex(version);
  const r = check(index, Core.DICT, { list: args.includes("--list") });

  if (r.listing.length) console.log(r.listing.join("\n") + "\n");
  console.log(`字典：${r.count} 筆、${r.abbreviations} 個不同的縮寫／俗稱；檢查版本：${version}`);
  if (r.notes.length) console.log(`\n提醒 ${r.notes.length} 項：\n  ` + r.notes.join("\n  "));
  if (r.errors.length) {
    console.log(`\n錯誤 ${r.errors.length} 項：\n  ` + r.errors.join("\n  "));
    process.exitCode = 1;
    return;
  }
  // Pinned codes that other versions do not have (they are skipped there).
  const missing = [];
  manifest.versions.filter((v) => v.id !== version).forEach((v) => {
    const other = loadIndex(v.id);
    const gone = new Set();
    (Core.DICT.abbreviations || []).forEach((row) => {
      String(row.codes || "").split(/[\s,]+/).filter(Boolean).forEach((spec) => {
        const ok = spec.endsWith("*") ? Core.prefixEntries(other, spec.slice(0, -1), 1).length : Core.get(other, spec);
        if (!ok) gone.add(spec);
      });
    });
    if (gone.size) missing.push(`${v.id}：${gone.size} 個指定代碼不存在（該版本會略過）`);
  });
  if (missing.length) console.log("\n其他版本：\n  " + missing.join("\n  "));
  console.log("\n檢查通過。");
}

if (require.main === module) main();
module.exports = { check };
