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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	formatCacheListResult, formatCacheSearchResult, formatFetchResult, formatPapyrusIngestResult, formatSearchResult,
	formatSessionActResult, formatSessionCloseResult, formatSessionCreateResult, formatSessionListResult,
} from "./cli-format.ts";
import { connectWebSpiderClient, type WebSpiderClient } from "./client.ts";
import { SYSTEMD_UNIT_NAME } from "./constants.ts";
import { serveMain } from "./daemon.ts";
import { resolveWebSpiderPaths } from "./state.ts";

/** Search provider env vars service install forwards into the unit — see README's "Provider API keys" note. */
const SEARCH_API_KEY_VARS = ["BRAVE_SEARCH_API_KEY", "TAVILY_API_KEY", "EXA_API_KEY"] as const;

export interface SystemdUnitOptions {
	bunBin: string;
	cliPath: string;
	/**
	 * Search provider API keys to forward into the unit's Environment= lines.
	 * A systemd --user service does not inherit the installing shell's
	 * environment, so without this, `search` silently falls back to DDG-only
	 * even when a key is set in the shell that ran `service install` —
	 * confirmed happening in practice during a real dogfood smoke test.
	 * Only non-empty keys render a line; values are never logged anywhere.
	 */
	searchApiKeys?: Partial<Record<(typeof SEARCH_API_KEY_VARS)[number], string | undefined>>;
}

