import type { AnswerResult, EngineUsage, IAnswerSearchEngine, ISearchEngine, SearchQuery, SiteAvailabilityTracker } from "../ports.js";
import { FallbackSearchEngine } from "./composites/fallback.js";
import {
	CapabilityRoutedSearchEngine,
	createDefaultKeyCooldownPolicy,
	type EngineFailureReason,
	type KeyCooldownPolicy,
	type NamedSearchEngine,
	RotatingKeySearchEngine,
	SiteRoutedSearchEngine,
} from "./composites/index.js";
import { RoundRobinSearchEngine } from "./composites/round-robin.js";
import {
	BraveSearchEngine,
	ExaSearchEngine,
	FirecrawlKeylessSearchEngine,
	SerpApiSearchEngine,
	SerperSearchEngine,
	TavilySearchEngine,
	YouComSearchEngine,
} from "./providers/index.js";
import { resolveSearchEngine } from "./registry.js";

// ---------------------------------------------------------------------------
// Wiring — compose engines from environment variables
// ---------------------------------------------------------------------------

export interface DefaultSearchEngineOptions {
	/** Reads provider API keys from here. Defaults to process.env. */
	env?: Record<string, string | undefined>;
	/** Applied to keyed engines and the keyless fallback's circuit breaker. See FallbackSearchEngineOptions.cooldownMs. */
	cooldownMs?: number;
	/** Applied to keyed engines and the keyless fallback's circuit breaker. See FallbackSearchEngineOptions.quotaCooldownMs. */
	quotaCooldownMs?: number;
	/** Reports every engine failure by its real name, including the last-resort "firecrawl" Strategy. */
	onEngineFailure?: (engineName: string, error: unknown, reason: EngineFailureReason) => void;
	/** Reports every successful call's own usage/cost data by real engine name, when the engine reported any. Never called for a call that failed or reported nothing. */
	onUsage?: (engineName: string, usage: EngineUsage) => void;
	/** Tracks per-site engine coverage for site-filtered queries. Defaults to a fresh InMemorySiteAvailabilityTracker (process-lifetime only); inject a persistent implementation for cross-restart memory. See {@link SiteRoutedSearchEngine}. */
	siteAvailabilityTracker?: SiteAvailabilityTracker;
	/** Last-resort keyless Strategy. Defaults to Firecrawl; injectable for deterministic tests. */
	keylessEngine?: ISearchEngine;
	/**
	 * BYOK key stacking: extra API keys per provider, beyond the single one (if
	 * any) already present in `env`. When a provider has one or more of these,
	 * its engine becomes a {@link RotatingKeySearchEngine} cycling through
	 * `env`'s key (if present) followed by these, instead of a single-key
	 * engine -- a rate-limited or invalid key only cools that one key down, not
	 * the whole provider; falling back to a *different* provider only happens
	 * once every key for this one is exhausted. Keyed by the same provider
	 * names as {@link SearchEngine} ("brave", "tavily", ...). Absent or empty
	 * for a provider preserves the exact single-key behavior unchanged.
	 */
	additionalKeys?: Partial<Record<string, string[]>>;
	/** Cooldown durations for a rotated key's own rate-limited/invalid failures. Defaults to createDefaultKeyCooldownPolicy() (60s / 300s). Only consulted for a provider that actually has additionalKeys configured. */
	keyCooldownPolicy?: KeyCooldownPolicy;
}

/** Engines whose adapter maps {@link SearchQuery.wantFullContent} to a real vendor param (Tavily's include_raw_content, Exa's contents.text). Declared once here, not learned -- content support is a fixed vendor capability. */
const CONTENT_CAPABLE_ENGINES = new Set(["tavily", "exa"]);

/** No keyed answer-capable provider exists. Plain result search can still use the keyless fallback. */
const NO_ENGINE_CONFIGURED_ERROR =
	"No search engine API key configured. Set one of BRAVE_SEARCH_API_KEY, " +
	"TAVILY_API_KEY, EXA_API_KEY, SERPER_API_KEY, SERPAPI_API_KEY, or YOU_API_KEY.";

/**
 * Every engine configured from environment keys, by real name, in a fixed
 * declaration order (brave/tavily/exa/serper/serpapi/you) -- the single
 * source of which adapters exist, shared by every capability resolver
 * ({@link defaultSearchEngine}, {@link defaultAnswerEngine}) so they never
 * drift out of sync with each other.
 *
 * A provider with one or more `additionalKeys` entries gets wrapped in
 * {@link RotatingKeySearchEngine} instead of a single-key adapter instance --
 * everything else (declaration order, auto-skip when no key at all is
 * configured) is unchanged. A provider with zero or one total key behaves
 * exactly as before this option existed (single instance, built once, reused
 * across every search() call on the returned engine).
 */
