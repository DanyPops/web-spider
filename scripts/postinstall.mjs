#!/usr/bin/env node
/**
 * Postinstall compatibility patches.
 *
 * Bun (embedded in Pi) resolves package.json exports strictly:
 * packages with top-level condition keys but no "." root entry are
 * unresolvable. These patches fix known incompatible packages without
 * forking them.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const root = new URL("../", import.meta.url).pathname;
const run = (cmd) => execSync(cmd, { stdio: "inherit" });

// 1. tr46: require("punycode/") → require("punycode")
run(`find ${root}node_modules -path '*/tr46/index.js' -exec sed -i 's|require("punycode/")|require("punycode")|g' {} +`);

// 2. tough-cookie@6: add missing "." root to exports field
const tcPkg = resolve(root, "node_modules/tough-cookie/package.json");
if (existsSync(tcPkg)) {
  const d = JSON.parse(readFileSync(tcPkg, "utf8"));
  const exp = d.exports ?? {};
  if (typeof exp === "object" && !("." in exp) && Object.keys(exp).length > 0) {
    d.exports = { ".": exp };
    writeFileSync(tcPkg, JSON.stringify(d, null, 2));
    console.log("patched: tough-cookie exports — added '.' root");
  }
}

// 3. jsdom api.js: wrap tough-cookie require in try/catch
// When Bun follows symlinks for ESM imports, CJS require() inside
// transitive CJS deps can fail. Making it optional prevents a hard crash.
run(
  `find ${root}node_modules -path '*/jsdom/lib/api.js' -exec sed -i ` +
  `'s|const toughCookie = require("tough-cookie");` +
  `|let toughCookie; try { toughCookie = require("tough-cookie"); } ` +
  `catch { toughCookie = { CookieJar: class { setCookieSync(){} getCookiesSync(){ return []; } toJSON(){ return {}; } } }; }|g' {} +`
);

console.log("postinstall patches applied");
