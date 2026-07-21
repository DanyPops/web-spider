#!/usr/bin/env bun
/**
 * CLI entry point — mirrors jittor/src/cli.ts's service-install shape and,
 * per the "Daemon-backed tools require CLI parity" rule, gives every
 * registered operation (service.ts EXPECTED_OPERATION_NAMES) a CLI route
 * using the authenticated typed client only — never SQLite directly.
 *
 * `fetch` and `crawl` share one CLI command (`web-spider fetch <url>
 * --depth N`), matching the web_fetch tool's own single-entry-point shape
 * where `depth > 0` routes to a crawl. Human output is a compact summary;
 * `--json` prints the exact operation result for machine consumption
 * (human-readable-output rule: stable schema for machines, names/actionable
 * language for humans — never parsed from the human text).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatCacheListResult, formatCacheSearchResult, formatFetchResult, formatPapyrusIngestResult, formatSearchResult } from "./cli-format.ts";
import { connectWebSpiderClient, type WebSpiderClient } from "./client.ts";
import { SYSTEMD_UNIT_NAME } from "./constants.ts";
import { serveMain } from "./daemon.ts";
import { resolveWebSpiderPaths } from "./state.ts";

export interface SystemdUnitOptions {
	bunBin: string;
	cliPath: string;
}

export function renderSystemdUnit(options: SystemdUnitOptions): string {
	return `[Unit]
Description=Web Spider search, query, and scraping daemon
After=default.target network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${options.bunBin} ${options.cliPath} serve
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;
}

function systemctl(...args: string[]): void {
	execFileSync("systemctl", ["--user", ...args], { stdio: "inherit" });
}

function installService(): void {
	const unitPath = resolveWebSpiderPaths().systemdUnit;
	mkdirSync(dirname(unitPath), { recursive: true });
	writeFileSync(unitPath, renderSystemdUnit({
		bunBin: process.execPath,
		cliPath: fileURLToPath(import.meta.url),
	}));
	systemctl("daemon-reload");
	systemctl("enable", SYSTEMD_UNIT_NAME);
	systemctl("restart", SYSTEMD_UNIT_NAME);
}

export interface CliDependencies {
	client: Pick<WebSpiderClient, "call">;
	stdout(line: string): void;
	stderr(line: string): void;
	systemctl(...args: string[]): void;
	installService(): void;
	serve(): void;
}

const DEFAULT_DEPENDENCIES: CliDependencies = {
	get client() { return connectWebSpiderClient(); },
	stdout: console.log,
	stderr: console.error,
	systemctl,
	installService,
	serve: serveMain,
};

function usage(stderr: (line: string) => void): number {
	stderr([
		"Usage: web-spider serve",
		"       web-spider service <install|start|stop|restart|status>",
		"       web-spider fetch <url> [--format markdown|lean|links|highlights|tree] [--depth N] [--max-pages N]",
		"                          [--no-same-domain] [--root-selector CSS] [--exclude-selectors CSS,CSS]",
		"                          [--token-budget N] [--enhanced] [--timeout-ms N] [--query TEXT] [--path DOTPATH]",
		"                          [--top-n N] [--json]",
		"       web-spider search <query> [--num-results N] [--time-range day|week|month|year] [--topic news|general]",
		"                          [--engine brave|tavily|exa|ddg] [--json]",
		"       web-spider cache list [--grep TEXT] [--offset N] [--limit N] [--json]",
		"       web-spider cache search <query> [--limit N] [--json]",
		"       web-spider papyrus ingest <url...> [--relates-to ARTIFACT_ID] [--json]",
		"                          (each url must already be cached — fetch it first)",
	].join("\n"));
	return 2;
}

// ---------------------------------------------------------------------------
// Flag parsing — hand-rolled, no dependency; one recognized-flag table per command.
// ---------------------------------------------------------------------------

interface ParsedArgs {
	positional: string[];
	values: Record<string, string>;
	flags: Set<string>;
}

function parseArgs(args: string[], valueFlags: readonly string[], booleanFlags: readonly string[]): ParsedArgs | null {
	const positional: string[] = [];
	const values: Record<string, string> = {};
	const flags = new Set<string>();
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) continue;
		if (arg === "--json" || booleanFlags.includes(arg)) { flags.add(arg.replace(/^--/, "")); continue; }
		if (valueFlags.includes(arg)) {
			index += 1;
			const value = args[index];
			if (value === undefined) return null;
			values[arg.replace(/^--/, "")] = value;
			continue;
		}
		if (arg.startsWith("--")) return null;
		positional.push(arg);
	}
	return { positional, values, flags };
}

function parseIntFlag(values: Record<string, string>, key: string): number | undefined {
	if (!(key in values)) return undefined;
	const parsed = Number(values[key]);
	return Number.isFinite(parsed) ? parsed : Number.NaN; // NaN signals "present but invalid" to the caller
}

async function runFetch(rest: string[], deps: CliDependencies): Promise<number> {
	const parsed = parseArgs(rest, [
		"--format", "--depth", "--max-pages", "--root-selector", "--exclude-selectors",
		"--token-budget", "--timeout-ms", "--query", "--path", "--top-n",
	], ["--enhanced", "--no-same-domain"]);
	const url = parsed?.positional[0];
	if (!parsed || !url) return usage(deps.stderr);

	const depth = parseIntFlag(parsed.values, "depth");
	if (Number.isNaN(depth)) return usage(deps.stderr);
	const maxPages = parseIntFlag(parsed.values, "max-pages");
	if (Number.isNaN(maxPages)) return usage(deps.stderr);
	const tokenBudget = parseIntFlag(parsed.values, "token-budget");
	if (Number.isNaN(tokenBudget)) return usage(deps.stderr);
	const timeoutMs = parseIntFlag(parsed.values, "timeout-ms");
	if (Number.isNaN(timeoutMs)) return usage(deps.stderr);
	const topN = parseIntFlag(parsed.values, "top-n");
	if (Number.isNaN(topN)) return usage(deps.stderr);

	try {
		const shared = {
			url,
			format: parsed.values.format as never,
			rootSelector: parsed.values["root-selector"],
			excludeSelectors: parsed.values["exclude-selectors"],
			tokenBudget,
			enhanced: parsed.flags.has("enhanced") || undefined,
			timeoutMs,
			query: parsed.values.query,
		};
		const result = (depth ?? 0) > 0
			? await deps.client.call("crawl", { ...shared, depth, maxPages, sameDomain: parsed.flags.has("no-same-domain") ? false : undefined })
			: await deps.client.call("fetch", { ...shared, path: parsed.values.path, topN });
		deps.stdout(parsed.flags.has("json") ? JSON.stringify(result) : formatFetchResult(result));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

async function runSearch(rest: string[], deps: CliDependencies): Promise<number> {
	const parsed = parseArgs(rest, ["--num-results", "--time-range", "--topic", "--engine"], []);
	const query = parsed?.positional[0];
	if (!parsed || !query) return usage(deps.stderr);
	const numResults = parseIntFlag(parsed.values, "num-results");
	if (Number.isNaN(numResults)) return usage(deps.stderr);

	try {
		const result = await deps.client.call("search", {
			query,
			numResults,
			timeRange: parsed.values["time-range"] as never,
			topic: parsed.values.topic as never,
			searchEngine: parsed.values.engine as never,
		});
		deps.stdout(parsed.flags.has("json") ? JSON.stringify(result) : formatSearchResult(result));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

async function runCacheList(rest: string[], deps: CliDependencies): Promise<number> {
	const parsed = parseArgs(rest, ["--grep", "--offset", "--limit"], []);
	if (!parsed) return usage(deps.stderr);
	const offset = parseIntFlag(parsed.values, "offset");
	if (Number.isNaN(offset)) return usage(deps.stderr);
	const limit = parseIntFlag(parsed.values, "limit");
	if (Number.isNaN(limit)) return usage(deps.stderr);

	try {
		const result = await deps.client.call("cache.list", { grep: parsed.values.grep, offset, limit });
		deps.stdout(parsed.flags.has("json") ? JSON.stringify(result) : formatCacheListResult(result));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

async function runCacheSearch(rest: string[], deps: CliDependencies): Promise<number> {
	const parsed = parseArgs(rest, ["--limit"], []);
	const query = parsed?.positional[0];
	if (!parsed || !query) return usage(deps.stderr);
	const limit = parseIntFlag(parsed.values, "limit");
	if (Number.isNaN(limit)) return usage(deps.stderr);

	try {
		const result = await deps.client.call("cache.search", { query, limit });
		deps.stdout(parsed.flags.has("json") ? JSON.stringify(result) : formatCacheSearchResult(result));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

async function runPapyrusIngest(rest: string[], deps: CliDependencies): Promise<number> {
	const parsed = parseArgs(rest, ["--relates-to"], []);
	if (!parsed || parsed.positional.length === 0) return usage(deps.stderr);

	try {
		const result = await deps.client.call("papyrus.ingest", {
			kind: "pages",
			urls: parsed.positional,
			relatesTo: parsed.values["relates-to"],
		});
		deps.stdout(parsed.flags.has("json") ? JSON.stringify(result) : formatPapyrusIngestResult(result));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

export async function runCli(args: string[], deps: CliDependencies = DEFAULT_DEPENDENCIES): Promise<number> {
	const [command, ...rest] = args;
	if (command === "serve") { deps.serve(); return 0; }
	if (command === "fetch") return runFetch(rest, deps);
	if (command === "search") return runSearch(rest, deps);
	if (command === "cache") {
		const [subcommand, ...cacheRest] = rest;
		if (subcommand === "list") return runCacheList(cacheRest, deps);
		if (subcommand === "search") return runCacheSearch(cacheRest, deps);
		return usage(deps.stderr);
	}
	if (command === "papyrus") {
		const [subcommand, ...papyrusRest] = rest;
		if (subcommand === "ingest") return runPapyrusIngest(papyrusRest, deps);
		return usage(deps.stderr);
	}
	if (command !== "service") return usage(deps.stderr);
	switch (rest[0]) {
		case "install": deps.installService(); return 0;
		case "start": deps.systemctl("start", SYSTEMD_UNIT_NAME); return 0;
		case "stop": deps.systemctl("stop", SYSTEMD_UNIT_NAME); return 0;
		case "restart": deps.systemctl("restart", SYSTEMD_UNIT_NAME); return 0;
		case "status": deps.systemctl("status", SYSTEMD_UNIT_NAME); return 0;
		default: return usage(deps.stderr);
	}
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
	process.exitCode = await runCli(args);
}

if (import.meta.main) await main();
