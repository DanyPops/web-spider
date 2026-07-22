/**
 * Single-page fetch application service — ports packages/pi-extension/src/index.ts's
 * buildFetchPage/handleSinglePage logic into the daemon, composed against the
 * SQLite-backed CacheStore instead of an in-process DiskCache/SpiderCache.
 *
 * Domain/application logic depends only on the existing @danypops/web-spider
 * ports (ICache, IThrottle, IRobotsChecker, IHttpClient) — SQLite, the real
 * HTTP client, and Playwright are adapters composed once by the daemon
 * (see service.ts), matching the design doc's ports/adapters table.
 */
import {
	navigateTree,
	queryTree,
	spider,
	searchPages,
	type DOMNode,
	type IHttpClient,
	type IRobotsChecker,
	type IThrottle,
	type SpideredPage,
} from "@danypops/web-spider";
import {
	FETCH_DEFAULT_TIMEOUT_MS,
	FETCH_HIGHLIGHTS_DEFAULT_TOP_N,
	FETCH_HIGHLIGHTS_SNIPPET_RADIUS,
	FETCH_MAX_TOKEN_BUDGET,
	TREE_CACHE_MAX_ENTRIES,
	TREE_QUERY_DEFAULT_TOP_N,
} from "./constants.ts";
import type { Logger } from "@danypops/daemon-kit/logging";
import { highlightHit, leanOutput, linksOutput, markdownOutput } from "./format.ts";
import type { CacheStore } from "./ports/cache-store.ts";

export type FetchFormat = "markdown" | "lean" | "links" | "highlights" | "tree";

export interface FetchOperationInput {
	url: string;
	format?: FetchFormat;
	rootSelector?: string;
	excludeSelectors?: string;
	tokenBudget?: number;
	enhanced?: boolean;
	timeoutMs?: number;
	query?: string;
	path?: string;
	topN?: number;
	/**
	 * Explicit, opt-in bypass of the robots.txt check for this one request.
	 * Never a default -- every use is logged (structured, not silent) since
	 * it's a deliberate policy override, even on the operator's own
	 * infrastructure fetching as themselves for a human-directed request.
	 */
	ignoreRobots?: boolean;
}

export type FetchOperationOutput = Record<string, unknown>;

export interface FetchServiceDeps {
	cache: CacheStore;
	throttle: IThrottle;
	robotsCache: IRobotsChecker;
	/** Lazily constructs (and reuses) the Playwright-backed HTTP client — expensive, one per daemon process. */
	getPlaywrightClient: () => IHttpClient;
	/**
	 * Overrides spider()'s built-in real-fetch() adapter for every (non-enhanced)
	 * request. Production wiring leaves this undefined so spider() uses its own
	 * default; tests inject a fake per packages/web-spider/test/ports.test.ts's
	 * established "swap for tests" pattern — never mock globalThis.fetch.
	 */
	defaultHttpClient?: IHttpClient;
	/** Logs every ignoreRobots use. Optional so existing tests/wiring that don't care about audit logging keep working unchanged. */
	logger?: Logger;
}

const ROBOTS_BLOCKED_PREFIX = "Blocked by robots.txt:";

export class FetchService {
	private readonly treeCache = new Map<string, DOMNode>();

	constructor(private readonly deps: FetchServiceDeps) {}

