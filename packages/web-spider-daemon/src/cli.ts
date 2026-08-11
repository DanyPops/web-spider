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
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServiceCli, type ServiceAction, type ServiceCli, type ServiceSpec } from "@danypops/vehicle-server/service";
import { listRegisteredSearchEngines } from "@danypops/web-spider";
import type { CachedPageListFilter } from "./cache/page.ts";
import {
	formatCacheListResult,
	formatCacheSearchResult,
	formatCategoryAssignResult,
	formatCategoryListResult,
	formatCategoryRemoveResult,
	formatCategoryRenameResult,
	formatDaemonDiagnoseResult,
	formatFetchResult,
	formatQuotesResult,
	formatSearchResult,
	formatSearchTestKeysResult,
	formatSearchUsageResult,
	formatSessionActResult,
	formatSessionCloseResult,
	formatSessionCreateResult,
	formatSessionListResult,
} from "./cli-format.ts";
import { connectWebSpiderClient, type WebSpiderClient } from "./client.ts";
import { serveMain } from "./daemon.ts";
import { promptMaskedSecret } from "./masked-prompt.ts";
import { loadEnigmaConfig, resolveEnigmaConfigPath, saveEnigmaConfig } from "./search/enigma-config.ts";
import { createSearchKeyStore, resolveSearchKeysDir } from "./search/search-secrets.ts";
import { isSessionAction } from "./session/session-audit.ts";
import { resolveWebSpiderPaths, type WebSpiderPaths } from "./state.ts";
import { VERSION } from "./version.ts";

const LEGACY_PROVIDER_ENV: ReadonlyArray<readonly [string, string]> = [
	["BRAVE_SEARCH_API_KEY", "brave"],
	["TAVILY_API_KEY", "tavily"],
	["EXA_API_KEY", "exa"],
	["SERPER_API_KEY", "serper"],
	["SERPAPI_API_KEY", "serpapi"],
	["YOU_API_KEY", "you"],
];

export interface WebSpiderServiceSpecOptions {
	bunBin: string;
	cliPath: string;
	handlePath?: string;
}

/** Secret-free declaration projected into Armada desired state. */
export function webSpiderServiceSpec(options: WebSpiderServiceSpecOptions): ServiceSpec {
	return {
		name: "web-spider",
		displayName: "Web Spider search, query, and scraping daemon",
		version: VERSION,
		binPath: options.bunBin,
		args: [options.cliPath, "serve"],
		handlePath: options.handlePath ?? resolveWebSpiderPaths().handle,
		// Preserve the legacy service's availability and hardening through Armada's
		// portable runtime requirements; unsupported native managers fail explicitly.
		restartOnFailure: true,
		restartSec: 2,
		noNewPrivileges: true,
		privateTmp: true,
		waitForNetwork: true,
	};
}

function defaultServiceCli(): ServiceCli {
	return createServiceCli(
		webSpiderServiceSpec({
			bunBin: process.execPath,
			cliPath: fileURLToPath(import.meta.url),
		}),
	);
}

function legacyEnvironmentValue(environment: string, name: string): string | undefined {
	const match = environment.match(new RegExp(`(?:^|\\s)"?${name}=([^"\\s]+)"?`));
	return match?.[1];
}

/** Moves legacy unit configuration into daemon-owned stores without ever logging the values. */
export function migrateLegacyServiceEnvironment(environment: string, paths: WebSpiderPaths = resolveWebSpiderPaths()): void {
	const searchKeysDir = resolveSearchKeysDir(paths);
	for (const [name, engine] of LEGACY_PROVIDER_ENV) {
		const value = legacyEnvironmentValue(environment, name);
		if (value) createSearchKeyStore(searchKeysDir, engine).save(value);
	}
	const enigmaFlag = legacyEnvironmentValue(environment, "WEB_SPIDER_USE_ENIGMA");
	if (enigmaFlag === "1" || enigmaFlag === "true") {
		saveEnigmaConfig(resolveEnigmaConfigPath(paths), { useEnigma: true });
	}
	// ENIGMA_CLIENT_TOKEN is intentionally not migrated: Enigma's shared token
	// file is the credential boundary, never Armada or Web Spider config.
}

export interface LegacyServiceMigration {
	/** Stops the legacy unit if active and reports whether rollback should restart it. */
	stopForCutover(): boolean;
	restore(): void;
	/** Called only after Armada reconciliation and readiness succeed. */
	remove(): void;
}

