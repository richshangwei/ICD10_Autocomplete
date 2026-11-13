/*
 * ICD-10-CM / ICD-10-PCS data model and search engine.
 * Pure logic, no DOM. Works as a classic browser script (window.ICDCore)
 * and as a CommonJS module for tests.
 *
 * One index holds one version: the CM codes, and (when the version has them)
 * the PCS codes and the Chinese names. See docs/development-spec.md.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ICDCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var CM_CODE = "[A-Z]\\d[0-9A-Z](?:\\.?[0-9A-Z]{1,4})?";
  var RANGE_RE = new RegExp("^(" + CM_CODE + ")\\s*[-–—~]\\s*(" + CM_CODE + ")$");
  // Anything that could be the start of a code: CM (dot allowed after the 3rd character) or PCS.
  var CODEISH_RE = /^(?:[A-Z]\d[0-9A-Z]\.[0-9A-Z]{0,4}|[0-9A-Z]{1,7})$/;
  var CJK_RE = /[㐀-鿿豈-﫿]/;
  var MAX_VARIANTS = 12;      // search variants per query (literal words x abbreviation meanings)
  var MAX_EXPAND = 3000;      // codes taken from one code prefix (PCS index term or pinned "0210*")
  var PIN_SCORE = 100000;     // pinned codes of an abbreviation always rank above text matches

  function nodot(code) { return String(code).toUpperCase().replace(/\./g, ""); }
  /** CM display form. PCS codes have no dot: use display() when the code may be PCS. */
  function dotted(code) { code = nodot(code); return code.length > 3 ? code.slice(0, 3) + "." + code.slice(3) : code; }
  function fold(text) { text = String(text); return (text.normalize ? text.normalize("NFKC") : text).toLowerCase(); }
  /** English text -> lower-case words separated by single spaces. */
  function normalize(text) { return String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
  /** Chinese text -> comparable form: full-width folded, no spaces or punctuation. */
  function zhFold(text) { return fold(text).replace(/[^a-z0-9㐀-鿿豈-﫿]+/g, ""); }
  function hasCJK(text) { return CJK_RE.test(text); }

  /* ------------------------------------------------------------ abbreviations */

  // Hand-maintained dictionary (dict/abbreviations.js).
  var DICT = (typeof self !== "undefined" && self.ICD_ABBREVIATIONS) ||
    (typeof require === "function" ? require("../dict/abbreviations.js") : { abbreviations: [], zhSynonyms: [] });

  /** Lookup key of an abbreviation: case, spaces and punctuation do not matter ("C/S" = "cs"). */
  function abbrKey(text) { return zhFold(text); }

  /** Split text into search tokens. A piece with Chinese characters is one token. */
  function tokenize(text) {
    var out = [];
    fold(text).trim().split(/\s+/).forEach(function (chunk) {
      if (!chunk) return;
      if (hasCJK(chunk)) { var z = zhFold(chunk); if (z) out.push(z); }
      else normalize(chunk).split(" ").forEach(function (w) { if (w) out.push(w); });
    });
    return out;
  }

  function codeList(spec) {
    if (!spec) return [];
    return (Array.isArray(spec) ? spec : String(spec).split(/[\s,]+/)).filter(Boolean).map(function (c) { return nodot(c); });
  }

  /** key -> { label, meanings: [{ zh, en, alts: [[token]], codes: [code or "PREFIX*"] }] } */
  function compileAbbreviations(list) {
    var map = Object.create(null);
    (list || []).forEach(function (row) {
      var key = abbrKey(row.abbr || "");
      if (!key) return;
      var item = map[key] || (map[key] = { label: row.abbr, meanings: [] });
      var phrases = String(row.search || "").split("|").map(function (s) { return s.trim(); }).filter(Boolean);
      item.meanings.push({
        zh: row.zh || "", en: phrases[0] || "",
        alts: phrases.map(tokenize).filter(function (a) { return a.length; }),
        codes: codeList(row.codes)
      });
    });
    return map;
  }
  var ABBREVIATIONS = compileAbbreviations(DICT.abbreviations);
  var ZH_SYNONYMS = (DICT.zhSynonyms || []).map(function (p) { return [zhFold(p[0]), zhFold(p[1])]; });

  function abbreviation(text) { return ABBREVIATIONS[abbrKey(text)] || null; }

  /** Words of the query -> search variants. Each variant is a list of tokens that must all match. */
  function expandWords(words) {
    var variants = [[]], expanded = [];
    words.forEach(function (w) {
      var options;
      if (w.abbr) {
        // As typed, an abbreviation must be a whole word ("gi" must not match "gingival").
        options = [[{ s: w.text, whole: true }]];
        w.abbr.meanings.forEach(function (m) {
          m.alts.forEach(function (alt) { options.push(alt.map(function (s) { return { s: s }; })); });
        });
        expanded.push({ abbr: w.abbr.label, meanings: w.abbr.meanings.map(function (m) { return { zh: m.zh, en: m.en }; }) });
      } else {
        options = [[{ s: w.text }]];
        if (hasCJK(w.text)) {
          ZH_SYNONYMS.forEach(function (p) {
            if (w.text.indexOf(p[0]) !== -1) options.push([{ s: w.text.split(p[0]).join(p[1]) }]);
            else if (w.text.indexOf(p[1]) !== -1) options.push([{ s: w.text.split(p[1]).join(p[0]) }]);
          });
        }
      }
      var next = [];
      variants.forEach(function (v) { options.forEach(function (o) { next.push(v.concat(o)); }); });
      variants = next.slice(0, MAX_VARIANTS);
    });
    variants = variants.map(function (v) { return v.map(prepare); });
    var all = {};
    variants.forEach(function (v) { v.forEach(function (tk) { all[tk.s] = 1; }); });
    return { variants: variants, tokens: Object.keys(all), expanded: expanded };
  }

  function prepare(tk) {
    var zh = hasCJK(tk.s);
    return { s: tk.s, zh: zh, pre: " " + tk.s + (tk.whole ? " " : ""), word: " " + tk.s + " " };
  }

  /* ------------------------------------------------------------ query parsing */

  /** Classify raw user input as a code (prefix), a CM code range, or keywords. */
  function parseQuery(raw) {
    var q = String(raw || "").trim();
    if (!q) return { kind: "empty", q: q };
    var up = fold(q).toUpperCase();
    var m = up.replace(/\s+/g, " ").match(RANGE_RE);
    if (m) {
      var a = nodot(m[1]), b = nodot(m[2]);
      if (a > b) { var t = a; a = b; b = t; }
      return { kind: "range", q: q, start: a, end: b };
    }
    if (CODEISH_RE.test(up)) return { kind: "code", q: q, code: nodot(up) };
    return keywordQuery(q);
  }

  function keywordQuery(q) {
    var words = [];
    fold(q).trim().split(/\s+/).forEach(function (chunk) {
      if (!chunk) return;
      var a = abbreviation(chunk);
      if (a) { words.push({ text: abbrKey(chunk), abbr: a }); return; }
      tokenize(chunk).forEach(function (w) {
        var wa = abbreviation(w);
        words.push(wa ? { text: w, abbr: wa } : { text: w });
      });
    });
    if (!words.length) return { kind: "empty", q: q };
    var x = expandWords(words);
    return {
      kind: "keyword", q: q, words: words.map(function (w) { return w.text; }),
      tokens: x.tokens, variants: x.variants, expanded: x.expanded,
      // Pinned codes apply only when the whole query is one abbreviation.
      pins: words.length === 1 && words[0].abbr ? pinOrder(words[0].abbr) : []
    };
  }

  /** Pinned codes of all meanings, first code of each meaning first. */
  function pinOrder(abbr) {
    var out = [], seen = {}, more = true;
    for (var i = 0; more; i++) {
      more = false;
      abbr.meanings.forEach(function (m) {
        if (i < m.codes.length) { more = true; if (!seen[m.codes[i]]) { seen[m.codes[i]] = 1; out.push(m.codes[i]); } }
      });
    }
    return out;
  }

  /* ------------------------------------------------------------ index build */

  function parseTerms(tsv, src) {
    if (!tsv) return [];
    var lines = tsv.split("\n"), out = [], stack = [];
    for (var i = 0; i < lines.length; i++) {
      var p = lines[i].split("\t"), level = +p[0];
      stack.length = level;
      stack.push(p[1]);
      // PCS index terms that only hold a "see" have no title: they belong to the term above.
      var path = stack.filter(Boolean);
      out.push({
        src: src, path: path, level: level,
        code: p[2] || "", manif: p[3] || "", see: p[4] || "", seeAlso: p[5] || "",
        hay: " " + normalize(path.join(" ")) + " ",
        leaf: " " + normalize(p[1] || path[path.length - 1] || "") + " "
      });
    }
    return out;
  }

  function parseTable(tbl, src) {
    if (!tbl) return { heads: [], rows: [] };
    var lines = tbl.rows.split("\n"), rows = [], stack = [], n = tbl.heads.length - 1;
    for (var i = 0; i < lines.length; i++) {
      var p = lines[i].split("\t"), level = +p[0];
      stack.length = level;
      stack.push(p[1]);
      var path = stack.slice();
      rows.push({
        src: src, path: path, level: level, cells: p.slice(2, 2 + n), see: p[2 + n] || "",
        hay: " " + normalize(path.join(" ")) + " ", leaf: " " + normalize(p[1]) + " "
      });
    }
    return { heads: tbl.heads, rows: rows };
  }

  /**
   * Build the in-memory index of one version.
   * data: CM data object (data/icd10cm-<id>.js). pcs: PCS data object (data/icd10pcs-<id>.js) or nothing.
   */
  function createIndex(data, pcs) {
    var entries = [], byCode = new Map();
    var notes = data.notes || {};

    function add(tsv, sys) {
      var lines = tsv.split("\n");
      for (var i = 0; i < lines.length; i++) {
        var p = lines[i].split("\t"), code = p[0], n = sys === "cm" ? notes[code] : null;
        var alt = n ? [].concat(n.inc || [], n.term || []).join(" ") : "";
        var e = {
          i: entries.length, sys: sys, code: code, dot: sys === "cm" ? dotted(code) : code,
          billable: p[1] === "1", desc: p[2], zh: p[3] || "",
          hay: " " + normalize(p[2]) + " ", alt: alt ? " " + normalize(alt) + " " : "",
          zhHay: p[3] ? zhFold(p[3]) : "",
          parent: null, children: []
        };
        entries.push(e);
        byCode.set(code, e);
      }
    }
    add(data.codes, "cm");
    var cmCount = entries.length;
    for (var j = 0; j < cmCount; j++) {
      var en = entries[j];
      for (var len = en.code.length - 1; len >= 3; len--) {
        var par = byCode.get(en.code.slice(0, len));
        if (par) { en.parent = par; par.children.push(en); break; }
      }
    }
    if (pcs) add(pcs.codes, "pcs");

    return {
      data: data, entries: entries, byCode: byCode, cmCount: cmCount,
      hasZh: !!data.zh, hasPcs: !!pcs,
      pcs: pcs ? { sections: pcs.sections, systems: pcs.systems, tables: pcs.tables, counts: null } : null,
      chapters: data.chapters, sections: data.sections, notes: notes,
      terms: parseTerms(data.index, "index").concat(parseTerms(data.eindex, "eindex")),
      pterms: pcs ? parseTerms(pcs.index, "pindex") : [],
      drug: parseTable(data.drug, "drug"),
      neoplasm: parseTable(data.neoplasm, "neoplasm"),
      vocab: null, sorted: null
    };
  }

  function get(index, code) { return index.byCode.get(nodot(code)) || null; }

  /** How a code is written: PCS codes have no dot. Works for codes that are not in this version too. */
  function display(index, code) {
    code = nodot(code);
    var e = index && index.byCode.get(code);
    if (e) return e.dot;
    // Not in this version: PCS codes are 7 characters and (unlike CM) may start with a digit.
    if (/^\d/.test(code) || (code.length === 7 && index && !index.byCode.has(code.slice(0, 3)))) return code;
    return dotted(code);
  }

  /** Resolve a CM index/table code like "C79.8-" or "E08.-" to the closest existing CM code. */
  function resolve(index, code) {
    var c = nodot(String(code).replace(/[-.\s]+$/, ""));
    for (; c.length >= 3; c = c.slice(0, -1)) { var e = index.byCode.get(c); if (e && e.sys === "cm") return e; }
    return null;
  }

  /** All codes that start with a prefix, in code order (binary search on a sorted copy). */
  function prefixEntries(index, prefix, limit) {
    prefix = nodot(prefix);
    if (!index.sorted) {
      index.sorted = index.entries.slice().sort(function (a, b) { return a.code < b.code ? -1 : a.code > b.code ? 1 : 0; });
    }
    var s = index.sorted, lo = 0, hi = s.length, out = [];
    while (lo < hi) { var mid = (lo + hi) >> 1; if (s[mid].code < prefix) lo = mid + 1; else hi = mid; }
    for (; lo < s.length && s[lo].code.lastIndexOf(prefix, 0) === 0 && out.length < (limit || MAX_EXPAND); lo++) out.push(s[lo]);
    return out;
  }

  function ancestors(entry) {
    var out = [];
    for (var p = entry.parent; p; p = p.parent) out.unshift(p);
    return out;
  }
  function sectionOf(index, entry) {
    if (entry.sys !== "cm") return null;
    var s = index.data.cat2sec[entry.code.slice(0, 3)];
    return s == null ? null : index.sections[s];
  }
  function chapterOf(index, entry) { var s = sectionOf(index, entry); return s ? index.chapters[s.c] : null; }

  /** Nearest 7th-character definition (own or inherited) for a CM code. */
  function seventhChar(index, entry) {
    for (var e = entry; e; e = e.parent) {
      var n = index.notes[e.code];
      if (n && n.s7) return { from: e, defs: n.s7, note: n.s7note || [] };
    }
    return null;
  }

  /** Index entries that point at a code (CM: exact code; PCS: the term's code prefix covers the code). */
  function indexTermsFor(index, entry, limit) {
    var out = [], i, t, max = limit || 30;
    if (entry.sys === "pcs") {
      for (i = 0; i < index.pterms.length && out.length < max; i++) {
        t = index.pterms[i];
        if (t.code.length >= 4 && entry.code.lastIndexOf(t.code, 0) === 0) out.push(t);
      }
      return out;
    }
    for (i = 0; i < index.terms.length && out.length < max; i++) {
      t = index.terms[i];
      if (t.code && nodot(t.code.replace(/[-.]+$/, "")) === entry.code) out.push(t);
    }
    return out;
  }

  /* ------------------------------------------------------------ PCS structure */

  /** Table (first 3 characters) of a PCS code or prefix: { code, section, system, operation, def, ... }. */
  function pcsTable(index, code) {
    var key = nodot(code).slice(0, 3), tb = index.pcs && index.pcs.tables[key];
    return tb ? { code: key, labels: tb.l, axes: tb.ax, def: tb.def || "", rows: tb.rows } : null;
  }

  /** Meaning of each of the 7 characters of a PCS code: [{ pos, axis, ch, label }]. */
  function pcsParts(index, code) {
    code = nodot(code);
    var tb = pcsTable(index, code);
    if (!tb || code.length !== 7) return null;
    var out = [0, 1, 2].map(function (i) { return { pos: i + 1, axis: tb.axes[i], ch: code[i], label: tb.labels[i] }; });
    for (var r = 0; r < tb.rows.length; r++) {
      var row = tb.rows[r], ok = true;
      for (var k = 0; k < 4; k++) if (!(code[3 + k] in row[k][1])) { ok = false; break; }
      if (!ok) continue;
      for (k = 0; k < 4; k++) out.push({ pos: 4 + k, axis: row[k][0], ch: code[3 + k], label: row[k][1][code[3 + k]] });
      return out;
    }
    return out;
  }

  /** Number of codes per PCS table, section and body system. */
  function pcsCounts(index) {
    if (!index.pcs) return {};
    if (index.pcs.counts) return index.pcs.counts;
    var c = {};
    for (var i = index.cmCount; i < index.entries.length; i++) {
      var code = index.entries[i].code;
      for (var n = 1; n <= 3; n++) { var k = code.slice(0, n); c[k] = (c[k] || 0) + 1; }
    }
    return (index.pcs.counts = c);
  }

  /** 4th-character groups of a PCS table: [{ ch, axis, label, count }]. */
  function pcsGroups(index, table) {
    var tb = pcsTable(index, table);
    if (!tb) return [];
    var seen = {}, order = [];
    prefixEntries(index, tb.code, 100000).forEach(function (e) {
      if (e.sys !== "pcs") return;
      var ch = e.code[3];
      if (!seen[ch]) {
        var parts = pcsParts(index, e.code);
        seen[ch] = { ch: ch, axis: parts[3] ? parts[3].axis : "", label: parts[3] ? parts[3].label : "", count: 0 };
        order.push(seen[ch]);
      }
      seen[ch].count++;
    });
    return order;
  }

  /* ------------------------------------------------------------ searching */

  /** Every code that starts with the input: the exact code first, the rest in official (tabular) order. */
  function searchCode(index, code) {
    var found = prefixEntries(index, code, Infinity);
    found.sort(function (a, b) { return a.i - b.i; });
    var exact = index.byCode.get(code), at = exact ? found.indexOf(exact) : -1;
    if (at > 0) { found.splice(at, 1); found.unshift(exact); }
    return found;
  }

  /** PCS tables that a code query points at (the query is a table, or the start of some tables). */
  function tablesForCode(index, code) {
    if (!index.pcs) return [];
    var out = [], tables = index.pcs.tables;
    if (code.length >= 3) { if (tables[code.slice(0, 3)]) out.push(pcsTable(index, code)); return out; }
    Object.keys(tables).forEach(function (k) { if (k.lastIndexOf(code, 0) === 0) out.push(pcsTable(index, k)); });
    return out;
  }

  function inRange(code, a, b) { return code.slice(0, a.length) >= a && code.slice(0, b.length) <= b; }

  function searchRange(index, a, b) {
    var depth = Math.min(a.length, b.length), all = [], top = [];
    for (var i = 0; i < index.cmCount; i++) {
      var e = index.entries[i];
      if (inRange(e.code, a, b)) { all.push(e); if (e.code.length === depth) top.push(e); }
    }
    return { all: all, top: top.length ? top : all };
  }

  /**
   * Score a Chinese token against a Chinese name; -1 when it does not match.
   * A contiguous match scores highest; characters in order with small gaps still match
   * ("B型肝炎" finds "B型病毒性肝炎").
   */
  function zhScore(hay, tok) {
    var at = hay.indexOf(tok);
    if (at !== -1) return 4 + (hay.length === tok.length ? 3 : 0) + (at === 0 ? 0.5 : 0);
    if (tok.length < 2) return -1;
    var best = -1, limit = tok.length + 3;
    for (var start = hay.indexOf(tok[0]); start !== -1; start = hay.indexOf(tok[0], start + 1)) {
      var p = start, gaps = 0;
      for (var k = 1; k < tok.length; k++) {
        var q = hay.indexOf(tok[k], p + 1);
        if (q === -1) return best < 0 ? -1 : 2.5 - best * 0.2;
        gaps += q - p - 1;
        p = q;
      }
      if (gaps <= limit && (best < 0 || gaps < best)) best = gaps;
    }
    return best < 0 ? -1 : 2.5 - best * 0.2;
  }

  /** Score a code against the tokens of one variant; -1 when some token is missing. */
  function scoreEntry(e, tokens) {
    var score = 0, inAlt = 0, zh = 0;
    for (var t = 0; t < tokens.length; t++) {
      var tok = tokens[t];
      if (tok.zh) {
        var z = e.zhHay ? zhScore(e.zhHay, tok.s) : -1;
        if (z < 0) return -1;
        score += z; zh++;
        continue;
      }
      if (e.hay.indexOf(tok.word) !== -1) score += 4;
      else if (e.hay.indexOf(tok.pre) !== -1) score += 3;
      else if (e.alt && e.alt.indexOf(tok.pre) !== -1) score += 1;
      else if (e.code.toLowerCase().lastIndexOf(tok.s, 0) === 0) score += 3;
      else return -1;
      if (e.alt && e.alt.indexOf(tok.pre) !== -1) inAlt++;
    }
    if (inAlt === tokens.length && tokens.length === 1) score += 1;
    if (!tokens[0].zh && e.hay.lastIndexOf(tokens[0].pre, 0) === 0) score += 1;
    // Shorter codes and shorter names first.
    var length = zh === tokens.length ? e.zhHay.length / 10 : e.desc.length / 30;
    return score + (7 - e.code.length) * 0.3 - length;
  }

  /** Score an index term or table row path; -1 when some token is missing. */
  function scoreTerm(t, tokens) {
    var score = 0, inLeaf = 0;
    for (var k = 0; k < tokens.length; k++) {
      var tok = tokens[k];
      if (t.hay.indexOf(tok.word) !== -1) score += 4;
      else if (t.hay.indexOf(tok.pre) !== -1) score += 3;
      else return -1;
      if (t.leaf.indexOf(tok.pre) !== -1) inLeaf++;
    }
    // Did the query land on this very term (not just on an ancestor)?
    t._leafHit = inLeaf > 0;
    if (t.level === 0 && inLeaf === tokens.length) score += 2;
    // Sub-terms that only match through their parent go below direct matches.
    if (!inLeaf) score -= 3;
    return score - t.level * 0.8 - t.hay.length / 60;
  }

  function scan(list, tokens, limit) {
    var hits = [], first = tokens[0].pre;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t.hay.indexOf(first) === -1) continue;
      var s = scoreTerm(t, tokens);
      if (s >= 0) hits.push({ t: t, s: s, leafHit: t._leafHit });
    }
    hits.sort(function (x, y) { return y.s - x.s; });
    return limit ? hits.slice(0, limit) : hits;
  }

  /** Resolve a CM "see" text such as "Infarct, myocardium" to the index term it names. */
  function followSee(index, see) {
    var parts = see.split(";")[0].split(",").map(normalize).filter(Boolean);
    if (!parts.length || /^(condition|category)/.test(parts[0])) return null;
    for (var i = 0; i < index.terms.length; i++) {
      var t = index.terms[i];
      if (t.level !== 0 || t.leaf.lastIndexOf(" " + parts[0], 0) !== 0) continue;
      if (parts.length === 1) return t.code ? t : null;
      // Look for the sub-term among this main term's direct children.
      for (var j = i + 1; j < index.terms.length && index.terms[j].level > 0; j++) {
        var c = index.terms[j];
        if (c.level === 1 && c.leaf.lastIndexOf(" " + parts[1], 0) === 0) return c.code ? c : null;
      }
      return null;
    }
    return null;
  }

  /** Entries named by an abbreviation's pinned codes ("I10", or a prefix "0210*"), in order. */
  function pinnedEntries(index, pins) {
    var out = [], seen = new Set();
    pins.forEach(function (spec) {
      var found = spec.slice(-1) === "*" ? prefixEntries(index, spec.slice(0, -1)) : [index.byCode.get(spec)];
      found.forEach(function (e) { if (e && !seen.has(e)) { seen.add(e); out.push(e); } });
    });
    return out;
  }

  /** Search every variant (literal words and abbreviation meanings) and keep each item's best score. */
  function searchKeyword(index, query, opts) {
    var boost = opts && opts.boost;
    var scores = new Map(), via = new Map(), terms = new Map(), drug = new Map(), neo = new Map();
    function keep(map, key, s, extra) {
      var cur = map.get(key);
      if (!cur || s > cur.s) map.set(key, { s: s, x: extra });
    }
    query.variants.forEach(function (tokens) {
      var r = searchVariant(index, tokens);
      r.scores.forEach(function (s, e) { keep(scores, e, s, r.via.get(e)); });
      r.termHits.forEach(function (h) { keep(terms, h.t, h.s); });
      r.drug.forEach(function (h) { keep(drug, h.t, h.s); });
      r.neo.forEach(function (h) { keep(neo, h.t, h.s); });
    });
    var pinned = pinnedEntries(index, query.pins || []);
    pinned.forEach(function (e, k) { scores.set(e, { s: PIN_SCORE - k, x: undefined, pin: true }); });

    function ranked(map, limit, withBoost) {
      var arr = [];
      map.forEach(function (v, k) { arr.push({ k: k, s: v.s + (withBoost && boost && !v.pin ? boost(k.code) : 0) }); });
      arr.sort(function (x, y) { return y.s - x.s || (x.k.i || 0) - (y.k.i || 0); });
      return (limit ? arr.slice(0, limit) : arr).map(function (x) { return x.k; });
    }
    scores.forEach(function (v, e) { if (v.x) via.set(e, v.x); });
    return {
      items: ranked(scores, 0, true),
      via: via,
      pinned: pinned.length,
      terms: ranked(terms, 50),
      termTotal: terms.size,
      tables: { drug: ranked(drug, 30), neoplasm: ranked(neo, 30) }
    };
  }

  function searchVariant(index, tokens) {
    var scores = new Map(), via = new Map();
    var first = tokens[0], zhOnly = first.zh, anyZh = tokens.some(function (t) { return t.zh; });
    var lead = zhOnly ? first.s[0] : first.pre;

    for (var i = 0; i < index.entries.length; i++) {
      var e = index.entries[i];
      if (zhOnly) { if (e.zhHay.indexOf(lead) === -1) continue; }
      else if (e.hay.indexOf(lead) === -1 && e.alt.indexOf(lead) === -1 &&
          e.code.toLowerCase().lastIndexOf(first.s, 0) !== 0) continue;
      var s = scoreEntry(e, tokens);
      if (s >= 0) scores.set(e, s);
    }
    // The official indexes and tables are English only.
    if (anyZh) return { scores: scores, via: via, termHits: [], drug: [], neo: [] };

    // CM Alphabetic Index hits: list them, and let the codes they point to rank higher.
    var termHits = scan(index.terms, tokens);
    var idxBest = new Map();
    termHits.forEach(function (h) {
      if (!h.leafHit || !h.t.code) return;
      var target = resolve(index, h.t.code);
      if (!target) return;
      var cur = idxBest.get(target);
      if (!cur || h.s > cur.s) idxBest.set(target, h);
    });
    // Follow "see" cross-references one level (e.g. Attack, heart -> see Infarct, myocardium).
    termHits.slice(0, 20).forEach(function (h) {
      if (!h.leafHit || h.t.code || !h.t.see) return;
      var ref = followSee(index, h.t.see);
      if (!ref) return;
      var target = resolve(index, ref.code);
      if (!target) return;
      var cur = idxBest.get(target), s = h.s - 0.5;
      if (!cur || s > cur.s) idxBest.set(target, { s: s, t: { path: h.t.path.concat(["→ " + h.t.see]), code: ref.code } });
    });

    // PCS Index hits point at a code, or at the first characters of a group of codes.
    var pHits = index.pterms.length ? scan(index.pterms, tokens) : [];
    pHits.slice(0, 40).forEach(function (h) {
      if (!h.leafHit || !h.t.code) return;
      var shown = h.t.see ? { path: h.t.path.concat(["→ " + h.t.see]), code: h.t.code } : h.t;
      prefixEntries(index, h.t.code).forEach(function (target) {
        if (target.sys !== "pcs") return;
        var cur = idxBest.get(target);
        if (!cur || h.s > cur.s) idxBest.set(target, { s: h.s, t: shown });
      });
    });

    idxBest.forEach(function (h, target) {
      var desc = scores.get(target);
      if (desc == null) { scores.set(target, h.s); via.set(target, h.t); }
      else scores.set(target, Math.max(desc, h.s) + 1);
    });

    return {
      scores: scores, via: via, termHits: termHits.concat(pHits),
      drug: scan(index.drug.rows, tokens, 30), neo: scan(index.neoplasm.rows, tokens, 30)
    };
  }

  /* ------------------------------------------------------------ spelling */

  function buildVocab(index) {
    if (index.vocab) return index.vocab;
    var freq = new Map();
    function add(text) {
      text.split(" ").forEach(function (w) { if (w.length >= 3 && !/^\d/.test(w)) freq.set(w, (freq.get(w) || 0) + 1); });
    }
    index.entries.forEach(function (e) { add(e.hay); });
    index.terms.forEach(function (t) { add(t.leaf); });
    index.pterms.forEach(function (t) { add(t.leaf); });
    var words = Array.from(freq.keys()).sort();
    index.vocab = { words: words, freq: freq };
    return index.vocab;
  }

  function hasPrefix(sorted, p) {
    var lo = 0, hi = sorted.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (sorted[mid] < p) lo = mid + 1; else hi = mid; }
    return lo < sorted.length && sorted[lo].lastIndexOf(p, 0) === 0;
  }

  // Optimal-string-alignment distance with an early exit above `max`.
  function distance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev2 = null, prev = [], cur;
    for (var j = 0; j <= b.length; j++) prev[j] = j;
    for (var i = 1; i <= a.length; i++) {
      cur = [i];
      var rowMin = i;
      for (j = 1; j <= b.length; j++) {
        var cost = a[i - 1] === b[j - 1] ? 0 : 1;
        var v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      prev2 = prev; prev = cur;
    }
    return prev[b.length];
  }

  /** "Did you mean": replace English words that match nothing with the closest known word. */
  function spellSuggest(index, words) {
    var vocab = buildVocab(index), changed = false;
    var fixed = words.map(function (w) {
      if (w.length < 4 || /\d/.test(w) || hasCJK(w) || ABBREVIATIONS[w] || hasPrefix(vocab.words, w)) return w;
      var max = w.length <= 5 ? 1 : 2, best = null, bestD = max + 1, bestF = 0;
      for (var i = 0; i < vocab.words.length; i++) {
        var c = vocab.words[i];
        // Compare against the candidate trimmed to roughly the typed length, so partial words still match.
        var cut = c.length > w.length + 1 ? c.slice(0, w.length) : c;
        var d = distance(w, cut, max);
        var f = vocab.freq.get(c);
        if (d < bestD || (d === bestD && f > bestF)) { best = c; bestD = d; bestF = f; }
      }
      if (best && bestD <= max) { changed = true; return best; }
      return w;
    });
    return changed ? fixed.join(" ") : null;
  }

  /* ------------------------------------------------------------ public search */

  /**
   * Run a search. Returns { query, items, ... }.
   * Code: items = the exact code first, then every code that starts with the input; pcsTables.
   * Range (CM): items = top-level codes, all = every code in range.
   * Keyword: also terms (official indexes), tables (drug / neoplasm), via (code -> index term), suggestion.
   * opts.boost(code) adds a personal ranking bonus for keyword results.
   *
   * Input that could be either a code or a word is decided like this:
   *   - it is in the abbreviation dictionary, or has no digit ("copd", "ch"): keywords first, codes if nothing matches
   *   - it has a digit ("E11", "0DT", "b12"): codes first, keywords if no code starts with it
   */
  function search(index, raw, opts) {
    var query = parseQuery(raw);
    if (query.kind === "empty") return { query: query, items: [] };
    if (query.kind === "range") {
      var r = searchRange(index, query.start, query.end);
      return { query: query, items: r.top, all: r.all };
    }
    var codeQuery = null;
    if (query.kind === "code") {
      codeQuery = query;
      var wordFirst = !/\d/.test(query.code) || !!abbreviation(query.q);
      if (!wordFirst) {
        var items = searchCode(index, query.code);
        if (items.length) return { query: query, items: items, pcsTables: tablesForCode(index, query.code) };
        codeQuery = null;
      }
      query = keywordQuery(query.q); // e.g. "a1c" looks like a code but is a word
      if (query.kind === "empty") return { query: query, items: [] };
    }
    var res = searchKeyword(index, query, opts);
    res.query = query;
    if (codeQuery && !res.items.length) {
      var byCode = searchCode(index, codeQuery.code);
      if (byCode.length) return { query: codeQuery, items: byCode, pcsTables: tablesForCode(index, codeQuery.code) };
    }
    var tableHits = res.tables.drug.length + res.tables.neoplasm.length;
    if (res.items.length + res.terms.length + tableHits < 3) res.suggestion = spellSuggest(index, query.words);
    return res;
  }

  /** Search for a phrase exactly as written: no abbreviation expansion, no pinned codes. */
  function searchLiteral(index, text) {
    var tokens = tokenize(text);
    if (!tokens.length) return { items: [] };
    return searchKeyword(index, { variants: [tokens.map(function (s) { return prepare({ s: s }); })], pins: [] });
  }

  function suggest(index, raw, limit, opts) {
    var res = search(index, raw, opts);
    return {
      query: res.query, total: res.items.length, items: res.items.slice(0, limit || 10),
      via: res.via, suggestion: res.suggestion || null, pcsTables: res.pcsTables || []
    };
  }

  return {
    nodot: nodot, dotted: dotted, display: display, normalize: normalize, zhFold: zhFold, hasCJK: hasCJK,
    parseQuery: parseQuery, createIndex: createIndex, get: get, resolve: resolve, prefixEntries: prefixEntries,
    ancestors: ancestors, sectionOf: sectionOf, chapterOf: chapterOf, seventhChar: seventhChar,
    indexTermsFor: indexTermsFor, pcsTable: pcsTable, pcsParts: pcsParts, pcsCounts: pcsCounts, pcsGroups: pcsGroups,
    search: search, searchLiteral: searchLiteral, suggest: suggest, spellSuggest: spellSuggest,
    abbreviation: abbreviation, abbrKey: abbrKey, tokenize: tokenize, compileAbbreviations: compileAbbreviations,
    ABBREVIATIONS: ABBREVIATIONS, DICT: DICT
  };
});