	async fetch(input: FetchOperationInput): Promise<FetchOperationOutput> {
		if (input.ignoreRobots) {
			this.deps.logger?.warn("robots_txt_ignored", { url: input.url, operation: "fetch" });
		}
		try {
			return await this.dispatch(input);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith(ROBOTS_BLOCKED_PREFIX)) {
				return { blocked: true, url: input.url, reason: "robots.txt" };
			}
			throw error;
		}
	}

	private buildSpiderOpts(input: FetchOperationInput, httpClient?: IHttpClient) {
		return {
			rootSelector: input.rootSelector,
			excludeSelectors: input.excludeSelectors,
			tokenBudget: input.tokenBudget !== undefined ? Math.min(input.tokenBudget, FETCH_MAX_TOKEN_BUDGET) : undefined,
			timeoutMs: input.timeoutMs ?? FETCH_DEFAULT_TIMEOUT_MS,
			throttle: this.deps.throttle,
			robotsCache: input.ignoreRobots ? undefined : this.deps.robotsCache,
			httpClient: httpClient ?? (input.enhanced ? this.deps.getPlaywrightClient() : this.deps.defaultHttpClient),
		};
	}

	/** Cache-eligible fetch/store round-trip — mirrors buildFetchPage()'s cacheEligible rule exactly. */
	private async fetchPage(input: FetchOperationInput): Promise<{ page: SpideredPage; cache: "hit" | "miss" }> {
		const cacheEligible = !input.rootSelector && !input.excludeSelectors && input.tokenBudget === undefined && !input.enhanced;
		if (cacheEligible) {
			const hit = this.deps.cache.get(input.url);
			if (hit) return { page: hit, cache: "hit" };
		}

		let page = await spider(input.url, this.buildSpiderOpts(input));
		if (page.jsRendered && !input.enhanced) {
			page = await spider(input.url, this.buildSpiderOpts(input, this.deps.getPlaywrightClient()));
		}

		if (cacheEligible) this.deps.cache.set(input.url, page);
		return { page, cache: "miss" };
	}

	private async fetchTree(input: FetchOperationInput): Promise<DOMNode> {
		const key = JSON.stringify([input.url, input.rootSelector ?? "", input.excludeSelectors ?? "", input.enhanced ?? false]);
		const hit = this.treeCache.get(key);
		if (hit) return hit;
		const page = await spider(input.url, { ...this.buildSpiderOpts(input), view: "tree" });
		if (this.treeCache.size >= TREE_CACHE_MAX_ENTRIES) {
			const oldest = this.treeCache.keys().next().value;
			if (oldest !== undefined) this.treeCache.delete(oldest);
		}
		this.treeCache.set(key, page.tree);
		return page.tree;
	}

	private async dispatch(input: FetchOperationInput): Promise<FetchOperationOutput> {
		const format = input.format ?? "markdown";

		if (format === "tree") {
			const tree = await this.fetchTree(input);
			if (input.path) {
				const node = navigateTree(tree, input.path);
				if (!node) return { found: false, path: input.path };
				return { ...node };
			}
			if (input.query?.trim()) {
				const hits = queryTree(tree, input.query, { topN: input.topN ?? TREE_QUERY_DEFAULT_TOP_N });
				return {
					url: input.url,
					query: input.query,
					hits: hits.map((hit) => ({
						path: hit.path,
						tag: hit.node.tag,
						score: Math.round(hit.score * 100) / 100,
						snippet: hit.snippet,
						...(hit.node.text !== undefined ? { text: hit.node.text } : {}),
						...(hit.node.children ? { childCount: hit.node.children.length } : {}),
					})),
				};
			}
			return { ...tree };
		}

		if (format === "highlights" && !input.query?.trim()) throw new Error("highlights format requires a query");

		const fetched = await this.fetchPage(input);
		const page = fetched.page;

		if (format === "lean") return { ...leanOutput(page), cache: fetched.cache };
		// Note: no top-level "links" count here — that is renderer-only metadata the
		// historical tool computed for its details channel, never part of the content.
		if (format === "links") return { ...linksOutput(page), cache: fetched.cache };
		if (format === "highlights") {
			const hits = searchPages([page], input.query ?? "", { topN: FETCH_HIGHLIGHTS_DEFAULT_TOP_N, snippetRadius: FETCH_HIGHLIGHTS_SNIPPET_RADIUS });
			return {
				url: page.url,
				title: page.title,
				query: input.query,
				cache: fetched.cache,
				hits: hits.map((hit) => highlightHit(hit, page.chunks)),
			};
		}

		// markdown (default)
		const deliveredWordCount = page.chunks.reduce((total, chunk) => total + chunk.wordCount, 0);
		const truncated = page.chunks.length > 0 && deliveredWordCount < page.wordCount;
		return { ...markdownOutput(page), cache: fetched.cache, ...(truncated ? { truncated: true } : {}) };
	}
}