function defaultLegacyServiceMigration(): LegacyServiceMigration {
	const paths = resolveWebSpiderPaths();
	const runSystemctl = (...args: string[]) => execFileSync("systemctl", ["--user", ...args], { stdio: "ignore" });
	return {
		stopForCutover() {
			try {
				const environment = execFileSync("systemctl", ["--user", "show", "web-spider.service", "--property=Environment", "--value"], {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				});
				migrateLegacyServiceEnvironment(environment);
			} catch {
				// No legacy descriptor (or no readable environment) is the normal fresh-install case.
			}
			try {
				runSystemctl("is-active", "--quiet", "web-spider.service");
			} catch {
				return false;
			}
			runSystemctl("stop", "web-spider.service");
			return true;
		},
		restore: () => runSystemctl("start", "web-spider.service"),
		remove() {
			try {
				runSystemctl("disable", "web-spider.service");
			} catch {
				// An already-disabled legacy unit is still safe to remove.
			}
			if (existsSync(paths.systemdUnit)) unlinkSync(paths.systemdUnit);
			runSystemctl("daemon-reload");
		},
	};
}

export interface CliDependencies {
	client: Pick<WebSpiderClient, "call">;
	stdout(line: string): void;
	stderr(line: string): void;
	service: Pick<ServiceCli, "unitName" | "install" | "action">;
	legacyService: LegacyServiceMigration;
	serve(): void | Promise<void>;
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
	get client() {
		return connectWebSpiderClient();
	},
	stdout: console.log,
	stderr: console.error,
	get service() {
		return defaultServiceCli();
	},
	get legacyService() {
		return defaultLegacyServiceMigration();
	},
	serve: serveMain,
	readEvalScript,
};

