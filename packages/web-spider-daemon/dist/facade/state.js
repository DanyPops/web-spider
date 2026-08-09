// src/state.ts
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";

// ../../node_modules/.bun/@danypops+vehicle-server@0.18.2/node_modules/@danypops/vehicle-server/src/paths.ts
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
var LOOPBACK_HOST = "127.0.0.1";
function resolveDaemonPaths(names, options = {}) {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  if (platform === "darwin")
    return resolveMacDaemonPaths(names, home);
  if (platform === "win32")
    return resolveWindowsDaemonPaths(names, options.env ?? process.env, home);
  return resolveLinuxDaemonPaths(names, options, home);
}
function resolveLinuxDaemonPaths(names, options, home) {
  const env = options.env ?? process.env;
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const dataHome = env.XDG_DATA_HOME ?? join(home, ".local", "share");
  const stateHome = env.XDG_STATE_HOME ?? join(home, ".local", "state");
  const runtimeHome = env.XDG_RUNTIME_DIR ?? join("/run", "user", String(uid));
  const configHome = env.XDG_CONFIG_HOME ?? join(home, ".config");
  return {
    database: join(dataHome, names.stateDirectoryName, names.databaseFilename),
    token: join(stateHome, names.stateDirectoryName, names.tokenFilename),
    handle: join(runtimeHome, names.stateDirectoryName, names.handleFilename),
    serviceDescriptor: join(configHome, "systemd", "user", names.systemdUnitName)
  };
}
function resolveMacDaemonPaths(names, home) {
  const library = join(home, "Library");
  const appSupport = join(library, "Application Support", names.stateDirectoryName);
  return {
    database: join(appSupport, names.databaseFilename),
    token: join(appSupport, names.tokenFilename),
    handle: join(tmpdir(), names.stateDirectoryName, names.handleFilename),
    serviceDescriptor: join(appSupport, names.systemdUnitName)
  };
}
function resolveWindowsDaemonPaths(names, env, home) {
  const localAppData = env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local");
  const appData = env.APPDATA ?? win32.join(home, "AppData", "Roaming");
  const dataDir = win32.join(localAppData, names.stateDirectoryName, "Data");
  return {
    database: win32.join(dataDir, names.databaseFilename),
    token: win32.join(dataDir, names.tokenFilename),
    handle: win32.join(localAppData, "Temp", names.stateDirectoryName, names.handleFilename),
    serviceDescriptor: win32.join(appData, names.stateDirectoryName, "Config", names.systemdUnitName)
  };
}
function ensureAuthToken(tokenPath, errorLabel) {
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 448 });
  if (existsSync(tokenPath)) {
    chmodSync(tokenPath, 384);
    const token2 = readFileSync(tokenPath, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(token2))
      throw new Error(`invalid ${errorLabel} authentication token`);
    return token2;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, `${token}
`, { mode: 384 });
  return token;
}
function writeDaemonHandle(handlePath, handle, mode = 384) {
  const dirMode = mode & 36 ? 493 : 448;
  mkdirSync(dirname(handlePath), { recursive: true, mode: dirMode });
  const temporary = `${handlePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(handle)}
`, { mode });
  renameSync(temporary, handlePath);
}
function readDaemonHandle(handlePath) {
  try {
    const value = JSON.parse(readFileSync(handlePath, "utf8"));
    if (value.host !== LOOPBACK_HOST || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !Number.isInteger(value.pid)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}
function removeDaemonHandle(handlePath) {
  rmSync(handlePath, { force: true });
}

// src/constants.ts
var WEB_SPIDER_STATE_DIRECTORY = "web-spider";
var DATABASE_FILENAME = "web-spider.db";
var TOKEN_FILENAME = "auth-token";
var HANDLE_FILENAME = "daemon.json";
var LEGACY_SYSTEMD_UNIT_NAME = "web-spider.service";
var DB_OPTIMIZE_INTERVAL_MS = 24 * 60 * 60000;
var CACHE_DEFAULT_TTL_MS = 30 * 60 * 1000;
var CACHE_DEFAULT_INLINE_IMAGE_THRESHOLD = 32 * 1024;
var LEGACY_CACHE_DEFAULT_RELATIVE_PATH = [".cache", "web-spider", "pages.json"];

// src/state.ts
function resolveWebSpiderPaths(options = {}) {
  const resolved = resolveDaemonPaths({
    stateDirectoryName: WEB_SPIDER_STATE_DIRECTORY,
    databaseFilename: DATABASE_FILENAME,
    tokenFilename: TOKEN_FILENAME,
    handleFilename: HANDLE_FILENAME,
    systemdUnitName: LEGACY_SYSTEMD_UNIT_NAME
  }, options);
  return { database: resolved.database, token: resolved.token, handle: resolved.handle, systemdUnit: resolved.serviceDescriptor };
}
function ensureAuthToken2(paths = resolveWebSpiderPaths()) {
  return ensureAuthToken(paths.token, "Web Spider");
}
function writeDaemonHandle2(paths, handle) {
  writeDaemonHandle(paths.handle, handle);
}
function readDaemonHandle2(paths = resolveWebSpiderPaths()) {
  return readDaemonHandle(paths.handle);
}
function removeDaemonHandle2(paths = resolveWebSpiderPaths()) {
  removeDaemonHandle(paths.handle);
}
function resolveLegacyCachePath(options = {}) {
  const env = options.env ?? process.env;
  if (env.WEB_SPIDER_CACHE_PATH)
    return env.WEB_SPIDER_CACHE_PATH;
  const home = options.home ?? homedir2();
  return join2(home, ...LEGACY_CACHE_DEFAULT_RELATIVE_PATH);
}
export {
  writeDaemonHandle2 as writeDaemonHandle,
  resolveWebSpiderPaths,
  resolveLegacyCachePath,
  removeDaemonHandle2 as removeDaemonHandle,
  readDaemonHandle2 as readDaemonHandle,
  ensureAuthToken2 as ensureAuthToken
};