function escapeUnitValue(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function renderSystemdUnit(options: SystemdUnitOptions): string {
	const environmentLines = SEARCH_API_KEY_VARS
		.map((name): [string, string | undefined] => [name, options.searchApiKeys?.[name]])
		.filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
		.map(([name, value]) => `Environment="${name}=${escapeUnitValue(value)}"\n`)
		.join("");
	return `[Unit]
Description=Web Spider search, query, and scraping daemon
After=default.target network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${options.bunBin} ${options.cliPath} serve
${environmentLines}Restart=always
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
		searchApiKeys: Object.fromEntries(SEARCH_API_KEY_VARS.map((name) => [name, process.env[name]])),
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
	/**
	 * Reads an eval script body from a file (if scriptFile is given) or stdin
	 * otherwise. eval scripts are never accepted as a plain CLI flag value —
	 * Seeshell-derived principle: a shell-history/process-list-visible flag is
	 * the wrong channel for arbitrary, potentially sensitive script content.
	 * Throws if scriptFile is unset and stdin is an interactive TTY (nothing
	 * piped in) rather than hanging forever waiting for input.
	 */
	readEvalScript(scriptFile?: string): string;
}

function readEvalScript(scriptFile?: string): string {
	if (scriptFile) return readFileSync(scriptFile, "utf-8");
	if (process.stdin.isTTY) {
		throw new Error("eval requires a script on stdin (pipe it in) or --script-file PATH — never as a plain CLI flag");
	}
	return readFileSync(0, "utf-8");
}

const DEFAULT_DEPENDENCIES: CliDependencies = {
	get client() { return connectWebSpiderClient(); },
	stdout: console.log,
	stderr: console.error,
	systemctl,
	installService,
	serve: serveMain,
	readEvalScript,
};

function usage(stderr: (line: string) => void): number {
	stderr([
		"Usage: web-spider serve",
		"       web-spider service <install|start|stop|restart|status>",
		"       web-spider fetch <url> [--format markdown|lean|links|highlights|tree] [--depth N] [--max-pages N]",
		"                          [--no-same-domain] [--root-selector CSS] [--exclude-selectors CSS,CSS]",
		"                          [--token-budget N] [--enhanced] [--timeout-ms N] [--query TEXT] [--path DOTPATH]",
		"                          [--top-n N] [--ignore-robots] [--json]",
		"       web-spider search <query> [--num-results N] [--time-range day|week|month|year] [--topic news|general]",
		"                          [--engine brave|tavily|exa|ddg] [--json]",
		"       web-spider cache list [--grep TEXT] [--offset N] [--limit N] [--json]",
		"       web-spider cache search <query> [--limit N] [--json]",
		"       web-spider papyrus ingest <url...> [--relates-to ARTIFACT_ID] [--json]",
		"                          (each url must already be cached — fetch it first)",
		"       web-spider session create <name> [--force-chrome-channel] [--json]",
		"       web-spider session list [--json]",
		"       web-spider session close <name> [--json]",
		"       web-spider session act <name> --action navigate --snapshot-version N --url URL [--timeout-ms N] [--json]",
		"       web-spider session act <name> --action click --snapshot-version N --selector CSS [--timeout-ms N] [--json]",
		"       web-spider session act <name> --action type --snapshot-version N --selector CSS --text STR [--no-clear] [--timeout-ms N] [--json]",
		"       web-spider session act <name> --action select --snapshot-version N --selector CSS (--value STR | --label STR) [--timeout-ms N] [--json]",
		"       web-spider session act <name> --action waitFor --snapshot-version N (--selector CSS | --text STR | --load-state STATE) [--state STATE] [--timeout-ms N] [--json]",
		"       web-spider session act <name> --action queryText --snapshot-version N --selector CSS [--timeout-ms N] [--json]",
		"       web-spider session act <name> --action readTable --snapshot-version N --selector CSS [--timeout-ms N] [--json]",
		"       web-spider session act <name> --action snapshot --snapshot-version N [--selector CSS] [--depth N] [--boxes] [--mode ai|default] [--timeout-ms N] [--json]",
		"       web-spider session act <name> --action handleDialog --snapshot-version N (--accept | --dismiss) [--prompt-text STR] [--json]",
		"       web-spider session act <name> --action downloads --snapshot-version N [--json]",
		"       web-spider session act <name> --action eval --snapshot-version N [--script-file PATH] [--json]",
		"                          (reads the script from stdin if --script-file is omitted — never a plain flag)",
		"       web-spider session act <name> --action screenshot --snapshot-version N [--full-page | --selector CSS] [--scale css|device] [--json]",
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
	], ["--enhanced", "--no-same-domain", "--ignore-robots"]);
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
			ignoreRobots: parsed.flags.has("ignore-robots") || undefined,
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

async function runSessionCreate(rest: string[], deps: CliDependencies): Promise<number> {
	const parsed = parseArgs(rest, [], ["--force-chrome-channel"]);
	const name = parsed?.positional[0];
	if (!parsed || !name) return usage(deps.stderr);
	try {
		const result = await deps.client.call("session.create", { name, forceChromeChannel: parsed.flags.has("force-chrome-channel") || undefined });
		deps.stdout(parsed.flags.has("json") ? JSON.stringify(result) : formatSessionCreateResult(result));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

async function runSessionList(rest: string[], deps: CliDependencies): Promise<number> {
	const parsed = parseArgs(rest, [], []);
	if (!parsed) return usage(deps.stderr);
	try {
		const result = await deps.client.call("session.list", {});
		deps.stdout(parsed.flags.has("json") ? JSON.stringify(result) : formatSessionListResult(result));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

async function runSessionClose(rest: string[], deps: CliDependencies): Promise<number> {
	const parsed = parseArgs(rest, [], []);
	const name = parsed?.positional[0];
	if (!parsed || !name) return usage(deps.stderr);
	try {
		const result = await deps.client.call("session.close", { name });
		deps.stdout(parsed.flags.has("json") ? JSON.stringify(result) : formatSessionCloseResult(result));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

async function runSessionAct(rest: string[], deps: CliDependencies): Promise<number> {
	const parsed = parseArgs(rest, [
		"--action", "--snapshot-version", "--url", "--selector", "--script-file", "--timeout-ms", "--text", "--value", "--label", "--load-state", "--state", "--scale", "--depth", "--mode", "--prompt-text",
	], ["--no-clear", "--full-page", "--boxes", "--accept", "--dismiss"]);
	const name = parsed?.positional[0];
	if (!parsed || !name) return usage(deps.stderr);
	const action = parsed.values.action;
	if (action !== "navigate" && action !== "click" && action !== "type" && action !== "select" && action !== "waitFor" && action !== "queryText" && action !== "readTable" && action !== "snapshot" && action !== "handleDialog" && action !== "downloads" && action !== "eval" && action !== "screenshot") return usage(deps.stderr);
	if (action === "handleDialog" && parsed.flags.has("accept") && parsed.flags.has("dismiss")) return usage(deps.stderr);
	const snapshotVersion = parseIntFlag(parsed.values, "snapshot-version");
	if (snapshotVersion === undefined || Number.isNaN(snapshotVersion)) return usage(deps.stderr);
	const timeoutMs = parseIntFlag(parsed.values, "timeout-ms");
	if (Number.isNaN(timeoutMs)) return usage(deps.stderr);
	const depth = parseIntFlag(parsed.values, "depth");
	if (Number.isNaN(depth)) return usage(deps.stderr);

	try {
		const script = action === "eval" ? deps.readEvalScript(parsed.values["script-file"]) : undefined;
		const result = await deps.client.call("session.act", {
			name, action, snapshotVersion, timeoutMs,
			url: parsed.values.url,
			selector: parsed.values.selector,
			script,
			text: parsed.values.text,
			clear: parsed.flags.has("no-clear") ? false : undefined,
			value: parsed.values.value,
			label: parsed.values.label,
			loadState: parsed.values["load-state"] as "load" | "domcontentloaded" | "networkidle" | undefined,
			state: parsed.values.state as "visible" | "hidden" | "attached" | "detached" | undefined,
			fullPage: parsed.flags.has("full-page") ? true : undefined,
			scale: parsed.values.scale as "css" | "device" | undefined,
			depth,
			boxes: parsed.flags.has("boxes") ? true : undefined,
			mode: parsed.values.mode as "ai" | "default" | undefined,
			accept: parsed.flags.has("accept") ? true : parsed.flags.has("dismiss") ? false : undefined,
			promptText: parsed.values["prompt-text"],
		});
		deps.stdout(parsed.flags.has("json") ? JSON.stringify(result) : formatSessionActResult(result));
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
	if (command === "session") {
		const [subcommand, ...sessionRest] = rest;
		if (subcommand === "create") return runSessionCreate(sessionRest, deps);
		if (subcommand === "list") return runSessionList(sessionRest, deps);
		if (subcommand === "close") return runSessionClose(sessionRest, deps);
		if (subcommand === "act") return runSessionAct(sessionRest, deps);
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
