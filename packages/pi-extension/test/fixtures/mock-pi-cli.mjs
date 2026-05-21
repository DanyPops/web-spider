#!/usr/bin/env node
/**
 * mock-pi-cli.mjs — minimal Pi CLI stub for E2E integration tests.
 *
 * Replicates the production jiti load path (alias + tryNative:true, NOT
 * tryNative:false as the test harness uses). This is the critical difference
 * that lets us verify error propagation in the real runtime context.
 *
 * Accepts Pi CLI args subset:
 *   --extension <path>    extension entry point to load
 *   --env KEY=VALUE       environment overrides (repeatable)
 *   --tool <name>         tool to invoke (default: web_fetch)
 *   --params <json>       tool params as JSON string
 *
 * Emits NDJSON events on stdout matching Pi's --mode json format:
 *   { type: "tool_execution_start", toolName, args }
 *   { type: "tool_execution_end",   toolName, result }
 *   { type: "exit", code }
 */

import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const get  = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const getAll = (flag) => {
  const vals = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === flag) vals.push(args[i + 1]);
  return vals;
};

const extensionPath = get("--extension");
const toolName      = get("--tool") ?? "web_fetch";
const paramsJson    = get("--params") ?? "{}";
const envOverrides  = Object.fromEntries(getAll("--env").map(s => s.split("=", 2)));

if (!extensionPath) { process.stderr.write("--extension required\n"); process.exit(1); }

for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;

// Jiti with production Pi Node.js settings: alias map, tryNative defaults to true.
// tryNative:false (test harness) is what breaks vi.mock interception — this avoids it.
const __dirname  = dirname(fileURLToPath(import.meta.url));
const piDistRoot = resolve(__dirname, "../../../../../pi-mono/packages/coding-agent/dist");
const require    = createRequire(import.meta.url);

const alias = {
  "@earendil-works/pi-coding-agent": resolve(piDistRoot, "index.js"),
  "@earendil-works/pi-agent-core":   resolve(piDistRoot, "../../agent/dist/index.js"),
  "@earendil-works/pi-tui":          resolve(piDistRoot, "../../tui/dist/index.js"),
  "@earendil-works/pi-ai":           resolve(piDistRoot, "../../ai/dist/index.js"),
  "typebox":                         require.resolve("typebox"),
};

const jiti = createJiti(import.meta.url, { moduleCache: false, alias });


const tools = new Map();

const pi = {
  registerTool({ name, execute }) { tools.set(name, execute); },
  on() {},                    // lifecycle events — no-op
  registerCommand() {},
  ui: { notify() {} },
};

let factory;
try {
  factory = await jiti.import(resolve(extensionPath), { default: true });
} catch (err) {
  process.stderr.write(`[mock-pi-cli] load error: ${err.message}\n`);
  process.exit(1);
}

if (typeof factory !== "function") {
  process.stderr.write(`[mock-pi-cli] extension did not export a default function\n`);
  process.exit(1);
}

await factory(pi);

const execute = tools.get(toolName);
if (!execute) {
  process.stderr.write(`[mock-pi-cli] tool not found: ${toolName}\n`);
  process.exit(1);
}

const params = JSON.parse(paramsJson);

emit({ type: "tool_execution_start", toolName, args: params });

try {
  const result = await execute(`mock-call-${Date.now()}`, params);
  emit({ type: "tool_execution_end", toolName, result });
  emit({ type: "exit", code: 0 });
} catch (err) {
  emit({ type: "tool_execution_error", toolName, error: err?.message ?? String(err) });
  emit({ type: "exit", code: 1 });
}

function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
