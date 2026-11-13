"""
Build the data files from official, public release files.

Two kinds of version are supported (see VERSIONS below):

  "us"   U.S. ICD-10-CM release (CMS / CDC-NCHS). Diagnosis codes only, English.
  "nhi"  Taiwan NHI (健保署) Chinese edition of ICD-10-CM/PCS. The code list, the
         billable flag and the English + Chinese names come from the NHI workbook.
         Structure that NHI does not publish (chapters, notes, Alphabetic Index,
         PCS tables and PCS index) comes from the U.S. release of the same year.

Output:
  data/versions.js               manifest: versions, default version, file names
  data/changes.js                added / deleted / revised CM codes between consecutive versions
  data/icd10cm-<id>.js           CM data of one version (loaded on demand by the app)
  data/icd10pcs-<id>.js          PCS data of one version (only for versions that have PCS)
  data/verify-<id>.txt           verification report of an "nhi" version (NHI list vs. U.S. lists)

Usage:
    python scripts/build_data.py                    # all versions in VERSIONS
    python scripts/build_data.py --only 2023-nhi    # rebuild one version; the others are reused as built

Downloads go to data/raw/ and are reused. Only the Python 3 standard library is used.
How to add or update a version: docs/development-spec.md, section "資料更新流程".
"""
import argparse
import hashlib
import io
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
DATA = os.path.join(ROOT, "data")

CDC = "https://ftp.cdc.gov/pub/Health_Statistics/NCHS/Publications/ICD10CM/"
CMS = "https://www.cms.gov/files/zip/"
NHI = "https://www.nhi.gov.tw/ch/"

# The version the app opens with the first time (users can switch; their choice is remembered).
DEFAULT_VERSION = "2023-nhi"

# Ordered oldest -> newest by the U.S. effective date of the code set.
# A source is a URL, or (URL, local file name) when the URL's last path part is not a usable name.
VERSIONS = [
    {"id": "2023-nhi", "kind": "nhi",
     "label": "2023 NHI (Taiwan)", "labelZh": "2023 年版（健保署）",
     "effective": "2023-04-01",        # U.S. code set this edition is based on
     "nhiEffective": "2025-01-01",     # NHI claims use this edition from this date (114/1/1)
     "revision": "115.08.27",          # NHI workbook revision (Chinese names are revised from time to time)
     "nhi": (NHI + "dl-80147-c2be3cea667a4214802554bbca90bb49-1.xlsx", "nhi-2023-icd10-cm-pcs-1150827.xlsx"),
     "zips": [
         CDC + "2023/icd10-Order-CodeFiles2023.zip",
         CDC + "2023/icd10cm-Tabular-Index-2023.zip"],
     "pcs_zips": [
         (CMS + "2023-icd-10-pcs-order-file-long-and-abbreviated-titles-updated-01/11/2023.zip",
          "2023-icd-10-pcs-order-file.zip"),
         (CMS + "2023-icd-10-pcs-code-tables-and-index-updated-01/11/2023.zip",
          "2023-icd-10-pcs-code-tables-and-index.zip")]},
    {"id": "2025", "kind": "us", "label": "FY2025", "labelZh": "FY2025", "effective": "2024-10-01", "zips": [
        CDC + "2025/ICD10-CM Code Descriptions 2025.zip",
        CDC + "2025/icd10cm-table-index-2025.zip"]},
    {"id": "2025-04", "kind": "us", "label": "FY2025 April update", "labelZh": "FY2025 4 月更新",
     "effective": "2025-04-01", "zips": [
        CDC + "2025-Update/Code-desciptions-April-2025.zip",
        CDC + "2025-Update/icd10cm-table-index-April-2025.zip"]},
    {"id": "2026", "kind": "us", "label": "FY2026", "labelZh": "FY2026", "effective": "2025-10-01", "zips": [
        CDC + "2026/icd10cm-Code Descriptions-2026.zip",
        CDC + "2026/icd10cm-table and index-2026.zip"]},
    {"id": "2026-04", "kind": "us", "label": "FY2026 April update", "labelZh": "FY2026 4 月更新",
     "effective": "2026-04-01", "zips": [
        CDC + "2026-update/icd10cm-table-and-index-April-1-2026.zip",
        CDC + "2026-update/icd10cm-April-1-2026-XML.zip"]},
    {"id": "2027", "kind": "us", "label": "FY2027", "labelZh": "FY2027", "effective": "2026-10-01", "zips": [
        "https://www.cms.gov/files/zip/2027-code-descriptions-tabular-order.zip",
        CDC + "2027/icd10cm-table-and-index-2027.zip"]},
]

