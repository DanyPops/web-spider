#!/usr/bin/env node
/**
 * pi-loader-harness.mjs — 1:1 reproduction of Pi's production extension loader.
 *
 * Uses Pi's ACTUAL loadExtensionModule() jiti setup (same import.meta.url anchor,
 * same alias map, same tryNative default) by re-exporting the internal function
 * via a thin shim. This is the only way to reproduce bugs that only surface in
 * Pi's production load path (e.g. "Map operation called on non-Map object").
 *
 * Emits NDJSON on stdout — same format as mock-pi-cli.mjs and Pi's --mode json.
 *
 * Args:
 *   --extension <path>   extension entry point
 *   --tool <name>        tool to invoke (default: web_fetch)
 *   --params <json>      tool params as JSON
 *   --env KEY=VALUE      env overrides (repeatable)
 */

import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args  = process.argv.slice(2)
const get   = f => { const i = args.indexOf(f); return i !== -1 ? args[i+1] : null }
const getAll = f => { const v = []; for (let i=0;i<args.length-1;i++) if(args[i]===f) v.push(args[i+1]); return v }

const extensionPath = get("--extension")
const toolName      = get("--tool") ?? "web_fetch"
const paramsJson    = get("--params") ?? "{}"
const envOverrides  = Object.fromEntries(getAll("--env").map(s => s.split("=", 2)))

if (!extensionPath) { process.stderr.write("--extension required\n"); process.exit(1) }

for (const [k,v] of Object.entries(envOverrides)) process.env[k] = v

// ---------------------------------------------------------------------------
// Load Pi's actual extension infrastructure
// ---------------------------------------------------------------------------
const PI_LOADER = "/home/dpopsuev/Workspace/pi-mono/packages/coding-agent/dist/core/extensions/loader.js"

const {
  createExtensionRuntime,
  loadExtensions,
} = await import(pathToFileURL(PI_LOADER).href)

// ---------------------------------------------------------------------------
// Minimal EventBus stub — only what loadExtensions needs
// ---------------------------------------------------------------------------
const eventBus = {
  emit() {},
  on()  {},
  off() {},
}

// ---------------------------------------------------------------------------
// Load extension through Pi's EXACT production path
// ---------------------------------------------------------------------------
const runtime   = createExtensionRuntime()
const absExtPath = resolve(extensionPath)

// loadExtensions returns { extensions, errors, runtime }
const { extensions, errors } = await loadExtensions([absExtPath], process.cwd(), eventBus)

if (errors.length) {
  process.stderr.write(`[pi-loader-harness] load errors: ${JSON.stringify(errors)}\n`)
  process.exit(1)
}
if (!extensions.length) {
  process.stderr.write(`[pi-loader-harness] no extensions loaded\n`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Find the registered tool
// ---------------------------------------------------------------------------
const toolEntry = extensions[0].tools.get(toolName)
if (!toolEntry) {
  process.stderr.write(`[pi-loader-harness] tool not found: ${toolName}\n`)
  process.exit(1)
}

const params = JSON.parse(paramsJson)
emit({ type: "tool_execution_start", toolName, args: params })

try {
  const result = await toolEntry.definition.execute(`harness-${Date.now()}`, params)
  emit({ type: "tool_execution_end", toolName, result })
  emit({ type: "exit", code: 0 })
} catch (err) {
  emit({ type: "tool_execution_error", toolName, error: err?.message ?? String(err) })
  emit({ type: "exit", code: 1 })
}

function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\n") }