function buildConfiguredEngines(
	env: Record<string, string | undefined>,
	onUsage?: (engineName: string, usage: EngineUsage) => void,
	additionalKeys?: Partial<Record<string, string[]>>,
	keyCooldownPolicy?: KeyCooldownPolicy,
): { engines: ISearchEngine[]; names: string[] } {
	const engines: ISearchEngine[] = [];
	const names: string[] = [];

	function pushProvider(name: string, primaryKey: string | undefined, build: (key: string) => ISearchEngine): void {
		const keys = [primaryKey, ...(additionalKeys?.[name] ?? [])].filter((key): key is string => Boolean(key));
		if (keys.length === 0) return;
		engines.push(
			keys.length > 1 ? new RotatingKeySearchEngine(keys, build, { cooldownPolicy: keyCooldownPolicy }) : build(keys[0] as string),
		);
		names.push(name);
	}

	pushProvider(
		"brave",
		env.BRAVE_SEARCH_API_KEY,
		(key) => new BraveSearchEngine(key, undefined, onUsage ? (usage) => onUsage("brave", usage) : undefined),
	);
	pushProvider(
		"tavily",
		env.TAVILY_API_KEY,
		(key) => new TavilySearchEngine(key, onUsage ? (usage) => onUsage("tavily", usage) : undefined),
	);
	pushProvider("exa", env.EXA_API_KEY, (key) => new ExaSearchEngine(key, onUsage ? (usage) => onUsage("exa", usage) : undefined));
	pushProvider("serper", env.SERPER_API_KEY, (key) => new SerperSearchEngine(key));
	pushProvider("serpapi", env.SERPAPI_API_KEY, (key) => new SerpApiSearchEngine(key));
	pushProvider("you", env.YOU_API_KEY, (key) => new YouComSearchEngine(key));

	return { engines, names };
}

/** True when engine implements {@link IAnswerSearchEngine} -- a structural capability check, not a name check. Whatever adapter satisfies this (today only TavilySearchEngine) is eligible for {@link defaultAnswerEngine}/wantAnswer with zero changes to either. */
function isAnswerCapable(engine: ISearchEngine): engine is ISearchEngine & IAnswerSearchEngine {
	return typeof (engine as Partial<IAnswerSearchEngine>).searchForAnswer === "function";
}

/**
 * Build a search chain from environment variables: every keyed engine
 * (brave/tavily/exa/serper/serpapi/you) that actually has an API key
 * configured is round-robined as an equal-tier peer -- spreading quota
 * consumption across whichever are available instead of always hitting
 * one first. An engine with no key configured is auto-skipped. Firecrawl's
 * officially supported keyless endpoint is the bounded last resort, and is
 * used directly when no provider keys are configured.
 *
 * The whole chain is wrapped in {@link SiteRoutedSearchEngine}: a query
 * with no site filter passes straight through to the round-robin/fallback
 * chain described above, unchanged; a site-filtered query (or one
 * containing a literal `site:domain` operator) is instead routed by which
 * configured engines have actually returned matching results for that
 * site before, so a domain a given engine has no real coverage of (e.g.
 * Reddit, which blocked every crawler but Google-backed ones in 2024) is
 * learned once and skipped on later calls instead of re-paid every time.
 *
 * Keyed site/capability routing is wrapped with the keyless Strategy only at
 * the outer boundary. The outer chain has no cooldown of its own, so one keyed
 * peer never cools down the whole group; each keyed peer and the keyless
 * adapter retain independent circuit-breaker state. If a keyed provider throws
 * and keyless is empty or blocked, the earlier actionable provider error is
 * preserved rather than converted to an empty-success result.
 *
 * The returned engine implements ISearchEngine — swap it for any stub
 * in tests without touching call sites.
 */