# Which archive member holds which file (matched against the lower-cased base name).
MEMBERS = {
    "order": lambda n: n.endswith(".txt") and "order" in n and "addend" not in n,
    "tabular": lambda n: n.endswith(".xml") and "tabular" in n,
    "index": lambda n: n.endswith(".xml") and re.search(r"[-_]index", n) and "eindex" not in n,
    "eindex": lambda n: n.endswith(".xml") and "eindex" in n,
    "drug": lambda n: n.endswith(".xml") and "drug" in n,
    "neoplasm": lambda n: n.endswith(".xml") and "neoplasm" in n,
}
PCS_MEMBERS = {
    "order": lambda n: n.endswith(".txt") and "order" in n and "addend" not in n,
    "tables": lambda n: n.endswith(".xml") and "tables" in n,
    "index": lambda n: n.endswith(".xml") and "index" in n,
}

NOTE_KINDS = {
    "notes": "note", "includes": "inc", "inclusionTerm": "term", "excludes1": "ex1",
    "excludes2": "ex2", "codeFirst": "first", "useAdditionalCode": "add", "codeAlso": "also",
    "sevenChrNote": "s7note",
}

# Sheet names in the NHI workbook.
NHI_SHEET_CM = "ICD-10-CM"
NHI_SHEET_PCS = "ICD-10-PCS"

# Repairs to Chinese names in the NHI workbook: (broken text, corrected text, word the English name must contain).
# The workbook has a literal "?" where a character was lost. Every repair is listed in data/verify-<id>.txt.
NHI_NAME_REPAIRS = [
    ("?管", "瘻管", "fistula"),
]


# ---------------------------------------------------------------- downloads
def source(src):
    """-> (url, local path)"""
    url, name = src if isinstance(src, tuple) else (src, None)
    if not name:
        name = os.path.basename(urllib.parse.unquote(urllib.parse.urlparse(url).path)).replace(" ", "_")
    return url, os.path.join(RAW, name)


def download(src):
    url, dest = source(src)
    if os.path.exists(dest):
        return dest
    print(f"  fetch   {url}")
    req = urllib.request.Request(urllib.parse.quote(url, safe=":/"), headers={"User-Agent": "icd10cm-data-builder/3.0"})
    with urllib.request.urlopen(req, timeout=600) as r:
        data = r.read()
    with open(dest, "wb") as f:
        f.write(data)
    return dest


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def collect_members(zip_paths, members):
    found = {}
    for zp in zip_paths:
        with zipfile.ZipFile(zp) as z:
            for name in z.namelist():
                base = os.path.basename(name).lower()
                for key, match in members.items():
                    if key not in found and match(base):
                        found[key] = (zp, name)
    missing = [k for k in members if k not in found]
    if missing:
        sys.exit(f"Missing files {missing} in {zip_paths}")
    return found


def read(found, key):
    zp, name = found[key]
    with zipfile.ZipFile(zp) as z:
        return z.read(name)


def nodot(code):
    return code.replace(".", "").strip().upper()


def clean(text):
    return " ".join((text or "").split())


def full_text(el):
    return clean(" ".join(el.itertext())) if el is not None else ""


# ---------------------------------------------------------------- xlsx (standard library only)
_M = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def _col(ref):
    n = 0
    for ch in ref:
        if not ch.isalpha():
            break
        n = n * 26 + (ord(ch.upper()) - 64)
    return n - 1


