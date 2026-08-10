/**
 * Web search application service — daemon-owned so provider API keys are
 * read once from the daemon's own environment and never pass through the
 * client or get logged (design doc §6/trust-boundary note). Wraps
 * @danypops/web-spider's existing defaultSearchEngine()/resolveSearchEngine()
 * adapters rather than re-implementing provider calls.
 */
import {
	defaultSearchEngine,
	type EngineFailureReason,
	type EngineUsage,
	type ISearchEngine,
	isLikelyInvalidKeyError,
	isLikelyRateLimitError,
	type KeyCooldownPolicy,
	RotatingKeySearchEngine,
	resolveSearchEngine,
	type SearchEngine,
	type WebSearchResult,
} from "@danypops/web-spider";
import { SEARCH_DEFAULT_NUM_RESULTS, SEARCH_MAX_NUM_RESULTS_CEILING } from "../constants.ts";

export interface WebSearchInput {
	query: string;
	numResults?: number;
	timeRange?: "day" | "week" | "month" | "year";
	topic?: "news" | "general";
	/** Force a specific engine. Auto-detected from available API keys when omitted. */
	searchEngine?: SearchEngine;
	/** Restrict results to one domain (e.g. "reddit.com"). Routed by SiteRoutedSearchEngine against whichever configured engines have actually returned matching results for that site before -- see @danypops/web-spider's defaultSearchEngine(). */
	siteFilter?: string;
	/** Declares intent -- "give me full page content" -- without naming which engine or option produces it (Tavily/Exa honour it; other engines ignore it, same as an unsupported timeRange). Routed by CapabilityRoutedSearchEngine to a content-capable engine when one is configured. See @danypops/web-spider's SearchQuery.wantFullContent. */
	wantFullContent?: boolean;
}

export interface WebSearchOutput {
	query: string;
	results: WebSearchResult[];
}

export type EngineResolver = (name?: SearchEngine) => ISearchEngine;

/** Maps a forced engine name to the daemon-environment variable carrying its API key. */
const ENGINE_ENV_VARS: Partial<Record<SearchEngine, string>> = {
	brave: "BRAVE_SEARCH_API_KEY",
	"brave-llm": "BRAVE_SEARCH_API_KEY",
	tavily: "TAVILY_API_KEY",
	exa: "EXA_API_KEY",
	serper: "SERPER_API_KEY",
	serpapi: "SERPAPI_API_KEY",
	you: "YOU_API_KEY",
};

export type EngineFailureHandler = (engineName: string, error: unknown, reason: EngineFailureReason) => void;
export type EngineUsageHandler = (engineName: string, usage: EngineUsage) => void;

/**
 * Builds an EngineResolver reading API keys from the given environment (the
 * daemon's own — never the client's). The auto-detect chain (name omitted)
 * is built once and reused, not rebuilt per call — its cooldown state needs
 * to persist across searches to actually skip a rate-limited engine on
 * later calls, not just within the one call that first hit it.
 *
 * onUsage (like onEngineFailure) only ever fires for the auto-detect chain --
 * a caller forcing one engine by name bypasses all composite machinery
 * (fallback, cooldown, usage reporting alike), same existing asymmetry as
 * onEngineFailure already has.
 */
export function createEngineResolver(
	env: Record<string, string | undefined> = process.env,
	onEngineFailure?: EngineFailureHandler,
	onUsage?: EngineUsageHandler,
	keylessEngine?: ISearchEngine,
	/** BYOK key stacking: extra API keys per provider beyond the single one (if any) in `env` -- see {@link RotatingKeySearchEngine}. Forwarded to both the named-engine path (below) and the auto-detect chain (defaultSearchEngine's own additionalKeys option). */
	additionalKeys?: Partial<Record<string, string[]>>,
	keyCooldownPolicy?: KeyCooldownPolicy,
): EngineResolver {
	let cachedDefault: ISearchEngine | undefined;
	return (name) => {
		if (!name) {
			if (!cachedDefault)
				cachedDefault = defaultSearchEngine({ env, onEngineFailure, onUsage, keylessEngine, additionalKeys, keyCooldownPolicy });
			return cachedDefault;
		}
		const envVar = ENGINE_ENV_VARS[name];
		const primary = envVar ? env[envVar] : undefined;
		const keys = [primary, ...(additionalKeys?.[name] ?? [])].filter((key): key is string => Boolean(key));
		if (keys.length > 1) {
			return new RotatingKeySearchEngine(keys, (key) => resolveSearchEngine(name, key), { cooldownPolicy: keyCooldownPolicy });
		}
		return resolveSearchEngine(name, primary);
	};
}

function clampNumResults(requested: number | undefined): number {
	const value = Number.isFinite(requested) ? Math.floor(requested as number) : SEARCH_DEFAULT_NUM_RESULTS;
	return Math.max(1, Math.min(SEARCH_MAX_NUM_RESULTS_CEILING, value));
}

export type KeyTestStatus = "valid" | "rate-limited" | "invalid" | "error";

export interface KeyTestResult {
	/** Position in the given keys array -- never the raw key itself, which must never cross this boundary (a log line, a CLI stdout print, a Vehicle response). */
	index: number;
	status: KeyTestStatus;
}

/**
 * Live-tests each given key for one provider with a single, minimal query
 * (`{ query: "test", numResults: 1 }`), bypassing rotation/cooldown state
 * entirely -- every key is tried regardless of another key's own outcome,
 * since the whole point is reporting each one's real status. Backs
 * `web-spider search-key test <engine>`. Never returns or logs a raw key --
 * only its position in the input array and a classified outcome.
 */
export async function testProviderKeys(engine: SearchEngine, keys: string[]): Promise<KeyTestResult[]> {
	const results: KeyTestResult[] = [];
	for (let index = 0; index < keys.length; index++) {
		try {
			await resolveSearchEngine(engine, keys[index] as string).search({ query: "test", numResults: 1 });
			results.push({ index, status: "valid" });
		} catch (err) {
			if (isLikelyInvalidKeyError(err)) results.push({ index, status: "invalid" });
			else if (isLikelyRateLimitError(err)) results.push({ index, status: "rate-limited" });
			else results.push({ index, status: "error" });
		}
	}
	return results;
}

export class WebSearchService {
	constructor(private readonly resolveEngine: EngineResolver) {}

	async search(input: WebSearchInput): Promise<WebSearchOutput> {
		const query = input.query?.trim();
		if (!query) throw new Error("query is required");
		const engine = this.resolveEngine(input.searchEngine);
		const results = await engine.search({
			query,
			numResults: clampNumResults(input.numResults),
			timeRange: input.timeRange,
			topic: input.topic,
			siteFilter: input.siteFilter,
			wantFullContent: input.wantFullContent,
		});
		return { query, results };
	}
}
