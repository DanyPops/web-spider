#!/usr/bin/env node
/**
 * Postinstall compatibility patches for Bun/Pi.
 *
 * Bun (embedded in Pi) resolves package.json exports strictly —
 * packages with top-level condition keys but no "." root entry fail.
 * Also wraps jsdom's tough-cookie require in try/catch so Pi boots
 * even when Bun's symlink-aware resolver can't traverse node_modules.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const root = new URL("../", import.meta.url).pathname;

/** Recursively find files matching a predicate. */
function find(dir, pred, results = []) {
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) find(full, pred, results);
        else if (pred(full)) results.push(full);
      } catch { /* skip unreadable */ }
    }
  } catch { /* skip unreadable dirs */ }
  return results;
}

/** Patch a file if the old string is present. */
function patch(filePath, oldStr, newStr) {
  try {
    const src = readFileSync(filePath, "utf8");
    if (!src.includes(oldStr)) return false;
    writeFileSync(filePath, src.replaceAll(oldStr, newStr));
    return true;
  } catch { return false; }
}

const nm = join(root, "node_modules");

// ── 1. tr46: require("punycode/") → require("punycode") ──────────────────────
let tr46count = 0;
for (const f of find(nm, f => f.endsWith("tr46/index.js"))) {
  if (patch(f, `require("punycode/")`, `require("punycode")`)) tr46count++;
}
if (tr46count) console.log(`patched tr46 (${tr46count} file(s))`);

// ── 2. tough-cookie@6: add missing "." root to exports ───────────────────────
const tcPkg = join(nm, "tough-cookie", "package.json");
if (existsSync(tcPkg)) {
  const d = JSON.parse(readFileSync(tcPkg, "utf8"));
  const exp = d.exports ?? {};
  if (typeof exp === "object" && !("." in exp) && Object.keys(exp).length > 0) {
    d.exports = { ".": exp };
    writeFileSync(tcPkg, JSON.stringify(d, null, 2));
    console.log("patched tough-cookie: added '.' root to exports");
  }
}

// ── 3. jsdom api.js: make tough-cookie optional ───────────────────────────────
// When Bun follows workspace symlinks for ESM imports, CJS require()
// inside transitive CJS deps (jsdom) may fail. Optional require avoids crash.
const OLD_TC = `const toughCookie = require("tough-cookie");`;
const NEW_TC = [
  `let toughCookie;`,
  `try { toughCookie = require("tough-cookie"); }`,
  `catch { toughCookie = {`,
  `  CookieJar: class {`,
  `    setCookieSync() {} getCookiesSync() { return []; } toJSON() { return {}; }`,
  `  }`,
  `}; }`,
].join(" ");

let jsdomCount = 0;
for (const f of find(nm, f => f.includes("/jsdom/lib/api.js"))) {
  if (patch(f, OLD_TC, NEW_TC)) jsdomCount++;
}
if (jsdomCount) console.log(`patched jsdom api.js (${jsdomCount} file(s))`);

console.log("postinstall done");