def read_xlsx(path, wanted):
    """Read the named sheets of a workbook -> {sheet name: [row, ...]}, every cell as text."""
    with zipfile.ZipFile(path) as z:
        strings = []
        if "xl/sharedStrings.xml" in z.namelist():
            for _, el in ET.iterparse(z.open("xl/sharedStrings.xml")):
                if el.tag == _M + "si":
                    # Skip phonetic runs (rPh); keep plain and rich text.
                    strings.append("".join(t.text or "" for t in el.iter(_M + "t")
                                           if True))
                    el.clear()
        rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
        out = {}
        for s in ET.fromstring(z.read("xl/workbook.xml")).find(_M + "sheets"):
            if s.get("name") not in wanted:
                continue
            target = rels[s.get(_R + "id")].lstrip("/")
            target = target if target.startswith("xl/") else "xl/" + target
            rows = []
            for _, el in ET.iterparse(z.open(target)):
                if el.tag != _M + "row":
                    continue
                row = []
                for c in el:
                    v, t = c.find(_M + "v"), c.get("t")
                    if t == "s" and v is not None:
                        val = strings[int(v.text)]
                    elif t == "inlineStr":
                        val = "".join(x.text or "" for x in c.iter(_M + "t"))
                    else:
                        val = v.text if v is not None and v.text else ""
                    i = _col(c.get("r"))
                    while len(row) <= i:
                        row.append("")
                    row[i] = val
                rows.append(row)
                el.clear()
            out[s.get("name")] = rows
    missing = [w for w in wanted if w not in out]
    if missing:
        sys.exit(f"Sheets {missing} not found in {path}")
    return out


def nhi_rows(rows, what):
    """NHI sheet rows (code, USE, English, Chinese, ...) -> [(code, billable, english, chinese)]."""
    out, seen = [], set()
    for r in rows[1:]:
        r = r + [""] * (4 - len(r))
        code = nodot(r[0])
        if not code:
            continue
        if r[1].strip() not in ("0", "1"):
            sys.exit(f"{what} {r[0]}: USE must be 0 or 1, got {r[1]!r}")
        if code in seen:
            sys.exit(f"{what} {r[0]}: listed twice")
        seen.add(code)
        out.append((code, r[1].strip() == "1", clean(r[2]), clean(r[3])))
    return out


def repair_names(rows):
    """Apply NHI_NAME_REPAIRS -> (rows, [(code, old name, new name)])."""
    out, changed = [], []
    for code, billable, en, zh in rows:
        fixed = zh
        for bad, good, needs in NHI_NAME_REPAIRS:
            if bad in fixed and needs in en.lower():
                fixed = fixed.replace(bad, good)
        if fixed != zh:
            changed.append((code, zh, fixed))
        out.append((code, billable, en, fixed))
    return out, changed


# ---------------------------------------------------------------- order file
def parse_order(raw):
    codes = []
    for line in raw.decode("utf-8", "replace").splitlines():
        if len(line) < 16:
            continue
        codes.append((line[6:13].strip(), line[14] == "1", line[77:].strip()))
    return codes


# ---------------------------------------------------------------- tabular
def collect_notes(el):
    out = {}
    for tag, key in NOTE_KINDS.items():
        vals = []
        for child in el.findall(tag):
            vals.extend(clean(n.text) for n in child.findall("note"))
        if vals:
            out[key] = vals
    s7 = el.find("sevenChrDef")
    if s7 is not None:
        out["s7"] = [[ext.get("char"), clean(ext.text)] for ext in s7.findall("extension")]
    return out


def strip_range(text):
    return re.sub(r"\s*\([A-Z0-9-]+\)\s*$", "", text)


