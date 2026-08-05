/** Barrel of every ISearchEngine composite/meta-strategy (selection, fallback, and routing logic that wraps other engines rather than calling a provider directly). */
export { CapabilityRoutedSearchEngine } from "./capability-routed.js";
export { type EngineFailureReason, isLikelyQuotaExceededError, isLikelyRateLimitError, type RateLimitPredicate } from "./errors.js";
export { FallbackSearchEngine, type FallbackSearchEngineOptions } from "./fallback.js";
export { RoundRobinSearchEngine, type RoundRobinSearchEngineOptions } from "./round-robin.js";
export {
	extractSiteFromQuery,
	hostMatchesSite,
	InMemorySiteAvailabilityTracker,
	type InMemorySiteAvailabilityTrackerOptions,
	type NamedSearchEngine,
	SiteRoutedSearchEngine,
	type SiteRoutedSearchEngineOptions,
} from "./site-routed.js";
