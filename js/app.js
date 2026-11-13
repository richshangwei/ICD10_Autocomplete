/*
 * UI: versions, routing, autocomplete, views.
 * Depends on ICDCore, I18N, Store, Sync, ICD10CM_VERSIONS, ICD10CM_CHANGES.
 */
(function () {
  "use strict";
  var C = window.ICDCore, t = I18N.t, Store = window.Store, Sync = window.Sync;
  var MANIFEST = window.ICD10CM_VERSIONS, CHANGES = window.ICD10CM_CHANGES || [];
  var PAGE_SIZE = 50, SUGGEST_LIMIT = 8, VKEY = "icd10cm.version";
  var index = null, current = null;

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var main = $("#main"), input = $("#q"), list = $("#suggest"), vSelect = $("#version-select");

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  /** How a code is written (CM with a dot, PCS without). */
  function show(code) { return C.display(index, code); }
  function codeHref(code) { return "#/code/" + encodeURIComponent(show(code)); }
  function searchHref(q, extra) { return "#/search?" + new URLSearchParams(Object.assign({ q: q }, extra || {})).toString(); }
  function pcsHref(key) { return "#/pcs/" + encodeURIComponent(key); }
  function timeStr(ms) { return new Date(ms).toLocaleTimeString(I18N.lang, { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  var searchOpts = { boost: function (code) { return Store.boost(code); } };

  /* ================================================================ versions */
  function vInfo(id) { return MANIFEST.versions.filter(function (v) { return v.id === id; })[0] || null; }
  function vName(id) { var v = vInfo(id); return v ? t("vLabel", v) : id; }
  function vOrder(id) { return MANIFEST.versions.map(function (v) { return v.id; }).indexOf(id); }
  function defaultVersion() { return vInfo(MANIFEST.default) ? MANIFEST.default : MANIFEST.latest; }
  /** U.S. releases only: the NHI edition is not tied to a U.S. effective date. */
  function usVersions() { return MANIFEST.versions.filter(function (v) { return v.kind !== "nhi"; }); }
  function vEffective(v) { return v.kind === "nhi" ? t("nhiEffective", v) : t("effectiveFrom", v.effective); }

  function loadVersion(id) {
    var v = vInfo(id);
    function cm() { return window.ICD10CM_DATA && window.ICD10CM_DATA[id]; }
    function pcs() { return window.ICD10PCS_DATA && window.ICD10PCS_DATA[id]; }
    // A version is one CM file, plus a PCS file when it has procedure codes; load them in order.
    function loadFile(file) {
      return new Promise(function (resolve, reject) {
        var s = document.createElement("script");
        s.src = file;
        s.onload = resolve;
        s.onerror = function () { reject(new Error(file)); };
        document.body.appendChild(s);
      });
    }
    var chain = Promise.resolve();
    if (!cm() || (v.pcs && !pcs())) v.files.forEach(function (f) { chain = chain.then(function () { return loadFile(f); }); });
    return chain.then(function () {
      if (!cm()) throw new Error(v.files[0]);
      // Building the index can take a second; yield first so the loading message paints.
      return new Promise(function (r) { setTimeout(function () { r(C.createIndex(cm(), pcs())); }, 0); });
    });
  }

  function switchVersion(id, announce) {
    if (!vInfo(id)) id = defaultVersion();
    if (index && id === current) return Promise.resolve();
    main.innerHTML = '<p class="loading">' + esc(t("loadingVersion", vName(id))) + "</p>";
    return loadVersion(id).then(function (ix) {
      // Free the previous version's raw data.
      if (current && current !== id && window.ICD10CM_DATA) delete window.ICD10CM_DATA[current];
      if (current && current !== id && window.ICD10PCS_DATA) delete window.ICD10PCS_DATA[current];
      index = ix; current = id;
      try { localStorage.setItem(VKEY, id); } catch (e) { /* ignore */ }
      fillVersionSelect();
      applyLanguage();
      render();
      if (announce) toast(t("switchedTo", vName(id)));
    }).catch(function (err) {
      main.innerHTML = '<p class="empty">' + esc(t("loadVersionFailed", err.message)) + "</p>";
    });
  }

  function fillVersionSelect() {
    // The default version first, then the others, newest first.
    var order = MANIFEST.versions.slice().reverse().sort(function (a, b) {
      return (b.id === defaultVersion()) - (a.id === defaultVersion());
    });
    vSelect.innerHTML = order.map(function (v) {
      return '<option value="' + esc(v.id) + '"' + (v.id === current ? " selected" : "") + ">" + esc(t("vLabel", v)) + "</option>";
    }).join("");
    vSelect.setAttribute("aria-label", t("versionLabel"));
    vSelect.title = vInfo(current) ? vEffective(vInfo(current)) : "";
  }
  vSelect.addEventListener("change", function () { switchVersion(vSelect.value, true); });

  /* Code history from the precomputed change lists, limited to versions up to the current one. */
  var history = null;
  function codeHistory() {
    if (history) return history;
    history = { added: {}, revised: {}, deleted: {} };
    CHANGES.forEach(function (p) {
      p.added.forEach(function (r) { history.added[r[0]] = p.to; });
      p.revised.forEach(function (r) { (history.revised[r[0]] = history.revised[r[0]] || []).push(p.to); });
      p.deleted.forEach(function (r) { history.deleted[r[0]] = p.to; });
    });
    return history;
  }
  function versionForDate(d) {
    var pick = null;
    usVersions().forEach(function (v) { if (v.effective <= d) pick = v.id; });
    return pick;
  }

  /* ================================================================ rendering helpers */
  function reEscape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function tokensOf(query, zh) {
    if (!query || query.kind !== "keyword") return [];
    return query.tokens.filter(function (s) { return C.hasCJK(s) === zh; })
      .sort(function (a, b) { return b.length - a.length; }).map(reEscape);
  }
  function markAll(text, re, group) {
    var out = "", last = 0, m;
    while ((m = re.exec(text))) {
      var start = m.index + (group ? m[1].length : 0), hit = group ? m[2] : m[0];
      out += esc(text.slice(last, start)) + "<mark>" + esc(hit) + "</mark>";
      last = start + hit.length;
      if (m[0].length === 0) re.lastIndex++;
    }
    return out + esc(text.slice(last));
  }
  /** Highlight English words that start with a search token. */
  function highlight(text, query) {
    var toks = tokensOf(query, false);
    return toks.length ? markAll(text, new RegExp("(^|[^A-Za-z0-9])(" + toks.join("|") + ")", "gi"), true) : esc(text);
  }
  /** Highlight Chinese search tokens wherever they appear. */
  function highlightZh(text, query) {
    var toks = tokensOf(query, true);
    return toks.length ? markAll(text, new RegExp(toks.join("|"), "gi"), false) : esc(text);
  }
  function highlightCode(dot, query) {
    if (!query || query.kind !== "code") return esc(dot);
    var n = query.code.length, i = 0, k = 0;
    while (k < dot.length && i < n) { if (dot[k] !== ".") i++; k++; }
    return "<mark>" + esc(dot.slice(0, k)) + "</mark>" + esc(dot.slice(k));
  }
  /** English description plus the Chinese name when the version has one. */
  function descHtml(e, query, extra) {
    var en = highlight(e.desc, query), zh = e.zh ? highlightZh(e.zh, query) : "";
    if (!zh) return '<span class="d-1">' + en + (extra || "") + "</span>";
    // The interface language decides which name leads.
    return I18N.lang === "en"
      ? '<span class="d-1">' + en + (extra || "") + '</span><span class="d-2" lang="zh-Hant">' + zh + "</span>"
      : '<span class="d-1" lang="zh-Hant">' + zh + (extra || "") + '</span><span class="d-2" lang="en">' + en + "</span>";
  }
  function badge(e) {
    if (e.sys === "pcs") return '<span class="badge badge-p" title="' + esc(t("pcsBadgeLong")) + '">' + esc(t("pcsBadge")) + "</span>";
    return e.billable
      ? '<span class="badge badge-b" title="' + esc(t("billableLong")) + '">' + esc(t("billable")) + "</span>"
      : '<span class="badge badge-h" title="' + esc(t("nonBillableLong")) + '">' + esc(t("nonBillable")) + "</span>";
  }
  function starSvg(on) {
    return '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill="' +
      (on ? "currentColor" : "none") + '" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  }
  function starButton(code) {
    var on = Store.isFav(code), label = on ? t("removeFav") : t("addFav");
    return '<button type="button" class="star' + (on ? " on" : "") + '" data-star="' + esc(code) + '" aria-pressed="' + on +
      '" aria-label="' + esc(label + " " + show(code)) + '" title="' + esc(label) + '">' + starSvg(on) + "</button>";
  }
  /** "高血壓（hypertension）" for each meaning of an expanded abbreviation. */
  function meaningText(x) {
    return x.meanings.map(function (m) {
      // A Chinese search phrase adds nothing to the Chinese meaning.
      return m.zh && m.en && !C.hasCJK(m.en) ? m.zh + "（" + m.en + "）" : m.zh || m.en;
    }).join(" / ");
  }
  /** Expansions worth showing: not the ones that only repeat what was typed (糖尿病 → 糖尿病). */
  function expansions(query) {
    return (query.expanded || []).filter(function (x) { return meaningText(x) !== x.abbr; });
  }
  function viaLine(term, query) {
    return '<span class="via">' + esc(t("viaIndex")) + highlight(term.path.join(" › "), query) + "</span>";
  }
  function codeRow(e, query, opts) {
    opts = opts || {};
    var count = opts.childCount && e.children.length ? ' <span class="muted small">· ' + e.children.length + "</span>" : "";
    return '<li class="row"><a class="row-link" href="' + codeHref(e.code) + '">' +
      '<span class="code">' + highlightCode(e.dot, query) + "</span>" +
      '<span class="desc">' + descHtml(e, query, count) + (opts.via ? viaLine(opts.via, query) : "") +
      "</span>" + badge(e) + "</a>" + starButton(e.code) + "</li>";
  }
  /** Link a CM index/table code like "C79.8-" to the closest existing code. */
  function codeLink(raw) {
    if (!raw) return "";
    var e = C.resolve(index, raw);
    return e ? '<a class="code" href="' + codeHref(e.code) + '">' + esc(raw) + "</a>" : '<span class="code">' + esc(raw) + "</span>";
  }
  /** Link a PCS index target: a full code, a table (3 characters), or the first characters of a group of codes. */
  function pcsLink(raw) {
    if (!raw) return "";
    var e = C.get(index, raw);
    if (e && e.sys === "pcs") return '<a class="code" href="' + codeHref(e.code) + '">' + esc(raw) + "</a>";
    if (raw.length === 3 && C.pcsTable(index, raw)) return '<a class="code" href="' + pcsHref(raw) + '">' + esc(raw) + "</a>";
    return '<a class="code" href="' + searchHref(raw) + '">' + esc(raw) + "…</a>";
  }
  function seeLinks(text, label) {
    if (!text) return "";
    return ' <span class="see"><em>' + esc(label) + "</em> " + text.split(";").map(function (s) {
      s = s.trim();
      return /^(condition|category)\b/i.test(s) ? esc(s) : '<a href="' + searchHref(s.replace(/,/g, " ")) + '">' + esc(s) + "</a>";
    }).join("; ") + "</span>";
  }
  function tableName(tb) { return tb.labels[1] + " › " + tb.labels[2]; }
  function copyText(text) {
    // Older way; also the fallback when the Clipboard API is missing or refuses (some file:// setups).
    function legacy() {
      return new Promise(function (resolve, reject) {
        var ta = document.createElement("textarea");
        ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        try { if (document.execCommand("copy")) resolve(); else reject(new Error("copy")); }
        catch (e) { reject(e); }
        finally { ta.remove(); }
      });
    }
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(legacy);
    return legacy();
  }

  /* ================================================================ toast */
  var toastTimer;
  function toast(msg) {
    var el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2200);
  }

  /* ================================================================ autocomplete */
  var ac = { items: [], active: -1, timer: null };

  function closeSuggest() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    ac.active = -1;
  }

  function renderSuggest() {
    var q = input.value;
    if (!index || !q.trim()) { ac.items = []; closeSuggest(); return; }
    var res = C.suggest(index, q, SUGGEST_LIMIT, searchOpts);
    var items = [];
    if (res.suggestion) items.push({ type: "spell", href: searchHref(res.suggestion), q: res.suggestion, label: t("didYouMean") + res.suggestion });
    if (res.query.kind === "range") {
      items.push({ type: "range", href: searchHref(q), label: t("suggestRange", C.dotted(res.query.start), C.dotted(res.query.end)) });
    }
    res.items.forEach(function (e) { items.push({ type: "code", entry: e, via: res.via && res.via.get(e), href: codeHref(e.code) }); });
    res.pcsTables.slice(0, 2).forEach(function (tb) {
      items.push({ type: "table", href: pcsHref(tb.code), label: t("pcsTableOf", tb.code) + "：" + tableName(tb) });
    });
    if (res.total > 0 && (res.query.kind === "keyword" || res.total > res.items.length)) {
      items.push({ type: "all", href: searchHref(q), label: t("suggestAll", res.total) });
    }
    ac.items = items;
    ac.active = -1;
    var html = items.map(function (it, i) {
      var id = "opt-" + i;
      if (it.type === "code") {
        var e = it.entry;
        return '<li role="option" id="' + id + '" data-i="' + i + '" aria-selected="false" class="opt">' +
          '<span class="code">' + highlightCode(e.dot, res.query) + "</span>" +
          '<span class="desc">' + descHtml(e, res.query) + (it.via ? viaLine(it.via, res.query) : "") + "</span>" + badge(e) + "</li>";
      }
      return '<li role="option" id="' + id + '" data-i="' + i + '" aria-selected="false" class="opt opt-' + it.type + '">' +
        '<span class="opt-label">' + esc(it.label) + '</span><span aria-hidden="true">→</span></li>';
    }).join("");
    if (!res.items.length && !res.suggestion && res.query.kind !== "range") html += '<li class="opt-empty" role="presentation">' + esc(emptyText(res.query)) + "</li>";
    if (expansions(res.query).length) {
      html = '<li class="opt-note" role="presentation">' + esc(t("expanded")) +
        expansions(res.query).map(function (x) { return esc(x.abbr + " → " + meaningText(x)); }).join("、") + "</li>" + html;
    }
    list.innerHTML = html;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.removeAttribute("aria-activedescendant");
  }
  /** Chinese input cannot match a version that has no Chinese names: say so. */
  function emptyText(query) {
    return !index.hasZh && C.hasCJK(query.q || "") ? t("noZhInVersion") : t("suggestEmpty");
  }

  function setActive(i) {
    var opts = $$(".opt", list);
    if (!opts.length) return;
    if (i < -1) i = opts.length - 1;
    if (i >= opts.length) i = -1;
    ac.active = i;
    opts.forEach(function (o, k) { o.setAttribute("aria-selected", String(k === i)); });
    if (i >= 0) { input.setAttribute("aria-activedescendant", opts[i].id); opts[i].scrollIntoView({ block: "nearest" }); }
    else input.removeAttribute("aria-activedescendant");
  }

  function activate(i) {
    var it = ac.items[i];
    if (!it) return;
    if (it.type === "spell") { input.value = it.q; renderSuggest(); return; }
    closeSuggest();
    if (it.type === "code") input.value = it.entry.dot;
    navigate(it.href, true);
  }

  function submitSearch() {
    var q = input.value.trim();
    if (!q || !index) return;
    closeSuggest();
    var pq = C.parseQuery(q);
    if (pq.kind === "code" && C.get(index, pq.code)) navigate(codeHref(pq.code), true);
    else navigate(searchHref(q), true);
  }

  input.addEventListener("input", function () { clearTimeout(ac.timer); ac.timer = setTimeout(renderSuggest, 60); });
  // Chinese input methods: search when a composition ends, not on every keystroke inside it.
  input.addEventListener("compositionend", function () { clearTimeout(ac.timer); ac.timer = setTimeout(renderSuggest, 60); });
  input.addEventListener("keydown", function (ev) {
    if (ev.isComposing) return;
    var open = !list.hidden;
    if (ev.key === "ArrowDown") { ev.preventDefault(); if (!open) renderSuggest(); else setActive(ac.active + 1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); if (open) setActive(ac.active - 1); }
    else if (ev.key === "Enter") {
      ev.preventDefault();
      clearTimeout(ac.timer);
      if (open && ac.active >= 0) activate(ac.active); else submitSearch();
    } else if (ev.key === "Escape") { if (open) { ev.preventDefault(); closeSuggest(); } }
    else if (ev.key === "Tab") closeSuggest();
  });
  input.addEventListener("focus", function () { if (input.value.trim()) renderSuggest(); });
  input.addEventListener("blur", function () { setTimeout(closeSuggest, 120); });
  list.addEventListener("mousedown", function (ev) {
    var li = ev.target.closest(".opt");
    if (!li) return;
    ev.preventDefault();
    activate(Number(li.getAttribute("data-i")));
  });
  list.addEventListener("mousemove", function (ev) {
    var li = ev.target.closest(".opt");
    if (li && Number(li.getAttribute("data-i")) !== ac.active) setActive(Number(li.getAttribute("data-i")));
  });
  $("#search-form").addEventListener("submit", function (ev) { ev.preventDefault(); submitSearch(); });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      ev.preventDefault(); input.focus(); input.select();
    }
  });

  /* ================================================================ routing */
  var focusMainOnRender = false;
  function navigate(href, focusMain) {
    focusMainOnRender = !!focusMain;
    if (location.hash === href) render(); else location.hash = href;
  }
  function route() {
    var h = location.hash.replace(/^#/, "") || "/";
    var qi = h.indexOf("?");
    var path = (qi >= 0 ? h.slice(0, qi) : h).split("/").filter(Boolean).map(decodeURIComponent);
    return { path: path, params: new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : "") };
  }

  function render() {
    if (!index) return;
    var r = route(), view = r.path[0] || "";
    var nav = { browse: "browse", chapter: "browse", section: "browse", pcs: "browse", favorites: "favorites", versions: "versions", changes: "versions" }[view] || "search";
    $$("[data-nav]").forEach(function (a) {
      if (a.getAttribute("data-nav") === nav) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (view === "search") viewSearch(r.params);
    else if (view === "code") viewCode(r.path[1] || "");
    else if (view === "browse") viewBrowse();
    else if (view === "chapter") viewChapter(r.path[1]);
    else if (view === "section") viewSection(r.path[1]);
    else if (view === "pcs") viewPcs(r.path[1] || "");
    else if (view === "favorites") viewFavorites();
    else if (view === "versions") viewVersions();
    else if (view === "changes") viewChanges(r.params);
    else viewHome();
    if (view !== "search" && view !== "code") input.value = "";
    window.scrollTo(0, 0);
    if (focusMainOnRender) { var h1 = $("h1", main); (h1 || main).focus({ preventScroll: true }); }
    focusMainOnRender = false;
  }
  window.addEventListener("hashchange", render);

  function setTitle(s) { document.title = (s ? s + " · " : "") + t("appTitle"); }

  /* ================================================================ views */
  function viewHome() {
    setTitle("");
    var ex = ["type 2 diabetes", "high blood pressure", "E11.9", "S72.0", "E08-E13", "aspirin", "heart attack"];
    if (index.hasZh) ex = ["糖尿病", "HTN", "肺癌", "E11.9", "高血壓 心臟", "E08-E13", "heart attack"];
    if (index.hasPcs) ex = ex.concat(["0DTJ4ZZ", "appendectomy", "CABG"]);
    var recent = Store.recent(8).map(function (c) { return C.get(index, c); }).filter(Boolean);
    var v = vInfo(current);
    var tips = ["tipKeyword", "tipAbbr"].concat(index.hasZh ? ["tipZh"] : [], ["tipCode", "tipRange"], index.hasPcs ? ["tipPcs"] : []);
    main.innerHTML =
      '<section class="hero"><h1 tabindex="-1">' + esc(t("appTitle")) + "</h1>" +
      '<p class="lead">' + esc(t("homeLead")) + "</p>" +
      '<p class="try">' + esc(t("tryThese")) + " " +
      ex.map(function (q) { return '<a class="chip" href="' + searchHref(q) + '">' + esc(q) + "</a>"; }).join(" ") + "</p></section>" +
      (recent.length ? '<section class="card"><div class="card-head"><h2>' + esc(t("recentTitle")) + '</h2><button type="button" class="linkish small" id="clear-recent">' +
        esc(t("clearRecent")) + '</button></div><ul class="rows compact">' + recent.map(function (e) { return codeRow(e); }).join("") +
        '</ul><p class="muted small">' + esc(t("rankHint")) + "</p></section>" : "") +
      '<section class="card tips"><h2>' + esc(t("tipsTitle")) + "</h2><ul>" +
      tips.map(function (k) { return "<li>" + esc(t(k)) + "</li>"; }).join("") + "</ul>" +
      '<p class="muted small">' + esc(t("dataInfo", vName(current), vEffective(v), index.cmCount, index.entries.length - index.cmCount)) +
      ' <a href="#/versions">' + esc(t("navVersions")) + "</a></p></section>";
    var cr = $("#clear-recent");
    if (cr) cr.addEventListener("click", function () { Store.clearUsage(); viewHome(); });
  }

  function viewSearch(params) {
    var q = params.get("q") || "";
    input.value = q;
    setTitle(q);
    var res = C.search(index, q, searchOpts), query = res.query;
    if (query.kind === "empty") { viewHome(); return; }
    var page = Math.max(1, parseInt(params.get("p"), 10) || 1);
    var filter = params.get("f") || "all", mode = params.get("m") || "top", sys = params.get("s") || "all";
    var tab = query.kind === "keyword" ? params.get("tab") || "codes" : "codes";

    function link(extra) {
      var p = { f: filter, m: mode, s: sys, p: 1, tab: tab };
      Object.assign(p, extra);
      if (p.f === "all") delete p.f;
      if (p.s === "all") delete p.s;
      if (p.m === "top" || query.kind !== "range") delete p.m;
      if (p.p === 1) delete p.p;
      if (p.tab === "codes") delete p.tab;
      return searchHref(q, p);
    }
    function seg(key, val, label, cur) {
      var o = {}; o[key] = val;
      return '<a class="seg' + (cur === val ? " on" : "") + '" href="' + link(o) + '"' + (cur === val ? ' aria-current="true"' : "") + ">" + label + "</a>";
    }

    var heading = query.kind === "range" ? t("rangeFor", C.dotted(query.start), C.dotted(query.end)) : t("resultsFor", q);
    var summary = query.kind === "range" ? t("rangeCount", res.items.length, res.all.length) : t("count", res.items.length);
    var html = '<div class="results-head"><h1 tabindex="-1">' + esc(heading) + "</h1>" + '<p class="muted">' + esc(summary) + "</p></div>";
    if (res.suggestion) html += '<p class="note-line">' + esc(t("didYouMean")) + '<a href="' + searchHref(res.suggestion) + '"><b>' + esc(res.suggestion) + "</b></a></p> ";
    if (expansions(query).length) {
      html += '<p class="note-line">' + esc(t("expanded")) + expansions(query).map(function (x) {
        return "<b>" + esc(x.abbr) + "</b> → " + esc(meaningText(x));
      }).join("、") + "</p>";
    }

    if (query.kind === "keyword") {
      var tableCount = res.tables.drug.length + res.tables.neoplasm.length;
      html += '<div class="tabs segs" role="navigation">' +
        seg("tab", "codes", esc(t("tabCodes")) + ' <span class="count">' + res.items.length.toLocaleString() + "</span>", tab) +
        seg("tab", "index", esc(t("tabIndex")) + ' <span class="count">' + res.termTotal.toLocaleString() + "</span>", tab) +
        seg("tab", "tables", esc(t("tabTables")) + ' <span class="count">' + tableCount + "</span>", tab) + "</div>";
      if (tab === "index") { main.innerHTML = html + indexTermsBlock(res, query); return; }
      if (tab === "tables") { main.innerHTML = html + tablesBlock(res, query); return; }
    }
    if (res.pcsTables && res.pcsTables.length) {
      html += '<p class="note-line">' + esc(t("pcsTables")) + "：" + res.pcsTables.slice(0, 12).map(function (tb) {
        return '<a href="' + pcsHref(tb.code) + '"><span class="code">' + esc(tb.code) + "</span> " + esc(tableName(tb)) + "</a>";
      }).join("、") + (res.pcsTables.length > 12 ? " …" : "") + "</p>";
    }

    var items = query.kind === "range" && mode === "all" ? res.all : res.items;
    var nCm = 0;
    items.forEach(function (e) { if (e.sys === "cm") nCm++; });
    var nPcs = items.length - nCm, both = nCm > 0 && nPcs > 0;
    if (!both) sys = "all";
    if (sys !== "all") items = items.filter(function (e) { return e.sys === sys; });
    if (filter === "b") items = items.filter(function (e) { return e.billable; });
    else if (filter === "h") items = items.filter(function (e) { return !e.billable; });
    var pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    if (page > pages) page = pages;
    var slice = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    html += '<div class="toolbar">';
    if (query.kind === "range") html += '<div class="segs">' + seg("m", "top", esc(t("rangeTop")), mode) + seg("m", "all", esc(t("rangeAll")), mode) + "</div>";
    if (both) {
      html += '<div class="segs">' + seg("s", "all", esc(t("filterAll")), sys) +
        seg("s", "cm", esc(t("sysCm")) + ' <span class="count">' + nCm.toLocaleString() + "</span>", sys) +
        seg("s", "pcs", esc(t("sysPcs")) + ' <span class="count">' + nPcs.toLocaleString() + "</span>", sys) + "</div>";
    }
    html += '<div class="segs">' + seg("f", "all", esc(t("filterAll")), filter) + seg("f", "b", esc(t("filterBillable")), filter) + seg("f", "h", esc(t("filterHeader")), filter) + "</div></div>";
    if (!slice.length) html += '<p class="empty">' + esc(!res.items.length && !index.hasZh && C.hasCJK(q) ? t("noZhInVersion") : t("noResults")) + "</p>";
    else html += '<ul class="rows">' + slice.map(function (e) {
      return codeRow(e, query, { childCount: query.kind === "range", via: res.via && res.via.get(e) });
    }).join("") + "</ul>";
    if (pages > 1) {
      html += '<nav class="pager" aria-label="Pagination">' +
        (page > 1 ? '<a href="' + link({ p: page - 1 }) + '">← ' + esc(t("prev")) + "</a>" : '<span class="disabled">← ' + esc(t("prev")) + "</span>") +
        "<span>" + esc(t("pageOf", page, pages)) + "</span>" +
        (page < pages ? '<a href="' + link({ p: page + 1 }) + '">' + esc(t("next")) + " →</a>" : '<span class="disabled">' + esc(t("next")) + " →</span>") + "</nav>";
    }
    main.innerHTML = html;
  }

  function termRow(term, query) {
    var pcs = term.src === "pindex";
    return '<li class="term"><span class="term-path">' + term.path.map(function (p, i) {
      return i === term.path.length - 1 ? "<b>" + highlight(p, query) + "</b>" : highlight(p, query);
    }).join(' <span class="sep">›</span> ') + "</span>" +
      (term.src === "eindex" ? ' <span class="tag">External cause</span>' : "") +
      (pcs ? ' <span class="tag">PCS</span>' : "") +
      '<span class="term-codes">' + (pcs ? pcsLink(term.code) : codeLink(term.code) + (term.manif ? " [" + codeLink(term.manif) + "]" : "")) +
      seeLinks(term.see, t("seeRef")) + seeLinks(term.seeAlso, pcs ? t("useRef") : t("seeAlsoRef")) + "</span></li>";
  }

  function indexTermsBlock(res, query) {
    if (!res.terms.length) return '<p class="empty">' + esc(t("noIndex")) + "</p>";
    return '<p class="muted small">' + esc(t("indexLead")) + (res.termTotal > res.terms.length ? " " + esc(t("moreRows", res.termTotal)) : "") + "</p>" +
      '<ul class="terms">' + res.terms.map(function (x) { return termRow(x, query); }).join("") + "</ul>";
  }

  function tableBlock(title, heads, rows, query) {
    if (!rows.length) return "";
    return '<section class="card"><h2>' + esc(title) + '</h2><div class="table-wrap"><table class="xtable"><thead><tr>' +
      heads.map(function (h) { return "<th scope=\"col\">" + esc(h) + "</th>"; }).join("") + "</tr></thead><tbody>" +
      rows.map(function (r) {
        return '<tr><th scope="row">' + r.path.map(function (p) { return highlight(p, query); }).join(' <span class="sep">›</span> ') +
          seeLinks(r.see, t("seeRef")) + "</th>" + r.cells.map(function (c) { return "<td>" + (c ? codeLink(c) : '<span class="muted">—</span>') + "</td>"; }).join("") + "</tr>";
      }).join("") + "</tbody></table></div></section>";
  }

  function tablesBlock(res, query) {
    var html = tableBlock(t("drugTable"), t("drugHeads"), res.tables.drug, query) +
      tableBlock(t("neoplasmTable"), t("neoHeads"), res.tables.neoplasm, query);
    return html || '<p class="empty">' + esc(t("noTables")) + "</p>";
  }

  function notesBlock(n) {
    var names = t("noteKinds");
    return ["note", "inc", "term", "ex1", "ex2", "first", "add", "also"].filter(function (k) { return n[k]; }).map(function (k) {
      return '<div class="note-kind note-' + k + '"><h4>' + esc(names[k]) + "</h4><ul>" +
        n[k].map(function (s) { return "<li>" + linkifyCodes(s) + "</li>"; }).join("") + "</ul></div>";
    }).join("");
  }
  function linkifyCodes(text) {
    return esc(text).replace(/\b([A-Z]\d[0-9A-Z](?:\.[0-9A-Z]{1,4})?)(?=[\s,.\-)\]]|$)/g, function (m, code) {
      var e = C.get(index, code);
      return e && e.sys === "cm" ? '<a href="' + codeHref(code) + '">' + m + "</a>" : m;
    });
  }

  /** Header, favorite / copy buttons and the note box shared by CM and PCS code pages. */
  function codeHeader(e, crumbs, tags) {
    var fav = Store.get(e.code);
    // Previous / next within the same code system.
    var prev = index.entries[e.i - 1], next = index.entries[e.i + 1];
    if (prev && prev.sys !== e.sys) prev = null;
    if (next && next.sys !== e.sys) next = null;
    return '<div class="detail-top">' + crumbs + '<div class="stepper">' +
      (prev ? '<a href="' + codeHref(prev.code) + '" aria-label="' + esc(t("prevCode") + " " + prev.dot) + '">‹ ' + esc(prev.dot) + "</a>" : "") +
      (next ? '<a href="' + codeHref(next.code) + '" aria-label="' + esc(t("nextCode") + " " + next.dot) + '">' + esc(next.dot) + " ›</a>" : "") + "</div></div>" +
      '<article class="detail"><header class="detail-head">' +
      '<h1 tabindex="-1"><span class="code big">' + esc(e.dot) + '</span><span class="desc big">' + esc(e.desc) + "</span>" +
      (e.zh ? '<span class="zh big" lang="zh-Hant">' + esc(e.zh) + "</span>" : "") + "</h1>" +
      '<div class="detail-meta">' + badge(e) +
      (e.sys === "cm" ? '<span class="muted small">' + esc(e.billable ? t("billableLong") : t("nonBillableLong")) + "</span>" : "") +
      '<span class="vtag">' + esc(vName(current)) + "</span>" + (tags || "") + "</div>" +
      '<div class="detail-actions"><button type="button" class="btn' + (fav ? " btn-on" : "") + '" id="fav-btn" aria-pressed="' + !!fav + '">' +
      starSvg(!!fav) + "<span>" + esc(fav ? t("inFav") : t("addFav")) + "</span></button>" +
      '<button type="button" class="btn" id="copy-btn">' + esc(t("copyCode")) + "</button></div>" +
      '<div id="confirm-slot"></div></header>' +
      '<section class="card note-card"><h2><label for="note">' + esc(t("myNote")) + "</label></h2>" +
      '<textarea id="note" rows="3" placeholder="' + esc(t("notePlaceholder")) + '">' + esc(fav ? fav.note : "") + "</textarea>" +
      '<p class="muted small" id="note-status">' + (Store.available ? (fav ? "" : esc(t("noteAutoFav"))) : esc(t("storageOff"))) + "</p></section>";
  }
  function bindCodeHeader(e) {
    $("#fav-btn").addEventListener("click", function () { toggleFav(e.code, $("#confirm-slot")); });
    $("#copy-btn").addEventListener("click", function () {
      copyText(e.dot).then(function () { toast(t("copied", e.dot)); }, function () { toast(t("copyFailed")); });
    });
    var note = $("#note"), status = $("#note-status"), timer;
    note.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var wasFav = Store.isFav(e.code);
        if (!Store.setNote(e.code, note.value)) { status.textContent = t("storageOff"); return; }
        status.textContent = t("noteSaved", timeStr(Date.now()));
        if (!wasFav) toast(t("favAdded"));
      }, 400);
    });
  }
  function indexTermsCard(e) {
    var terms = C.indexTermsFor(index, e, 20);
    return terms.length ? '<section class="card"><h2>' + esc(t("indexTermsFor")) + ' <span class="muted small">(' + terms.length + ')</span></h2><ul class="terms">' +
      terms.map(function (x) { return termRow(x, null); }).join("") + "</ul></section>" : "";
  }
  function sourceLine() { return '<p class="muted small">' + esc(index.hasZh ? t("zhSource") : t("notTranslated")) + "</p></article>"; }

  function viewCode(raw) {
    var e = C.get(index, raw);
    if (!e) { viewCodeMissing(raw); return; }
    Store.recordView(e.code);
    input.value = e.dot;
    setTitle(e.dot);
    if (e.sys === "pcs") { viewPcsCode(e); return; }
    var anc = C.ancestors(e), sec = C.sectionOf(index, e), ch = C.chapterOf(index, e);
    var hist = codeHistory();

    var crumbs = '<nav class="crumbs" aria-label="Breadcrumb"><a href="#/browse">' + esc(t("navBrowse")) + "</a>";
    if (ch) crumbs += ' › <a href="#/chapter/' + ch.n + '">' + esc(t("chapter", ch.n)) + "</a>";
    if (sec) crumbs += ' › <a href="#/section/' + encodeURIComponent(sec.id) + '">' + esc(sec.id) + "</a>";
    anc.forEach(function (a) { crumbs += ' › <a href="' + codeHref(a.code) + '">' + esc(a.dot) + "</a>"; });
    crumbs += ' › <span aria-current="page">' + esc(e.dot) + "</span></nav>";

    var changeNotes = [];
    var addedIn = hist.added[e.code];
    if (addedIn && vOrder(addedIn) <= vOrder(current)) changeNotes.push(t("codeAdded", vName(addedIn)));
    (hist.revised[e.code] || []).forEach(function (v) { if (vOrder(v) <= vOrder(current)) changeNotes.push(t("codeRevised", vName(v))); });
    var html = codeHeader(e, crumbs, changeNotes.map(function (s) { return '<a class="vtag vtag-change" href="#/versions">' + esc(s) + "</a>"; }).join(""));

    html += '<div class="grid2"><section class="card"><h2>' + esc(t("parents")) + "</h2>" +
      (anc.length ? '<ul class="rows compact">' + anc.map(function (a) { return codeRow(a); }).join("") + "</ul>" : '<p class="muted">' + esc(t("noParents")) + "</p>") +
      "<h3>" + esc(t("location")) + '</h3><ul class="plain">' +
      (ch ? '<li><a href="#/chapter/' + ch.n + '">' + esc(t("chapter", ch.n)) + " · " + esc(ch.r) + "</a> " + esc(ch.t) + "</li>" : "") +
      (sec ? '<li><a href="#/section/' + encodeURIComponent(sec.id) + '">' + esc(sec.id) + "</a> " + esc(sec.t) + "</li>" : "") +
      "</ul></section>" +
      '<section class="card"><h2>' + esc(t("children")) + (e.children.length ? ' <span class="muted small">(' + e.children.length + ")</span>" : "") + "</h2>" +
      (e.children.length ? '<ul class="rows compact">' + e.children.map(function (c) { return codeRow(c, null, { childCount: true }); }).join("") + "</ul>" : '<p class="muted">' + esc(t("noChildren")) + "</p>") +
      "</section></div>";

    var s7 = C.seventhChar(index, e);
    if (s7) {
      var mine = e.code.length === 7 ? e.code[6] : null;
      html += '<section class="card"><h2>' + esc(t("seventh")) + ' <span class="muted small">' + esc(t("seventhFrom", s7.from.dot)) + "</span></h2>" +
        (mine ? '<p class="note-line">' + esc(t("seventhNow", mine)) + "</p>" : "") +
        (s7.note.length ? '<p class="muted small">' + s7.note.map(esc).join(" ") + "</p>" : "") +
        '<ul class="s7">' + s7.defs.map(function (d) {
          return '<li class="' + (d[0] === mine ? "on" : "") + '"><span class="code">' + esc(d[0]) + "</span> " + esc(d[1]) + "</li>";
        }).join("") + "</ul></section>";
    }

    var own = index.notes[e.code];
    var inherited = anc.slice().reverse().filter(function (a) { var n = index.notes[a.code]; return n && notesBlock(n); });
    html += '<section class="card"><h2>' + esc(t("officialNotes")) + "</h2>" +
      (own && notesBlock(own) ? notesBlock(own) : '<p class="muted">' + esc(t("noNotes")) + "</p>") +
      inherited.map(function (a) {
        return '<details class="inherited"><summary>' + esc(t("inheritedNotes", a.dot)) + "</summary>" + notesBlock(index.notes[a.code]) + "</details>";
      }).join("") + "</section>";

    main.innerHTML = html + indexTermsCard(e) + sourceLine();
    bindCodeHeader(e);
  }

  /* ---------------- PCS: code page and browsing ---------------- */
  function pcsCrumbs(key, last) {
    var html = '<nav class="crumbs" aria-label="Breadcrumb"><a href="#/browse">' + esc(t("navBrowse")) + "</a>";
    for (var n = 1; n <= Math.min(3, key.length); n++) {
      var part = key.slice(0, n);
      html += n === key.length && !last ? ' › <span aria-current="page">' + esc(part) + "</span>" : ' › <a href="' + pcsHref(part) + '">' + esc(part) + "</a>";
    }
    return html + (last ? ' › <span aria-current="page">' + esc(last) + "</span>" : "") + "</nav>";
  }

  function viewPcsCode(e) {
    var tb = C.pcsTable(index, e.code), parts = C.pcsParts(index, e.code) || [];
    var html = codeHeader(e, pcsCrumbs(e.code.slice(0, 3), e.dot), "");
    html += '<section class="card"><h2>' + esc(t("pcsStructure")) + "</h2>" +
      '<div class="table-wrap"><table class="xtable parts"><thead><tr><th scope="col">' + esc(t("pcsPos")) + '</th><th scope="col">' + esc(t("pcsAxis")) +
      '</th><th scope="col">' + esc(t("pcsChar")) + '</th><th scope="col">' + esc(t("pcsMeaning")) + "</th></tr></thead><tbody>" +
      parts.map(function (p) {
        return "<tr><td>" + p.pos + "</td><td>" + esc(p.axis) + '</td><td><span class="code">' + esc(p.ch) + "</span></td><td>" + esc(p.label) + "</td></tr>";
      }).join("") + "</tbody></table></div>" +
      (tb && tb.def ? '<p class="note-line">' + esc(t("pcsDef")) + esc(tb.def) + "</p>" : "") +
      '<ul class="plain">' +
      (tb ? '<li><a href="' + pcsHref(tb.code) + '">' + esc(t("pcsTableOf", tb.code)) + "</a> " + esc(tableName(tb)) + "</li>" : "") +
      '<li><a href="' + searchHref(e.code.slice(0, 4)) + '">' + esc(t("pcsSamePart", e.code.slice(0, 4))) + "</a></li></ul></section>";
    main.innerHTML = html + indexTermsCard(e) + sourceLine();
    bindCodeHeader(e);
  }

  /** #/pcs/<1-3 characters>: section -> body systems -> tables -> 4th-character groups. */
  function viewPcs(key) {
    key = C.nodot(key);
    if (!index.pcs || !key) { viewBrowse(); return; }
    var counts = C.pcsCounts(index), html;
    function row(href, code, label, n) {
      return '<li class="row"><a class="row-link" href="' + href + '"><span class="code">' + esc(code) + '</span><span class="desc">' + esc(label) +
        ' <span class="muted small">· ' + esc(t("codesN", n || 0)) + "</span></span></a></li>";
    }
    if (key.length === 1) {
      var sec = index.pcs.sections.filter(function (s) { return s[0] === key; })[0];
      if (!sec) { viewBrowse(); return; }
      setTitle(key + " " + sec[1]);
      html = pcsCrumbs(key) + '<h1 tabindex="-1"><span class="code">' + esc(key) + "</span> " + esc(sec[1]) + "</h1>" +
        "<h2>" + esc(t("pcsSystems")) + '</h2><ul class="rows">' +
        index.pcs.systems.filter(function (s) { return s[0][0] === key; }).map(function (s) { return row(pcsHref(s[0]), s[0], s[1], counts[s[0]]); }).join("") + "</ul>";
    } else if (key.length === 2) {
      var sys = index.pcs.systems.filter(function (s) { return s[0] === key; })[0];
      if (!sys) { viewBrowse(); return; }
      setTitle(key + " " + sys[1]);
      html = pcsCrumbs(key) + '<h1 tabindex="-1"><span class="code">' + esc(key) + "</span> " + esc(sys[1]) + "</h1>" +
        "<h2>" + esc(t("pcsTablesHead")) + '</h2><ul class="rows">' +
        Object.keys(index.pcs.tables).filter(function (k) { return k.lastIndexOf(key, 0) === 0; }).sort().map(function (k) {
          return row(pcsHref(k), k, index.pcs.tables[k].l[2], counts[k]);
        }).join("") + "</ul>";
    } else {
      var tb = C.pcsTable(index, key);
      if (!tb) { viewBrowse(); return; }
      key = tb.code;
      setTitle(key + " " + tableName(tb));
      var groups = C.pcsGroups(index, key);
      html = pcsCrumbs(key) + '<h1 tabindex="-1"><span class="code">' + esc(key) + "</span> " + esc(tableName(tb)) + "</h1>" +
        '<p class="lead small">' + esc(tb.labels[0]) + (tb.def ? " · " + esc(t("pcsDef")) + esc(tb.def) : "") + "</p>" +
        "<h2>" + esc(t("pcsGroupsTitle", groups.length && groups[0].axis)) + ' <span class="muted small">(' + esc(t("codesN", counts[key] || 0)) + ')</span></h2><ul class="rows">' +
        groups.map(function (g) { return row(searchHref(key + g.ch), key + g.ch, g.label, g.count); }).join("") + "</ul>";
    }
    main.innerHTML = html;
  }

  function viewCodeMissing(raw) {
    setTitle(raw);
    var code = C.nodot(raw), hist = codeHistory(), msg = [];
    var del = hist.deleted[code], add = hist.added[code];
    if (del && vOrder(del) <= vOrder(current)) msg.push(t("codeDeletedIn", show(code), vName(del)));
    if (add && vOrder(add) > vOrder(current)) msg.push(t("codeAdded", vName(add)) + "。");
    // Offer the newest version that still has the code.
    var target = null;
    if (add && vOrder(add) > vOrder(current)) target = del && vOrder(del) > vOrder(add) ? null : MANIFEST.latest;
    else if (del && vOrder(del) <= vOrder(current)) target = MANIFEST.versions[vOrder(del) - 1].id;
    // A procedure code looked up in a version that has no PCS.
    var withPcs = MANIFEST.versions.filter(function (v) { return v.pcs; })[0];
    if (!target && !index.hasPcs && withPcs && code.length === 7 && show(code) === code) { target = withPcs.id; msg.push(t("pcsNotInVersion")); }
    main.innerHTML = '<h1 tabindex="-1">' + esc(t("notFound", raw)) + "</h1>" +
      msg.map(function (m) { return '<p class="note-line">' + esc(m) + "</p>"; }).join(" ") +
      '<div class="btns">' + (target ? '<button type="button" class="btn btn-primary" id="switch-to">' + esc(t("useVersion") + "：" + vName(target)) + "</button>" : "") +
      '<a class="btn" href="#/versions">' + esc(t("versionsTitle")) + "</a></div>";
    var sw = $("#switch-to");
    if (sw) sw.addEventListener("click", function () { switchVersion(target, true); });
  }

  function refreshFavButton(code) {
    var btn = $("#fav-btn");
    if (!btn) return;
    var on = Store.isFav(code);
    btn.className = "btn" + (on ? " btn-on" : "");
    btn.setAttribute("aria-pressed", String(on));
    btn.innerHTML = starSvg(on) + "<span>" + esc(on ? t("inFav") : t("addFav")) + "</span>";
  }

  /** Toggle a favorite; asks inline before deleting a non-empty note. */
  function toggleFav(code, confirmSlot) {
    if (!Store.isFav(code)) { Store.add(code); toast(t("favAdded")); return; }
    var item = Store.get(code);
    if (item.note && item.note.trim() && confirmSlot) {
      confirmSlot.innerHTML = '<div class="confirm" role="alert"><span>' + esc(t("confirmRemove")) + "</span>" +
        '<button type="button" class="btn btn-danger" data-yes>' + esc(t("confirmYes")) + "</button>" +
        '<button type="button" class="btn" data-no>' + esc(t("confirmNo")) + "</button></div>";
      $("[data-yes]", confirmSlot).focus();
      $("[data-yes]", confirmSlot).onclick = function () {
        confirmSlot.innerHTML = ""; Store.remove(code); toast(t("favRemoved"));
        var n = $("#note"); if (n) n.value = "";
      };
      $("[data-no]", confirmSlot).onclick = function () { confirmSlot.innerHTML = ""; };
      return;
    }
    Store.remove(code); toast(t("favRemoved"));
  }

  function viewBrowse() {
    setTitle(t("browseTitle"));
    var html = '<h1 tabindex="-1">' + esc(t("browseTitle")) + '</h1><p class="lead">' + esc(t("browseLead")) + "</p>" +
      '<ol class="chapters">' + index.chapters.map(function (ch) {
        return '<li><a href="#/chapter/' + ch.n + '"><span class="ch-num">' + esc(t("chapter", ch.n)) + "</span>" +
          '<span class="code">' + esc(ch.r) + '</span><span class="ch-title">' + esc(ch.t) + "</span></a></li>";
      }).join("") + "</ol>";
    if (index.pcs) {
      var counts = C.pcsCounts(index);
      html += '<h2 class="browse-h2">' + esc(t("pcsTitle")) + '</h2><p class="lead small">' + esc(t("pcsLead")) + "</p>" +
        '<ol class="chapters">' + index.pcs.sections.map(function (s) {
          return '<li><a href="' + pcsHref(s[0]) + '"><span class="ch-num">' + esc(t("codesN", counts[s[0]] || 0)) + "</span>" +
            '<span class="code">' + esc(s[0]) + '</span><span class="ch-title">' + esc(s[1]) + "</span></a></li>";
        }).join("") + "</ol>";
    }
    main.innerHTML = html;
  }

  function categoriesOf(si) {
    var out = [];
    for (var i = 0; i < index.cmCount; i++) {
      var e = index.entries[i];
      // Top-level codes of the section: categories, and codes whose category is not itself a code (U00.0REH).
      if (!e.parent && index.data.cat2sec[e.code.slice(0, 3)] === si) out.push(e);
    }
    return out;
  }

  function viewChapter(n) {
    var ch = index.chapters.filter(function (c) { return c.n === n; })[0];
    if (!ch) { viewBrowse(); return; }
    setTitle(t("chapter", ch.n));
    main.innerHTML = '<nav class="crumbs" aria-label="Breadcrumb"><a href="#/browse">' + esc(t("navBrowse")) + '</a> › <span aria-current="page">' + esc(t("chapter", ch.n)) + "</span></nav>" +
      '<h1 tabindex="-1"><span class="code">' + esc(ch.r) + "</span> " + esc(ch.t) + "</h1>" +
      (ch.notes ? '<details class="card"><summary>' + esc(t("officialNotes")) + "</summary>" + notesBlock(ch.notes) + "</details>" : "") +
      "<h2>" + esc(t("sectionsIn")) + "</h2>" +
      '<ul class="rows">' + ch.s.map(function (si) {
        var sec = index.sections[si];
        return '<li class="row"><a class="row-link" href="#/section/' + encodeURIComponent(sec.id) + '"><span class="code">' + esc(sec.id) +
          '</span><span class="desc">' + esc(sec.t) + ' <span class="muted small">· ' + categoriesOf(si).length + "</span></span></a></li>";
      }).join("") + "</ul>";
  }

  function viewSection(id) {
    var si = -1;
    index.sections.forEach(function (s, i) { if (s.id === id) si = i; });
    if (si < 0) { viewBrowse(); return; }
    var sec = index.sections[si], ch = index.chapters[sec.c], cats = categoriesOf(si);
    setTitle(sec.id);
    main.innerHTML = '<nav class="crumbs" aria-label="Breadcrumb"><a href="#/browse">' + esc(t("navBrowse")) + '</a> › <a href="#/chapter/' + ch.n + '">' +
      esc(t("chapter", ch.n)) + '</a> › <span aria-current="page">' + esc(sec.id) + "</span></nav>" +
      '<h1 tabindex="-1"><span class="code">' + esc(sec.id) + "</span> " + esc(sec.t) + "</h1>" +
      (sec.notes ? '<details class="card"><summary>' + esc(t("officialNotes")) + "</summary>" + notesBlock(sec.notes) + "</details>" : "") +
      "<h2>" + esc(t("categories")) + ' <span class="muted small">(' + cats.length + ")</span></h2>" +
      '<ul class="rows">' + cats.map(function (e) { return codeRow(e, null, { childCount: true }); }).join("") + "</ul>";
  }

  /* ---------------- versions & changes ---------------- */
  function viewVersions() {
    setTitle(t("versionsTitle"));
    var now = new Date(), pad = function (n) { return (n < 10 ? "0" : "") + n; };
    var today = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
    var us = usVersions(), earliest = us.length ? us[0].effective : today;
    var html = '<h1 tabindex="-1">' + esc(t("versionsTitle")) + '</h1><p class="lead">' + esc(t("versionsLead")) + "</p>" +
      '<ol class="versions">' + MANIFEST.versions.slice().reverse().sort(function (a, b) {
        return (b.id === defaultVersion()) - (a.id === defaultVersion());
      }).map(function (v) {
        var on = v.id === current;
        var pair = CHANGES.filter(function (p) { return p.to === v.id; })[0];
        var summary = pair ? '<a href="#/changes?to=' + encodeURIComponent(v.id) + '">' + esc(vName(pair.from)) + " → " + esc(t("chAdded")) + " " + pair.added.length + " · " + esc(t("chDeleted")) + " " +
          pair.deleted.length + " · " + esc(t("chRevised")) + " " + pair.revised.length + "</a>" : "";
        return '<li class="vcard' + (on ? " on" : "") + '"><div><b>' + esc(t("vLabel", v)) + "</b> " + (on ? '<span class="vtag">' + esc(t("current")) + "</span>" : "") +
          (v.id === defaultVersion() ? ' <span class="tag">' + esc(t("defaultVersion")) + "</span>" : "") +
          '<div class="muted small">' + esc(vEffective(v)) + "</div>" +
          '<div class="muted small">' + esc(t("codesCount", v.count, v.billable)) + (v.pcs ? " · " + esc(t("pcsCount", v.pcs.count)) : "") +
          (v.zh ? " · " + esc(t("hasZhNames")) : "") + "</div>" +
          '<div class="small">' + summary + "</div></div>" +
          (on ? "" : '<button type="button" class="btn" data-use="' + esc(v.id) + '">' + esc(t("useVersion")) + "</button>") + "</li>";
      }).join("") + "</ol>";
    if (us.length) {
      html += '<section class="card"><h2><label for="vdate">' + esc(t("byDate")) + '</label></h2><p class="muted small">' + esc(t("byDateHint")) + "</p>" +
        '<form id="vdate-form" class="inline-form"><input type="date" id="vdate" value="' + today + '" min="' + esc(earliest) + '">' +
        '<button type="submit" class="btn">' + esc(t("byDateBtn")) + '</button></form><p id="vdate-msg" class="small"></p></section>';
    }
    main.innerHTML = html;
    $$("[data-use]", main).forEach(function (b) { b.addEventListener("click", function () { switchVersion(b.getAttribute("data-use"), true); }); });
    var form = $("#vdate-form");
    if (form) form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var d = $("#vdate").value, id = d && versionForDate(d);
      if (!id) { $("#vdate-msg").textContent = t("noVersionForDate", d, earliest); return; }
      if (id === current) { $("#vdate-msg").textContent = t("switchedTo", vName(id)); return; }
      switchVersion(id, true);
    });
  }

  function viewChanges(params) {
    var to = params.get("to") || MANIFEST.latest, kind = params.get("k") || "added";
    var pair = CHANGES.filter(function (p) { return p.to === to; })[0];
    setTitle(t("changesTitle"));
    var html = '<nav class="crumbs" aria-label="Breadcrumb"><a href="#/versions">' + esc(t("versionsTitle")) + '</a> › <span aria-current="page">' + esc(t("changesTitle")) + "</span></nav>" +
      '<h1 tabindex="-1">' + esc(t("changesTitle")) + "</h1>" +
      '<label class="inline-form small">' + esc(t("changesPair")) + ' <select id="pair">' + CHANGES.slice().reverse().map(function (p) {
        return '<option value="' + esc(p.to) + '"' + (p.to === to ? " selected" : "") + ">" + esc(vName(p.from) + " → " + vName(p.to)) + "</option>";
      }).join("") + "</select></label>";
    if (!pair) { main.innerHTML = html; return; }
    var kinds = [["added", t("chAdded")], ["deleted", t("chDeleted")], ["revised", t("chRevised")], ["billable", t("chBillable")]];
    html += '<p class="muted small">' + esc(t("changesNote")) + '</p><div class="tabs segs">' + kinds.map(function (k) {
      var href = "#/changes?" + new URLSearchParams({ to: to, k: k[0] });
      return '<a class="seg' + (k[0] === kind ? " on" : "") + '" href="' + href + '">' + esc(k[1]) + ' <span class="count">' + pair[k[0]].length + "</span></a>";
    }).join("") + "</div>";
    var rows = pair[kind] || [];
    if (!rows.length) html += '<p class="empty">' + esc(t("noChanges")) + "</p>";
    else html += '<ul class="rows">' + rows.map(function (r) {
      var code = r[0], dot = C.dotted(code), right;
      if (kind === "revised") right = '<span class="desc"><span class="muted small">' + esc(t("oldDesc")) + ":</span> <s>" + esc(r[1]) + '</s><br><span class="muted small">' + esc(t("newDesc")) + ":</span> " + esc(r[2]) + "</span>";
      else if (kind === "billable") right = '<span class="desc">' + esc((C.get(index, code) || {}).desc || "") + '</span><span class="badge badge-h">' + esc(t("billableChange", r[1], r[2])) + "</span>";
      else right = '<span class="desc">' + esc(r[2]) + "</span>" + '<span class="badge ' + (r[1] ? "badge-b" : "badge-h") + '">' + esc(r[1] ? t("billable") : t("nonBillable")) + "</span>";
      var inner = '<span class="code">' + esc(dot) + "</span>" + right;
      return '<li class="row">' + (kind !== "deleted" && C.get(index, code) ? '<a class="row-link" href="' + codeHref(code) + '">' + inner + "</a>" : '<div class="row-link">' + inner + "</div>") + "</li>";
    }).join("") + "</ul>";
    main.innerHTML = html;
    $("#pair").addEventListener("change", function () { location.hash = "#/changes?" + new URLSearchParams({ to: this.value, k: kind }); });
  }

  /* ---------------- favorites, sync, backup ---------------- */
  function syncPanel() {
    var s = Sync.status, html = '<section class="card sync" id="sync-panel"><h2>' + esc(t("syncTitle")) + "</h2>";
    if (!Sync.supported) return html + '<p class="muted small">' + esc(t("syncUnsupported")) + "</p></section>";
    html += '<p class="muted small">' + esc(t("syncLead")) + "</p>";
    if (s === "on") {
      html += '<p class="sync-state ok">' + esc(t("syncOn", Sync.fileName, Sync.lastSync ? timeStr(Sync.lastSync) : "")) + "</p>" +
        '<div class="btns"><button type="button" class="btn" data-sync="now">' + esc(t("syncNow")) + '</button><button type="button" class="btn" data-sync="stop">' + esc(t("syncStop")) + "</button></div>";
    } else if (s === "needs-permission") {
      html += '<p class="sync-state warn">' + esc(t("syncNeedsPermission", Sync.fileName)) + "</p>" +
        '<div class="btns"><button type="button" class="btn btn-primary" data-sync="reconnect">' + esc(t("syncReconnect")) + '</button><button type="button" class="btn" data-sync="stop">' + esc(t("syncStop")) + "</button></div>";
    } else {
      if (s === "error") html += '<p class="sync-state err">' + esc(t("syncError", Sync.lastError)) + "</p>";
      html += '<div class="btns"><button type="button" class="btn btn-primary" data-sync="create">' + esc(t("syncCreate")) + '</button><button type="button" class="btn" data-sync="link">' + esc(t("syncLink")) + "</button>" +
        (Sync.fileName ? '<button type="button" class="btn" data-sync="stop">' + esc(t("syncStop")) + "</button>" : "") + "</div>";
    }
    return html + "</section>";
  }
  function bindSyncPanel() {
    $$("[data-sync]", main).forEach(function (b) {
      b.addEventListener("click", function () {
        var a = b.getAttribute("data-sync");
        ({ create: Sync.create, link: Sync.link, now: Sync.syncNow, stop: Sync.disconnect, reconnect: Sync.reconnect })[a]();
      });
    });
  }
  Sync.onChange(function () {
    var panel = $("#sync-panel");
    if (!panel) return;
    var tmp = document.createElement("div");
    tmp.innerHTML = syncPanel();
    panel.replaceWith(tmp.firstChild);
    bindSyncPanel();
  });

  function viewFavorites() {
    setTitle(t("favTitle"));
    var items = Store.all();
    var html = '<h1 tabindex="-1">' + esc(t("favTitle")) + ' <span class="muted small">(' + items.length + ")</span></h1>" +
      '<p class="lead small">' + esc(Store.available ? t("favLead") : t("storageOff")) + "</p>" +
      '<div class="toolbar"><input type="search" id="fav-filter" class="filter" placeholder="' + esc(t("favFilter")) + '" aria-label="' + esc(t("favFilter")) + '"></div>';
    if (!items.length) html += '<p class="empty">' + esc(t("favEmpty")) + "</p>";
    html += '<ul class="favs">' + items.map(function (it) {
      var e = C.get(index, it.code), dot = show(it.code);
      return '<li class="fav" data-code="' + esc(it.code) + '" data-text="' + esc((dot + " " + it.code + " " + (e ? e.desc + " " + e.zh : "") + " " + it.note).toLowerCase()) + '">' +
        '<div class="fav-head"><a class="row-link" href="' + codeHref(it.code) + '"><span class="code">' + esc(dot) + '</span><span class="desc">' + (e ? descHtml(e) : "") + "</span>" +
        (e ? badge(e) : '<span class="badge badge-h">' + esc(t("notInVersion")) + "</span>") + "</a>" + starButton(it.code) + "</div>" +
        '<div class="fav-note">' + (it.note ? esc(it.note) : '<span class="muted">' + esc(t("noteEmpty")) + "</span>") + "</div>" +
        '<div class="fav-foot muted small">' + esc(t("addedOn", new Date(it.addedAt).toLocaleDateString(I18N.lang))) +
        ' · <button type="button" class="linkish" data-edit>' + esc(t("edit")) + "</button></div>" +
        '<div class="confirm-slot"></div></li>';
    }).join("") + "</ul>";
    html += syncPanel() +
      '<section class="card"><h2>' + esc(t("backupTitle")) + '</h2><div class="btns"><button type="button" class="btn" id="export-btn">' + esc(t("exportBtn")) + "</button>" +
      '<label class="btn" for="import-file">' + esc(t("importBtn")) + '</label><input type="file" id="import-file" accept="application/json,.json" hidden></div></section>';
    main.innerHTML = html;
    bindSyncPanel();

    $("#fav-filter").addEventListener("input", function () {
      var q = this.value.toLowerCase().trim();
      $$(".fav", main).forEach(function (li) { li.hidden = q && li.getAttribute("data-text").indexOf(q) === -1; });
    });
    $("#export-btn").addEventListener("click", function () {
      var blob = new Blob([Store.exportJSON()], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "icd10cm-favorites-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
    $("#import-file").addEventListener("change", function () {
      var f = this.files[0]; if (!f) return;
      f.text().then(function (txt) {
        try { toast(t("imported", Store.importJSON(txt))); viewFavorites(); }
        catch (err) { toast(t("importFailed")); }
      });
    });
    $$(".fav [data-edit]", main).forEach(function (b) {
      b.addEventListener("click", function () {
        var li = b.closest(".fav"), code = li.getAttribute("data-code"), box = $(".fav-note", li);
        if (b.getAttribute("data-editing")) { viewFavorites(); return; }
        b.setAttribute("data-editing", "1"); b.textContent = t("done");
        box.innerHTML = '<textarea rows="3" aria-label="' + esc(t("myNote") + " " + show(code)) + '">' + esc((Store.get(code) || {}).note || "") + "</textarea>";
        var ta = $("textarea", box), tm; ta.focus();
        ta.addEventListener("input", function () { clearTimeout(tm); tm = setTimeout(function () { Store.setNote(code, ta.value); }, 300); });
        ta.addEventListener("blur", function () { clearTimeout(tm); Store.setNote(code, ta.value); });
      });
    });
  }

  // Star buttons anywhere in the main area.
  main.addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-star]");
    if (!b) return;
    ev.preventDefault();
    var code = b.getAttribute("data-star"), li = b.closest("li");
    var slot = li && $(".confirm-slot", li);
    if (!slot && li) { slot = document.createElement("div"); slot.className = "confirm-slot"; li.appendChild(slot); }
    toggleFav(code, slot);
  });

  Store.onChange(function (source) {
    var n = Store.count();
    $("#fav-count").textContent = n ? String(n) : "";
    if (source === "usage" || !index) return;
    $$("[data-star]").forEach(function (b) {
      var code = b.getAttribute("data-star"), on = Store.isFav(code);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      b.innerHTML = starSvg(on);
      b.setAttribute("aria-label", (on ? t("removeFav") : t("addFav")) + " " + show(code));
    });
    var v = route().path;
    if (v[0] === "code") {
      refreshFavButton(C.nodot(v[1] || ""));
      // Pull in a note that arrived from sync or another tab, unless the user is typing.
      var note = $("#note");
      if (note && document.activeElement !== note && source !== "local") note.value = (Store.get(C.nodot(v[1] || "")) || {}).note || "";
    }
    if (v[0] === "favorites" && !(document.activeElement && document.activeElement.closest && document.activeElement.closest(".fav-note"))) {
      var shown = $$(".fav", main).map(function (li) { return li.getAttribute("data-code"); }).join(",");
      var now = Store.all().map(function (i) { return i.code; }).join(",");
      if (shown !== now || source === "sync" || source === "tab" || source === "import") viewFavorites();
    }
  });

  /* ================================================================ language & boot */
  function applyLanguage() {
    document.documentElement.lang = I18N.lang;
    $$("[data-i18n]").forEach(function (el) { var v = t(el.getAttribute("data-i18n")); if (v) el.textContent = v; });
    input.placeholder = t(index && !index.hasZh ? "searchPlaceholderEn" : "searchPlaceholder");
    input.setAttribute("aria-label", t("searchLabel"));
    var lt = $("#lang-toggle");
    lt.textContent = t("langToggle");
    lt.setAttribute("aria-label", t("langToggleLabel"));
    lt.setAttribute("lang", I18N.lang === "en" ? "zh-Hant" : "en");
    $("#footer-text").textContent = t("footer");
    if (current) fillVersionSelect();
  }
  $("#lang-toggle").addEventListener("click", function () {
    I18N.set(I18N.lang === "en" ? "zh-Hant" : "en");
    applyLanguage();
    closeSuggest();
    render();
  });

  applyLanguage();
  if (!MANIFEST || !MANIFEST.versions || !MANIFEST.versions.length) {
    main.innerHTML = '<p class="empty">' + esc(t("loadFailed")) + "</p>";
    return;
  }
  var saved = null;
  try { saved = localStorage.getItem(VKEY); } catch (e) { /* ignore */ }
  var n = Store.count();
  $("#fav-count").textContent = n ? String(n) : "";
  switchVersion(vInfo(saved) ? saved : defaultVersion(), false);
})();