def parse_tabular(raw):
    root = ET.fromstring(raw)
    chapters, sections, cat2sec, notes = [], [], {}, {}

    def walk(diag):
        name = nodot(diag.findtext("name"))
        n = collect_notes(diag)
        if n:
            notes[name] = n
        for child in diag.findall("diag"):
            walk(child)

    for ch in root.findall("chapter"):
        desc = clean(ch.findtext("desc"))
        m = re.search(r"\(([A-Z0-9]+-[A-Z0-9]+)\)\s*$", desc)
        chapter = {"n": ch.findtext("name"), "t": strip_range(desc), "r": m.group(1) if m else "",
                   "s": [], "notes": collect_notes(ch)}
        ch_idx = len(chapters)
        chapters.append(chapter)
        for sec in ch.findall("section"):
            sec_idx = len(sections)
            sections.append({"id": sec.get("id"), "t": strip_range(clean(sec.findtext("desc"))),
                             "c": ch_idx, "notes": collect_notes(sec)})
            chapter["s"].append(sec_idx)
            for diag in sec.findall("diag"):
                cat2sec[nodot(diag.findtext("name"))] = sec_idx
                walk(diag)
    return chapters, sections, cat2sec, notes


# ---------------------------------------------------------------- index & tables
def parse_index(raw):
    """Flatten an Alphabetic Index into TSV rows: level, title, code, manif, see, seeAlso."""
    root = ET.fromstring(raw)
    rows = []

    def walk(el, level):
        see = "; ".join(full_text(s) for s in el.findall("see"))
        see_also = "; ".join(full_text(s) for s in el.findall("seeAlso"))
        cat = el.find("seecat")
        if cat is not None:
            see = (see + "; " if see else "") + full_text(cat)
        rows.append("\t".join([str(level), full_text(el.find("title")), clean(el.findtext("code")),
                               clean(el.findtext("manif")), see, see_also]))
        for t in el.findall("term"):
            walk(t, level + 1)

    for letter in root.findall("letter"):
        for mt in letter.findall("mainTerm"):
            walk(mt, 0)
    return "\n".join(rows)


def parse_table(raw):
    """Drug or Neoplasm table: headers + TSV rows of level, title, then one code per column."""
    root = ET.fromstring(raw)
    heads = [clean(h.text) for h in root.find("indexHeading").findall("head")]
    ncols = len(heads)
    rows = []

    def walk(el, level):
        cells = [""] * (ncols - 1)
        for c in el.findall("cell"):
            col = int(c.get("col")) - 2
            val = clean(c.text)
            if 0 <= col < len(cells) and val not in ("--", "-", ""):
                cells[col] = val
        see = "; ".join(full_text(s) for s in el.findall("see") + el.findall("seeAlso"))
        rows.append("\t".join([str(level), full_text(el.find("title"))] + cells + [see]))
        for t in el.findall("term"):
            walk(t, level + 1)

    for letter in root.findall("letter"):
        for mt in letter.findall("mainTerm"):
            walk(mt, 0)
    return {"heads": heads, "rows": "\n".join(rows)}


# ---------------------------------------------------------------- PCS
def parse_pcs_index(raw):
    """
    Flatten the PCS Index into TSV rows: level, title, code, "", see, use.
    "code" is a full code, a code prefix (<codes>) or a table (<tab>); the app treats all as prefixes.
    A term without a title (it only holds one alternative "see") keeps an empty title.
    """
    root = ET.fromstring(raw)
    rows = []

    def own_text(el):
        return clean(el.text) if el is not None else ""

    def target(el):
        for tag in ("code", "codes", "tab"):
            v = clean(el.findtext(tag)) if el is not None else ""
            if v:
                return v
        return ""

    def walk(el, level):
        see, use = el.find("see"), el.find("use")
        code = target(el) or target(see) or target(use)
        rows.append("\t".join([str(level), full_text(el.find("title")), code, "", own_text(see), own_text(use)]))
        for t in el.findall("term"):
            walk(t, level + 1)

    for letter in root.findall("letter"):
        for mt in letter.findall("mainTerm"):
            walk(mt, 0)
    return "\n".join(rows)