export function defaultSearchEngine(opts: DefaultSearchEngineOptions = {}): ISearchEngine {
	const env = opts.env ?? process.env;
	const { engines: rotationEngines, names: rotationNames } = buildConfiguredEngines(
		env,
		opts.onUsage,
		opts.additionalKeys,
		opts.keyCooldownPolicy ?? createDefaultKeyCooldownPolicy(),
	);
	const keyless = new FallbackSearchEngine([opts.keylessEngine ?? new FirecrawlKeylessSearchEngine()], {
		cooldownMs: opts.cooldownMs,
		quotaCooldownMs: opts.quotaCooldownMs,
		onEngineFailure: opts.onEngineFailure ? (_index, error, reason) => opts.onEngineFailure?.("firecrawl", error, reason) : undefined,
	});

	if (rotationEngines.length === 0) return keyless;

	const namedEngines: NamedSearchEngine[] = rotationEngines.map((engine, i) => ({
		name: rotationNames[i] as string,
		engine,
		supportsFullContent: CONTENT_CAPABLE_ENGINES.has(rotationNames[i] as string),
	}));

	let plain: ISearchEngine;
	if (rotationEngines.length > 1) {
		plain = new RoundRobinSearchEngine(rotationEngines, {
			cooldownMs: opts.cooldownMs,
			quotaCooldownMs: opts.quotaCooldownMs,
			onEngineFailure: opts.onEngineFailure
				? (index, error, reason) => opts.onEngineFailure?.(rotationNames[index] ?? `engine-${index}`, error, reason)
				: undefined,
		});
	} else {
		const soleName = rotationNames[0] as string;
		plain = new FallbackSearchEngine(rotationEngines, {
			cooldownMs: opts.cooldownMs,
			quotaCooldownMs: opts.quotaCooldownMs,
			onEngineFailure: opts.onEngineFailure ? (_index, error, reason) => opts.onEngineFailure?.(soleName, error, reason) : undefined,
		});
	}

	const contentAware = new CapabilityRoutedSearchEngine(namedEngines, plain);
	const keyed = new SiteRoutedSearchEngine(namedEngines, contentAware, { tracker: opts.siteAvailabilityTracker });
	return new FallbackSearchEngine([keyed, keyless], {
		cooldownMs: 0,
		quotaCooldownMs: 0,
		preserveEarlierError: true,
	});
}

export interface DefaultAnswerEngineOptions {
	/** Reads provider API keys from here. Defaults to process.env. */
	env?: Record<string, string | undefined>;
	/** Reports every successful call's own usage/cost data by real engine name. See {@link DefaultSearchEngineOptions.onUsage}. */
	onUsage?: (engineName: string, usage: EngineUsage) => void;
}

/**
 * Resolves an {@link IAnswerSearchEngine} from configured provider keys, by
 * capability rather than by name -- a caller never names "Tavily" to get an
 * answer; it declares the want (via {@link import("./index.js").webSearch}'s wantAnswer, or by
 * calling this directly) and whichever configured engine actually
 * implements searchForAnswer is used. Extending an existing ISearchEngine
 * adapter to also implement IAnswerSearchEngine (e.g. a future Serper/
 * SerpApi answerBox mapping) makes it eligible here with zero other
 * changes -- the whole point of routing by capability instead of name.
 *
 * Throws a distinct, more specific error than {@link defaultSearchEngine}'s
 * own when provider keys exist but none of the configured engines can
 * produce an answer -- "you have Brave configured" is a materially
 * different problem to fix than "you have nothing configured at all".
 */
export function defaultAnswerEngine(opts: DefaultAnswerEngineOptions = {}): IAnswerSearchEngine {
	const env = opts.env ?? process.env;
	const { engines, names } = buildConfiguredEngines(env, opts.onUsage);

	const capable = engines
		.map((engine, i) => ({ engine, name: names[i] as string }))
		.filter((entry): entry is { engine: ISearchEngine & IAnswerSearchEngine; name: string } => isAnswerCapable(entry.engine));

	if (capable.length === 0) {
		if (engines.length === 0) throw new Error(NO_ENGINE_CONFIGURED_ERROR);
		throw new Error(
			`Configured search engine(s) (${names.join(", ")}) don't support answer synthesis (wantAnswer). ` +
				"Set TAVILY_API_KEY for a provider that does.",
		);
	}

	if (capable.length === 1) return (capable[0] as { engine: ISearchEngine & IAnswerSearchEngine }).engine;

	return {
		async searchForAnswer(req: SearchQuery): Promise<AnswerResult> {
			let lastError: unknown;
			for (const entry of capable) {
				try {
					return await entry.engine.searchForAnswer(req);
				} catch (err) {
					lastError = err;
				}
			}
			throw lastError;
		},
	};
}

/** Resolves a single named engine and asserts it supports wantAnswer, for webSearch's forced-engine path. Throws a clear, actionable error naming the engine rather than a generic type error when it doesn't. */
export function resolveAnswerEngine(name: string, key: string | undefined): IAnswerSearchEngine {
	const engine = resolveSearchEngine(name, key);
	if (!isAnswerCapable(engine)) {
		throw new Error(`Engine "${name}" does not support wantAnswer (no searchForAnswer implementation). Currently only "tavily" does.`);
	}
	return engine;
}
