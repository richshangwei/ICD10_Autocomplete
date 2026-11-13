// Load the generated data files in Node (they are browser scripts that assign to window.*).
// Used by the tests and by scripts/check_abbreviations.cjs.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");
const Core = require(path.join(ROOT, "js", "core.js"));

function runScript(file, sandbox) {
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, file), "utf8"), sandbox, { filename: file });
  return sandbox.window;
}

function loadManifest() {
  return runScript("data/versions.js", { window: {} }).ICD10CM_VERSIONS;
}

function loadChanges() {
  return runScript("data/changes.js", { window: {} }).ICD10CM_CHANGES;
}

/** Raw data objects of one version: { cm, pcs } (pcs is undefined when the version has none). */
function loadData(id) {
  const manifest = loadManifest();
  const v = manifest.versions.find((x) => x.id === id);
  if (!v) throw new Error(`Unknown version ${id}; known: ${manifest.versions.map((x) => x.id).join(", ")}`);
  const sandbox = { window: {} };
  v.files.forEach((f) => runScript(f, sandbox));
  return { cm: sandbox.window.ICD10CM_DATA[id], pcs: (sandbox.window.ICD10PCS_DATA || {})[id] };
}

const cache = new Map();
/** Search index of one version (cached). */
function loadIndex(id) {
  if (!cache.has(id)) {
    const d = loadData(id);
    cache.set(id, Core.createIndex(d.cm, d.pcs));
  }
  return cache.get(id);
}

module.exports = { ROOT, Core, loadManifest, loadChanges, loadData, loadIndex };