def parse_pcs_tables(raw):
    """
    PCS tables -> sections, body systems and per-table character meanings.
    tables["0DT"] = {"l": [section, body system, operation], "ax": [axis titles 1-3], "def": ...,
                     "rows": [[[axis title, {char: label}], x4 for characters 4-7], ...]}
    Rows are kept apart because the meaning of a character can depend on the row.
    """
    root = ET.fromstring(raw)
    sections, systems, tables = [], [], {}
    seen_sec, seen_sys = set(), set()
    for tb in root.findall("pcsTable"):
        head = {int(a.get("pos")): a for a in tb.findall("axis")}
        chars = [head[p].find("label").get("code") for p in (1, 2, 3)]
        labels = [clean(head[p].find("label").text) for p in (1, 2, 3)]
        if chars[0] not in seen_sec:
            seen_sec.add(chars[0])
            sections.append([chars[0], labels[0]])
        if chars[0] + chars[1] not in seen_sys:
            seen_sys.add(chars[0] + chars[1])
            systems.append([chars[0] + chars[1], labels[1]])
        rows = []
        for row in tb.findall("pcsRow"):
            axes = {int(a.get("pos")): a for a in row.findall("axis")}
            rows.append([[clean(axes[p].findtext("title")),
                          {lb.get("code"): clean(lb.text) for lb in axes[p].findall("label")}] for p in (4, 5, 6, 7)])
        tables["".join(chars)] = {
            "l": labels, "ax": [clean(head[p].findtext("title")) for p in (1, 2, 3)],
            "def": clean(head[3].findtext("definition")), "rows": rows}
    return sections, systems, tables


def pcs_row_of(table, code):
    for row in table["rows"]:
        if all(code[3 + i] in row[i][1] for i in range(4)):
            return row
    return None


# ---------------------------------------------------------------- output
def strip_empty(obj):
    if isinstance(obj, dict):
        return {k: strip_empty(v) for k, v in obj.items() if v not in ({}, [], "", None)}
    if isinstance(obj, list):
        return [strip_empty(v) for v in obj]
    return obj


def write_js(path, prefix, obj):
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("/* Generated by scripts/build_data.py from official public files. Do not edit. */\n")
        f.write(prefix)
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")


def read_js(path):
    """Read back the JSON payload of a file written by write_js."""
    with io.open(path, encoding="utf-8") as f:
        text = f.read()
    # Data files assign to ...["<id>"] = {...}; the manifest files assign to window.NAME = {...};
    mark = '"] = ' if '"] = ' in text[:300] else " = "
    return json.loads(text[text.index(mark, text.index("*/")) + len(mark):].rstrip().rstrip(";"))


def codes_tsv(codes):
    """One line per code: code, billable 0/1, English description[, Chinese name]."""
    return "\n".join("\t".join([c[0], "1" if c[1] else "0", c[2]] + ([c[3]] if len(c) > 3 else [])) for c in codes)


def cm_file(v):
    return f"data/icd10cm-{v['id']}.js"


def pcs_file(v):
    return f"data/icd10pcs-{v['id']}.js"


def cm_structure(found, codes):
    chapters, sections, cat2sec, notes = parse_tabular(read(found, "tabular"))
    # A category that the Tabular List does not have (an NHI-only code such as U00.0REH)
    # goes to the section whose range covers it, so it still shows up when browsing.
    for cat in sorted({c[0][:3] for c in codes} - set(cat2sec)):
        for i, sec in enumerate(sections):
            lo, _, hi = sec["id"].partition("-")
            if lo <= cat <= (hi or lo):
                cat2sec[cat] = i
                break
    return chapters, sections, cat2sec, notes