function usage(stderr: (line: string) => void): number {
	stderr(
		[
			"Usage: web-spider serve",
			"       web-spider service <install|start|stop|restart|status>",
			"       web-spider fetch <url> [--format markdown|lean|links|highlights|tree|source] [--depth N] [--max-pages N]",
			"                          [--no-same-domain] [--root-selector CSS] [--exclude-selectors CSS,CSS]",
			"                          [--token-budget N] [--pdf-page-start N] [--pdf-page-end N] [--enhanced]",
			"                          [--timeout-ms N] [--query TEXT] [--path DOTPATH]",
			"                          [--top-n N] [--ignore-robots] [--sources NAME,NAME,...] [--max-cache-age-ms N] [--json]",
			"       web-spider search <query> [--num-results N] [--time-range day|week|month|year] [--topic news|general]",
			"                          [--engine brave|brave-llm|tavily|exa|serper|serpapi|you] [--site-filter DOMAIN] [--full-content] [--json]",
			"       web-spider quotes <query> --urls URL,URL,... [--max-quotes-per-url N] [--max-quotes-total N]",
			"                          [--timeout-ms N] [--enhanced] [--ignore-robots] [--sources NAME,NAME,...] [--max-cache-age-ms N] [--json]",
			"                          (search + selective-fetch resource finder -- ranked, verbatim quotes per url, never a digested answer)",
			"       web-spider usage [--engine NAME] [--limit N] [--json]",
			"                          (per-call credits/cost/rate-limit-header data the engine itself reported -- never a running account balance)",
			"       web-spider search-key set <engine>    store a search-provider API key locally, replacing any previously stored key(s) (hidden prompt, or set WEB_SPIDER_SEARCH_KEY_VALUE)",
			"       web-spider search-key add <engine>     stack an additional key alongside any already stored (BYOK key stacking, per-key rotation/cooldown)",
			"       web-spider search-key list             list engines with a locally stored key, never the key itself",
			"       web-spider search-key remove <engine>  delete every locally stored key for this engine",
			"       web-spider search-key test <engine>    live-test every locally stored key for this engine [--json]",
			"                          (local, unconditional fallback beneath Enigma; takes effect on the daemon's next restart)",
			"       web-spider enigma <enable|disable|status>  persist the non-secret Enigma opt-in outside service environment data",
			"       web-spider daemon diagnose [--history-limit N] [--json]  this daemon's own identity + recent restart history",
			"       web-spider cache list [--grep TEXT] [--domain TEXT] [--tag TEXT] [--category TEXT] [--fetched-after MS] [--fetched-before MS]",
			"                          [--published-after ISO] [--published-before ISO]",
			"                          [--sort-by fetchedAt|publishedAt|url|domain] [--sort-order asc|desc] [--offset N] [--limit N] [--json]",
			"       web-spider category assign <url> <category> [--json]",
			"       web-spider category remove <url> <category> [--json]",
			"       web-spider category rename <category> <newName> [--json]",
			"       web-spider category list [--json]",
			"       web-spider cache search <query> [--limit N] [--json]",
			"       web-spider session create <name> [--force-chrome-channel] [--json]",
			"       web-spider session list [--json]",
			"       web-spider session close <name> [--json]",
			"       web-spider session act <name> --action navigate --snapshot-version N --url URL [--timeout-ms N] [--json]",
			"       web-spider session act <name> --action click --snapshot-version N --selector CSS [--timeout-ms N] [--json]",
			"       web-spider session act <name> --action hover --snapshot-version N --selector CSS [--timeout-ms N] [--json]",
			"       web-spider session act <name> --action pressKey --snapshot-version N --key STR [--selector CSS] [--timeout-ms N] [--json]",
			"       web-spider session act <name> --action type --snapshot-version N --selector CSS --text STR [--no-clear] [--timeout-ms N] [--json]",
			"       web-spider session act <name> --action select --snapshot-version N --selector CSS (--value STR | --label STR) [--timeout-ms N] [--json]",
			"       web-spider session act <name> --action waitFor --snapshot-version N (--selector CSS | --text STR | --load-state STATE) [--state STATE] [--timeout-ms N] [--json]",
			"       web-spider session act <name> --action queryText --snapshot-version N --selector CSS [--timeout-ms N] [--json]",
			"       web-spider session act <name> --action readTable --snapshot-version N --selector CSS [--timeout-ms N] [--json]",
			"       web-spider session act <name> --action snapshot --snapshot-version N [--selector CSS] [--depth N] [--boxes] [--mode ai|default] [--timeout-ms N] [--json]",
			"       web-spider session act <name> --action handleDialog --snapshot-version N (--accept | --dismiss) [--prompt-text STR] [--json]",
			"       web-spider session act <name> --action downloads --snapshot-version N [--json]",
			"       web-spider session act <name> --action consoleMessages --snapshot-version N [--json]",
			"       web-spider session act <name> --action networkRequests --snapshot-version N [--include-static] [--json]",
			"       web-spider session act <name> --action tabs --snapshot-version N --tab-operation list|new|close|select [--tab-index N] [--url URL] [--json]",
			"       web-spider session act <name> --action eval --snapshot-version N [--script-file PATH] [--json]",
			"                          (reads the script from stdin if --script-file is omitted — never a plain flag)",
			"       web-spider session act <name> --action screenshot --snapshot-version N [--full-page | --selector CSS] [--scale css|device] [--json]",
		].join("\n"),
	);
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
		if (arg === "--json" || booleanFlags.includes(arg)) {
			flags.add(arg.replace(/^--/, ""));
			continue;
		}
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
	const parsed = parseArgs(
		rest,
		[
			"--format",
			"--depth",
			"--max-pages",
			"--root-selector",
			"--exclude-selectors",
			"--token-budget",
			"--pdf-page-start",
			"--pdf-page-end",
			"--timeout-ms",
			"--query",
			"--path",
			"--top-n",
			"--crawl-urls",
			"--max-total-chars",
			"--deadline-ms",
			"--sources",
			"--exclude-domains",
			"--include-domains",
			"--max-cache-age-ms",
		],
		["--enhanced", "--no-same-domain", "--ignore-robots", "--discover-only"],
	);
	const url = parsed?.positional[0];
	if (!parsed || !url) return usage(deps.stderr);

	const depth = parseIntFlag(parsed.values, "depth");
	if (Number.isNaN(depth)) return usage(deps.stderr);
	const maxPages = parseIntFlag(parsed.values, "max-pages");
	if (Number.isNaN(maxPages)) return usage(deps.stderr);
	const tokenBudget = parseIntFlag(parsed.values, "token-budget");
	if (Number.isNaN(tokenBudget)) return usage(deps.stderr);
	const pdfPageStart = parseIntFlag(parsed.values, "pdf-page-start");
	if (Number.isNaN(pdfPageStart)) return usage(deps.stderr);
	const pdfPageEnd = parseIntFlag(parsed.values, "pdf-page-end");
	if (Number.isNaN(pdfPageEnd)) return usage(deps.stderr);
	const timeoutMs = parseIntFlag(parsed.values, "timeout-ms");
	if (Number.isNaN(timeoutMs)) return usage(deps.stderr);
	const topN = parseIntFlag(parsed.values, "top-n");
	if (Number.isNaN(topN)) return usage(deps.stderr);
	const maxTotalChars = parseIntFlag(parsed.values, "max-total-chars");
	if (Number.isNaN(maxTotalChars)) return usage(deps.stderr);
	const deadlineMs = parseIntFlag(parsed.values, "deadline-ms");
	if (Number.isNaN(deadlineMs)) return usage(deps.stderr);
	const maxCacheAgeMs = parseIntFlag(parsed.values, "max-cache-age-ms");
	if (Number.isNaN(maxCacheAgeMs)) return usage(deps.stderr);
	const crawlUrls = parsed.values["crawl-urls"]
		?.split(",")
		.map((u) => u.trim())
		.filter(Boolean);
	const sources = parsed.values.sources
		?.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const excludeDomains = parsed.values["exclude-domains"]
		?.split(",")
		.map((d) => d.trim())
		.filter(Boolean);
	const includeDomains = parsed.values["include-domains"]
		?.split(",")
		.map((d) => d.trim())
		.filter(Boolean);

	try {
		const shared = {
			url,
			format: parsed.values.format as never,
			rootSelector: parsed.values["root-selector"],
			excludeSelectors: parsed.values["exclude-selectors"],
			tokenBudget,
			pdfPageStart,
			pdfPageEnd,
			enhanced: parsed.flags.has("enhanced") || undefined,
			timeoutMs,
			query: parsed.values.query,
			ignoreRobots: parsed.flags.has("ignore-robots") || undefined,
			sources: sources && sources.length > 0 ? sources : undefined,
			maxCacheAgeMs,
		};
		const result =
			(depth ?? 0) > 0 || (crawlUrls && crawlUrls.length > 0)
				? await deps.client.call("crawl", {
						...shared,
						depth,
						maxPages,
						sameDomain: parsed.flags.has("no-same-domain") ? false : undefined,
						discoverOnly: parsed.flags.has("discover-only") || undefined,
						crawlUrls: crawlUrls && crawlUrls.length > 0 ? crawlUrls : undefined,
						maxTotalChars,
						deadlineMs,
						excludeDomains: excludeDomains && excludeDomains.length > 0 ? excludeDomains : undefined,
						includeDomains: includeDomains && includeDomains.length > 0 ? includeDomains : undefined,
					})
				: await deps.client.call("fetch", { ...shared, path: parsed.values.path, topN });
		deps.stdout(parsed.flags.has("json") ? JSON.stringify(result) : formatFetchResult(result));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

async function runSearch(rest: string[], deps: CliDependencies): Promise<number> {
	const parsed = parseArgs(rest, ["--num-results", "--time-range", "--topic", "--engine", "--site-filter"], ["--full-content"]);
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
			siteFilter: parsed.values["site-filter"],
			wantFullContent: parsed.flags.has("full-content") ? true : undefined,
		});
		deps.stdout(parsed.flags.has("json") ? JSON.stringify(result) : formatSearchResult(result));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

async function runQuotes(rest: string[], deps: CliDependencies): Promise<number> {
	const parsed = parseArgs(
		rest,
		["--urls", "--max-quotes-per-url", "--max-quotes-total", "--timeout-ms", "--sources", "--max-cache-age-ms"],
		["--enhanced", "--ignore-robots"],
	);
	const query = parsed?.positional[0];
	if (!parsed || !query) return usage(deps.stderr);
	const urls =
		parsed.values.urls
			?.split(",")
			.map((u) => u.trim())
			.filter(Boolean) ?? [];
	if (urls.length === 0) return usage(deps.stderr);
	const maxQuotesPerUrl = parseIntFlag(parsed.values, "max-quotes-per-url");
	if (Number.isNaN(maxQuotesPerUrl)) return usage(deps.stderr);
	const maxQuotesTotal = parseIntFlag(parsed.values, "max-quotes-total");
	if (Number.isNaN(maxQuotesTotal)) return usage(deps.stderr);
	const timeoutMs = parseIntFlag(parsed.values, "timeout-ms");
	if (Number.isNaN(timeoutMs)) return usage(deps.stderr);
	const quotesMaxCacheAgeMs = parseIntFlag(parsed.values, "max-cache-age-ms");
	if (Number.isNaN(quotesMaxCacheAgeMs)) return usage(deps.stderr);
	const quotesSources = parsed.values.sources
		?.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	try {
		const result = await deps.client.call("quotes", {
			query,
			urls,
			maxQuotesPerUrl,
			maxQuotesTotal,
			timeoutMs,
			enhanced: parsed.flags.has("enhanced") || undefined,
			ignoreRobots: parsed.flags.has("ignore-robots") || undefined,
			sources: quotesSources && quotesSources.length > 0 ? quotesSources : undefined,
			maxCacheAgeMs: quotesMaxCacheAgeMs,
		});
		deps.stdout(parsed.flags.has("json") ? JSON.stringify(result) : formatQuotesResult(result));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

async function runUsage(rest: string[], deps: CliDependencies): Promise<number> {
	const parsed = parseArgs(rest, ["--engine", "--limit"], []);
	if (!parsed) return usage(deps.stderr);
	const limit = parseIntFlag(parsed.values, "limit");
	if (Number.isNaN(limit)) return usage(deps.stderr);

	try {
		const result = await deps.client.call("search.usage", { engine: parsed.values.engine, limit });
		deps.stdout(parsed.flags.has("json") ? JSON.stringify(result) : formatSearchUsageResult(result));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

/**
 * Local filesystem operations only -- never routed through the daemon's RPC,
 * matching `login`-style CLI flows elsewhere: a stored key is re-read fresh
 * by resolveSearchEnv() on the daemon's own next startup, no live push needed.
 */
async function runSearchKeySet(rest: string[], deps: CliDependencies): Promise<number> {
	const [engine] = rest;
	const known = listRegisteredSearchEngines();
	if (!engine) {
		deps.stderr(`usage: web-spider search-key set <engine> (known: ${known.sort().join(", ")})`);
		return 1;
	}
	if (!known.includes(engine)) {
		deps.stderr(`unknown search engine: "${engine}" (known: ${known.sort().join(", ")})`);
		return 1;
	}
	// WEB_SPIDER_SEARCH_KEY_VALUE remains for non-interactive/scripted use (a provisioning
	// script, `pass show brave | web-spider search-key set brave`) -- never accepted as a
	// plain CLI flag value, which would land in shell history the way this would not.
	const value = process.env.WEB_SPIDER_SEARCH_KEY_VALUE ?? (await promptMaskedSecret(`Paste the "${engine}" API key (input hidden): `));
	if (!value) {
		deps.stderr("no API key value provided — paste one at the prompt, or set WEB_SPIDER_SEARCH_KEY_VALUE for non-interactive use");
		return 1;
	}
	const dir = resolveSearchKeysDir(resolveWebSpiderPaths());
	createSearchKeyStore(dir, engine).save(value);
	deps.stdout(`Search key saved for "${engine}". Takes effect on the daemon's next restart.`);
	return 0;
}

/**
 * Stacks one more key alongside whatever is already stored for this engine
 * (BYOK key stacking) -- distinct from `set`, which replaces the whole
 * stored list with exactly this one key. Same local-filesystem-only scope
 * as `set`/`list`/`remove`: takes effect on the daemon's next restart.
 */
async function runSearchKeyAdd(rest: string[], deps: CliDependencies): Promise<number> {
	const [engine] = rest;
	const known = listRegisteredSearchEngines();
	if (!engine) {
		deps.stderr(`usage: web-spider search-key add <engine> (known: ${known.sort().join(", ")})`);
		return 1;
	}
	if (!known.includes(engine)) {
		deps.stderr(`unknown search engine: "${engine}" (known: ${known.sort().join(", ")})`);
		return 1;
	}
	const value =
		process.env.WEB_SPIDER_SEARCH_KEY_VALUE ?? (await promptMaskedSecret(`Paste an additional "${engine}" API key (input hidden): `));
	if (!value) {
		deps.stderr("no API key value provided — paste one at the prompt, or set WEB_SPIDER_SEARCH_KEY_VALUE for non-interactive use");
		return 1;
	}
	const dir = resolveSearchKeysDir(resolveWebSpiderPaths());
	const store = createSearchKeyStore(dir, engine);
	store.add(value);
	deps.stdout(`Search key added for "${engine}" (${store.loadAll().length} key(s) now stored). Takes effect on the daemon's next restart.`);
	return 0;
}

/**
 * Live-tests every locally stored key for one provider through the daemon
 * (network egress belongs to the daemon, never the CLI process itself) --
 * see search.testKeys. Reports each key's status by its stored position,
 * never the raw key.
 */
async function runSearchKeyTest(rest: string[], deps: CliDependencies): Promise<number> {
	const parsed = parseArgs(rest, [], []);
	if (!parsed) return usage(deps.stderr);
	const [engine] = parsed.positional;
	if (!engine) {
		deps.stderr("usage: web-spider search-key test <engine>");
		return 1;
	}
	try {
		const result = await deps.client.call("search.testKeys", { engine });
		deps.stdout(parsed.flags.has("json") ? JSON.stringify(result) : formatSearchTestKeysResult(result));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

async function runSearchKeyList(_rest: string[], deps: CliDependencies): Promise<number> {
	const dir = resolveSearchKeysDir(resolveWebSpiderPaths());
	const names = existsSync(dir)
		? readdirSync(dir)
				.filter((file) => file.endsWith(".json"))
				.map((file) => file.slice(0, -".json".length))
				.sort()
		: [];
	deps.stdout(JSON.stringify(names));
	return 0;
}

async function runSearchKeyRemove(rest: string[], deps: CliDependencies): Promise<number> {
	const [engine] = rest;
	if (!engine) {
		deps.stderr("usage: web-spider search-key remove <engine>");
		return 1;
	}
	const dir = resolveSearchKeysDir(resolveWebSpiderPaths());
	const store = createSearchKeyStore(dir, engine);
	if (store.load() === undefined) {
		deps.stderr(`no search key stored for "${engine}"`);
		return 1;
	}
	store.remove();
	deps.stdout(`Removed search key for "${engine}".`);
	return 0;
}

function runEnigma(rest: string[], deps: CliDependencies): number {
	const [action, ...extra] = rest;
	if (extra.length > 0 || !["enable", "disable", "status"].includes(action ?? "")) return usage(deps.stderr);
	const path = resolveEnigmaConfigPath(resolveWebSpiderPaths());
	if (action === "status") {
		deps.stdout(loadEnigmaConfig(path).useEnigma ? "enabled" : "disabled");
		return 0;
	}
	const enabled = action === "enable";
	saveEnigmaConfig(path, { useEnigma: enabled });
	deps.stdout(`Enigma integration ${enabled ? "enabled" : "disabled"}. Takes effect on the daemon's next restart.`);
	return 0;
}

async function runCacheList(rest: string[], deps: CliDependencies): Promise<number> {
	const parsed = parseArgs(
		rest,
		[
			"--grep",
			"--domain",
			"--tag",
			"--category",
			"--fetched-after",
			"--fetched-before",
			"--published-after",
			"--published-before",
			"--sort-by",
			"--sort-order",
			"--offset",
			"--limit",
		],
		[],
	);
	if (!parsed) return usage(deps.stderr);
	const offset = parseIntFlag(parsed.values, "offset");
	if (Number.isNaN(offset)) return usage(deps.stderr);
	const limit = parseIntFlag(parsed.values, "limit");
	if (Number.isNaN(limit)) return usage(deps.stderr);
	const fetchedAfter = parseIntFlag(parsed.values, "fetched-after");
	if (Number.isNaN(fetchedAfter)) return usage(deps.stderr);
	const fetchedBefore = parseIntFlag(parsed.values, "fetched-before");
	if (Number.isNaN(fetchedBefore)) return usage(deps.stderr);

	try {
		const result = await deps.client.call("cache.list", {
			grep: parsed.values.grep,
			domain: parsed.values.domain,
			tag: parsed.values.tag,
			category: parsed.values.category,
			fetchedAfter,
			fetchedBefore,
			publishedAfter: parsed.values["published-after"],
			publishedBefore: parsed.values["published-before"],
			sortBy: parsed.values["sort-by"] as CachedPageListFilter["sortBy"],
			sortOrder: parsed.values["sort-order"] as CachedPageListFilter["sortOrder"],
			offset,
			limit,
		});
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

async function runCategoryAssign(rest: string[], deps: CliDependencies): Promise<number> {
	const parsed = parseArgs(rest, [], []);
	const [url, category] = parsed?.positional ?? [];
	if (!parsed || !url || !category) return usage(deps.stderr);
	try {
		const result = await deps.client.call("category.assign", { url, category });
		deps.stdout(parsed.flags.has("json") ? JSON.stringify(result) : formatCategoryAssignResult(result));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

async function runCategoryRemove(rest: string[], deps: CliDependencies): Promise<number> {
	const parsed = parseArgs(rest, [], []);
	const [url, category] = parsed?.positional ?? [];
	if (!parsed || !url || !category) return usage(deps.stderr);
	try {
		const result = await deps.client.call("category.remove", { url, category });
		deps.stdout(parsed.flags.has("json") ? JSON.stringify(result) : formatCategoryRemoveResult(result));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

async function runCategoryRename(rest: string[], deps: CliDependencies): Promise<number> {
	const parsed = parseArgs(rest, [], []);
	const [category, newName] = parsed?.positional ?? [];
	if (!parsed || !category || !newName) return usage(deps.stderr);
	try {
		const result = await deps.client.call("category.rename", { category, newName });
		deps.stdout(parsed.flags.has("json") ? JSON.stringify(result) : formatCategoryRenameResult(result));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

async function runCategoryList(rest: string[], deps: CliDependencies): Promise<number> {
	const parsed = parseArgs(rest, [], []);
	if (!parsed) return usage(deps.stderr);
	try {
		const result = await deps.client.call("category.list", {});
		deps.stdout(parsed.flags.has("json") ? JSON.stringify(result) : formatCategoryListResult(result));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

async function runDaemonDiagnose(rest: string[], deps: CliDependencies): Promise<number> {
	const parsed = parseArgs(rest, ["--history-limit"], []);
	if (!parsed) return usage(deps.stderr);
	const historyLimit = parseIntFlag(parsed.values, "history-limit");
	if (Number.isNaN(historyLimit)) return usage(deps.stderr);
	try {
		const result = await deps.client.call("daemon.diagnose", { historyLimit });
		deps.stdout(parsed.flags.has("json") ? JSON.stringify(result) : formatDaemonDiagnoseResult(result));
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
		const result = await deps.client.call("session.create", {
			name,
			forceChromeChannel: parsed.flags.has("force-chrome-channel") || undefined,
		});
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
	const parsed = parseArgs(
		rest,
		[
			"--action",
			"--snapshot-version",
			"--url",
			"--selector",
			"--script-file",
			"--timeout-ms",
			"--text",
			"--value",
			"--label",
			"--load-state",
			"--state",
			"--scale",
			"--depth",
			"--mode",
			"--prompt-text",
			"--key",
			"--tab-operation",
			"--tab-index",
		],
		["--no-clear", "--full-page", "--boxes", "--accept", "--dismiss", "--include-static"],
	);
	const name = parsed?.positional[0];
	if (!parsed || !name) return usage(deps.stderr);
	const action = parsed.values.action;
	if (!isSessionAction(action)) return usage(deps.stderr);
	if (action === "handleDialog" && parsed.flags.has("accept") && parsed.flags.has("dismiss")) return usage(deps.stderr);
	const snapshotVersion = parseIntFlag(parsed.values, "snapshot-version");
	if (snapshotVersion === undefined || Number.isNaN(snapshotVersion)) return usage(deps.stderr);
	const timeoutMs = parseIntFlag(parsed.values, "timeout-ms");
	if (Number.isNaN(timeoutMs)) return usage(deps.stderr);
	const depth = parseIntFlag(parsed.values, "depth");
	if (Number.isNaN(depth)) return usage(deps.stderr);
	const tabIndex = parseIntFlag(parsed.values, "tab-index");
	if (Number.isNaN(tabIndex)) return usage(deps.stderr);

	try {
		const script = action === "eval" ? deps.readEvalScript(parsed.values["script-file"]) : undefined;
		const result = await deps.client.call("session.act", {
			name,
			action,
			snapshotVersion,
			timeoutMs,
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
			key: parsed.values.key,
			includeStatic: parsed.flags.has("include-static") ? true : undefined,
			tabOperation: parsed.values["tab-operation"] as "list" | "new" | "close" | "select" | undefined,
			tabIndex,
		});
		deps.stdout(parsed.flags.has("json") ? JSON.stringify(result) : formatSessionActResult(result));
		return 0;
	} catch (error) {
		deps.stderr(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

async function runSearchKeyCommand(rest: string[], deps: CliDependencies): Promise<number> {
	const [subcommand, ...searchKeyRest] = rest;
	switch (subcommand) {
		case "set":
			return runSearchKeySet(searchKeyRest, deps);
		case "add":
			return runSearchKeyAdd(searchKeyRest, deps);
		case "list":
			return runSearchKeyList(searchKeyRest, deps);
		case "remove":
			return runSearchKeyRemove(searchKeyRest, deps);
		case "test":
			return runSearchKeyTest(searchKeyRest, deps);
		default:
			return usage(deps.stderr);
	}
}

async function runCacheCommand(rest: string[], deps: CliDependencies): Promise<number> {
	const [subcommand, ...cacheRest] = rest;
	switch (subcommand) {
		case "list":
			return runCacheList(cacheRest, deps);
		case "search":
			return runCacheSearch(cacheRest, deps);
		default:
			return usage(deps.stderr);
	}
}

async function runCategoryCommand(rest: string[], deps: CliDependencies): Promise<number> {
	const [subcommand, ...categoryRest] = rest;
	switch (subcommand) {
		case "assign":
			return runCategoryAssign(categoryRest, deps);
		case "remove":
			return runCategoryRemove(categoryRest, deps);
		case "rename":
			return runCategoryRename(categoryRest, deps);
		case "list":
			return runCategoryList(categoryRest, deps);
		default:
			return usage(deps.stderr);
	}
}

async function runDaemonCommand(rest: string[], deps: CliDependencies): Promise<number> {
	const [subcommand, ...daemonRest] = rest;
	switch (subcommand) {
		case "diagnose":
			return runDaemonDiagnose(daemonRest, deps);
		default:
			return usage(deps.stderr);
	}
}

async function runSessionCommand(rest: string[], deps: CliDependencies): Promise<number> {
	const [subcommand, ...sessionRest] = rest;
	switch (subcommand) {
		case "create":
			return runSessionCreate(sessionRest, deps);
		case "list":
			return runSessionList(sessionRest, deps);
		case "close":
			return runSessionClose(sessionRest, deps);
		case "act":
			return runSessionAct(sessionRest, deps);
		default:
			return usage(deps.stderr);
	}
}

async function runServiceCommand(rest: string[], deps: CliDependencies): Promise<number> {
	const action = rest[0];
	switch (action) {
		case "install": {
			const restoreLegacy = deps.legacyService.stopForCutover();
			let armadaHealthy = false;
			try {
				const result = deps.service.install();
				if (!result.installed) throw new Error(`failed to install the Web Spider service: ${result.reason}`);
				// Armada reconcile returns only after bounded handle readiness succeeds. The old
				// descriptor is removed strictly after that point; a failed cutover restores it.
				armadaHealthy = true;
				deps.legacyService.remove();
				return 0;
			} catch (error) {
				if (!armadaHealthy && restoreLegacy) deps.legacyService.restore();
				throw error;
			}
		}
		case "start":
		case "stop":
		case "restart":
		case "status":
			deps.service.action(action satisfies ServiceAction);
			return 0;
		default:
			return usage(deps.stderr);
	}
}

export async function runCli(args: string[], deps: CliDependencies = DEFAULT_DEPENDENCIES): Promise<number> {
	const [command, ...rest] = args;
	switch (command) {
		case "serve":
			await deps.serve();
			return 0;
		case "fetch":
			return runFetch(rest, deps);
		case "quotes":
			return runQuotes(rest, deps);
		case "search":
			return runSearch(rest, deps);
		case "usage":
			return runUsage(rest, deps);
		case "enigma":
			return runEnigma(rest, deps);
		case "search-key":
			return runSearchKeyCommand(rest, deps);
		case "cache":
			return runCacheCommand(rest, deps);
		case "category":
			return runCategoryCommand(rest, deps);
		case "daemon":
			return runDaemonCommand(rest, deps);
		case "session":
			return runSessionCommand(rest, deps);
		case "service":
			return runServiceCommand(rest, deps);
		default:
			return usage(deps.stderr);
	}
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
	process.exitCode = await runCli(args);
}

if (import.meta.main) await main();