def write_cm(v, codes, found, extra=None):
    chapters, sections, cat2sec, notes = cm_structure(found, codes)
    data = strip_empty({
        "id": v["id"], "version": v["label"], "effective": v["effective"],
        "source": [source(s)[0] for s in v["zips"]], "chapters": chapters, "sections": sections,
        "cat2sec": cat2sec, "notes": notes,
    })
    data.update(extra or {})
    data["codes"] = codes_tsv(codes)
    data["index"] = parse_index(read(found, "index"))
    data["eindex"] = parse_index(read(found, "eindex"))
    data["drug"] = parse_table(read(found, "drug"))
    data["neoplasm"] = parse_table(read(found, "neoplasm"))
    out = os.path.join(ROOT, cm_file(v))
    write_js(out, f'(window.ICD10CM_DATA = window.ICD10CM_DATA || {{}})["{v["id"]}"] = ', data)
    billable = sum(1 for c in codes if c[1])
    print(f"  {os.path.relpath(out, ROOT)}  {os.path.getsize(out) / 1e6:.1f} MB  "
          f"codes {len(codes)} (billable {billable})  index rows {data['index'].count(chr(10)) + 1}")
    return cat2sec


def manifest_entry(v, codes, pcs_codes=None):
    m = {"id": v["id"], "kind": v["kind"], "label": v["label"], "labelZh": v["labelZh"],
         "effective": v["effective"], "files": [cm_file(v)],
         "count": len(codes), "billable": sum(1 for c in codes if c[1])}
    if v["kind"] == "nhi":
        m.update({"zh": True, "nhiEffective": v["nhiEffective"], "revision": v["revision"]})
    if pcs_codes is not None:
        m["files"].append(pcs_file(v))
        m["pcs"] = {"count": len(pcs_codes), "billable": sum(1 for c in pcs_codes if c[1])}
    return m


def build_us(v):
    print(f"[{v['label']}]")
    found = collect_members([download(u) for u in v["zips"]], MEMBERS)
    codes = parse_order(read(found, "order"))
    write_cm(v, codes, found)
    return manifest_entry(v, codes), codes


def build_nhi(v):
    print(f"[{v['label']}]")
    report = [f"Verification report: {v['id']} ({v['labelZh']})", ""]

    def say(line=""):
        report.append(line)
        print("  " + line if line else "")

    xlsx = download(v["nhi"])
    zips = [download(u) for u in v["zips"]]
    pzips = [download(u) for u in v["pcs_zips"]]
    say("Sources")
    for p in [xlsx] + zips + pzips:
        say(f"  {os.path.basename(p)}  {os.path.getsize(p):,} bytes  sha256 {sha256(p)}")
    say(f"  NHI workbook revision: {v['revision']}")
    say()

    book = read_xlsx(xlsx, [NHI_SHEET_CM, NHI_SHEET_PCS])
    cm, cm_fixed = repair_names(nhi_rows(book[NHI_SHEET_CM], "CM"))
    pcs, pcs_fixed = repair_names(nhi_rows(book[NHI_SHEET_PCS], "PCS"))
    problems = []
    say(f"Chinese names repaired (NHI_NAME_REPAIRS): {len(cm_fixed) + len(pcs_fixed)}")
    for code, old, new in cm_fixed + pcs_fixed:
        say(f"  {code}	{old}	->	{new}")
    left = [c[0] for c in cm + pcs if "?" in c[3] or "�" in c[3]]
    say(f"Chinese names that still contain '?': {len(left)}  {left[:20]}")
    say()

    # ---- CM: the NHI list is the code list; compare it with the U.S. order file.
    found = collect_members(zips, MEMBERS)
    us = {c: (b, d) for c, b, d in parse_order(read(found, "order"))}
    nhi = {c[0]: c for c in cm}
    say(f"ICD-10-CM  NHI {len(cm):,} codes ({sum(1 for c in cm if c[1]):,} billable)   "
        f"U.S. order file {len(us):,} codes ({sum(1 for b, _ in us.values() if b):,} billable)")
    only_us = sorted(set(us) - set(nhi))
    only_nhi = sorted(set(nhi) - set(us))
    say(f"  in the U.S. file but not in NHI: {len(only_us)}" + (f"  {only_us}" if only_us else ""))
    if only_us:
        problems.append(f"{len(only_us)} U.S. CM codes are missing from the NHI list")
    say(f"  in NHI but not in the U.S. file: {len(only_nhi)}  (later U.S. update and NHI-only codes)")
    for c in only_nhi:
        say(f"    {c}\t{'1' if nhi[c][1] else '0'}\t{nhi[c][2]}")
    flags = sorted(c for c in nhi if c in us and nhi[c][1] != us[c][0])
    say(f"  billable flag differs: {len(flags)}  {flags}")
    descs = sorted(c for c in nhi if c in us and nhi[c][2] != us[c][1])
    say(f"  English description differs: {len(descs)}  {descs}")
    no_zh = [c[0] for c in cm if not c[3]]
    say(f"  codes without a Chinese name: {len(no_zh)}")
    bad = [c[0] for c in cm if not re.fullmatch(r"[A-Z]\d[0-9A-Z]{1,5}", c[0])]
    if bad:
        problems.append(f"CM codes with an unexpected shape: {bad[:10]}")
    cat2sec = write_cm(v, cm, found, {"zh": True, "nhiRevision": v["revision"]})
    orphans = sorted({c[0][:3] for c in cm} - set(cat2sec))
    say(f"  categories without a chapter/section in the U.S. Tabular List: {len(orphans)}  {orphans}")
    say()

    # ---- PCS: NHI lists the 7-character codes; compare them with the U.S. order file.
    pfound = collect_members(pzips, PCS_MEMBERS)
    order = parse_order(read(pfound, "order"))
    us_pcs = {c: d for c, b, d in order if b}
    npcs = {c[0]: c for c in pcs}
    say(f"ICD-10-PCS  NHI {len(pcs):,} codes   U.S. order file {len(us_pcs):,} codes "
        f"+ {len(order) - len(us_pcs):,} table headers")
    only_us = sorted(set(us_pcs) - set(npcs))
    only_nhi = sorted(set(npcs) - set(us_pcs))
    say(f"  in the U.S. file but not in NHI: {len(only_us)}  {only_us[:20]}")
    say(f"  in NHI but not in the U.S. file: {len(only_nhi)}  {only_nhi[:20]}")
    if only_us:
        problems.append(f"{len(only_us)} U.S. PCS codes are missing from the NHI list")
    descs = sorted(c for c in npcs if c in us_pcs and npcs[c][2] != us_pcs[c])
    say(f"  English description differs: {len(descs)}  {descs[:20]}")
    say(f"  codes without a Chinese name: {sum(1 for c in pcs if not c[3])}")
    bad = [c[0] for c in pcs if not re.fullmatch(r"[0-9A-HJ-NP-Z]{7}", c[0])]
    if bad:
        problems.append(f"PCS codes with an unexpected shape: {bad[:10]}")
    clash = sorted(set(nhi) & set(npcs))
    say(f"  codes that exist in both CM and PCS: {len(clash)}  {clash}")
    if clash:
        problems.append("a code exists in both CM and PCS; the app needs one meaning per code")

    # Codes in order-file order; NHI-only codes go last. The 3-character table headers of the
    # order file are not codes (58 of them look like CM categories, e.g. B00); tables come from the XML.
    pcs_codes = [npcs[c] for c, b, _ in order if b and c in npcs] + [npcs[c] for c in only_nhi]
    sections, systems, tables = parse_pcs_tables(read(pfound, "tables"))
    headers = {c for c, b, _ in order if not b}
    say(f"  tables in the U.S. tables file {len(tables)}; table headers in the order file without a table: "
        f"{sorted(headers - set(tables))}")
    no_table = [c[0] for c in pcs if c[0][:3] not in tables or not pcs_row_of(tables[c[0][:3]], c[0])]
    say(f"  codes whose 7 characters are not all defined in the U.S. tables: {len(no_table)}  {no_table[:20]}")
    pdata = {"id": v["id"], "source": [source(s)[0] for s in v["pcs_zips"]],
             "sections": sections, "systems": systems, "tables": tables,
             "codes": codes_tsv(pcs_codes), "index": parse_pcs_index(read(pfound, "index"))}
    out = os.path.join(ROOT, pcs_file(v))
    write_js(out, f'(window.ICD10PCS_DATA = window.ICD10PCS_DATA || {{}})["{v["id"]}"] = ', pdata)
    print(f"  {os.path.relpath(out, ROOT)}  {os.path.getsize(out) / 1e6:.1f} MB  "
          f"codes {len(pcs_codes)}  tables {len(tables)}  index rows {pdata['index'].count(chr(10)) + 1}")
    say()
    say("Result: " + ("OK - every NHI code is in the data files; no U.S. code is missing."
                      if not problems else "PROBLEMS - " + "; ".join(problems)))
    with io.open(os.path.join(DATA, f"verify-{v['id']}.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(report) + "\n")
    if problems:
        sys.exit("Build stopped: " + "; ".join(problems))
    return manifest_entry(v, cm, pcs_codes), cm


def reuse(v):
    """Manifest entry and CM code list of a version that was built earlier."""
    def codes_of(path):
        return [(p[0], p[1] == "1", p[2]) for p in (ln.split("\t") for ln in read_js(path)["codes"].split("\n"))]
    codes = codes_of(os.path.join(ROOT, cm_file(v)))
    pcs = codes_of(os.path.join(ROOT, pcs_file(v))) if v["kind"] == "nhi" else None
    return manifest_entry(v, codes, pcs), codes


def diff(old, new):
    o = {c[0]: (c[1], c[2]) for c in old}
    n = {c[0]: (c[1], c[2]) for c in new}
    added = [[c, int(n[c][0]), n[c][1]] for c in n if c not in o]
    deleted = [[c, int(o[c][0]), o[c][1]] for c in o if c not in n]
    revised = [[c, o[c][1], n[c][1]] for c in n if c in o and o[c][1] != n[c][1]]
    billable = [[c, int(o[c][0]), int(n[c][0])] for c in n if c in o and o[c][0] != n[c][0]]
    return {"added": sorted(added), "deleted": sorted(deleted), "revised": sorted(revised), "billable": sorted(billable)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", help="version ids to (re)build, e.g. 2023-nhi 2027")
    args = ap.parse_args()
    os.makedirs(RAW, exist_ok=True)
    unknown = set(args.only or []) - {v["id"] for v in VERSIONS}
    if unknown:
        sys.exit(f"Unknown version id {sorted(unknown)}; known: {[v['id'] for v in VERSIONS]}")

    manifest, all_codes = [], {}
    for v in VERSIONS:
        if args.only and v["id"] not in args.only:
            if not os.path.exists(os.path.join(ROOT, cm_file(v))):
                continue
            m, codes = reuse(v)
        else:
            m, codes = build_nhi(v) if v["kind"] == "nhi" else build_us(v)
        manifest.append(m)
        all_codes[v["id"]] = codes

    ids = [m["id"] for m in manifest]
    if DEFAULT_VERSION not in ids:
        sys.exit(f"DEFAULT_VERSION {DEFAULT_VERSION!r} is not among the built versions {ids}")
    write_js(os.path.join(DATA, "versions.js"), "window.ICD10CM_VERSIONS = ",
             {"default": DEFAULT_VERSION, "latest": ids[-1], "versions": manifest})

    pairs = []
    for a, b in zip(ids, ids[1:]):
        d = diff(all_codes[a], all_codes[b])
        d.update({"from": a, "to": b})
        pairs.append(d)
        print(f"  changes {a} -> {b}: +{len(d['added'])} -{len(d['deleted'])} ~{len(d['revised'])}")
    write_js(os.path.join(DATA, "changes.js"), "window.ICD10CM_CHANGES = ", pairs)
    print("Done.")


if __name__ == "__main__":
    main()
