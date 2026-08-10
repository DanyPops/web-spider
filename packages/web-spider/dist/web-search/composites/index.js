/** Barrel of every ISearchEngine composite/meta-strategy (selection, fallback, and routing logic that wraps other engines rather than calling a provider directly). */
export { CapabilityRoutedSearchEngine } from "./capability-routed.js";
export { isLikelyQuotaExceededError, isLikelyRateLimitError } from "./errors.js";
export { FallbackSearchEngine } from "./fallback.js";
export { createDefaultKeyCooldownPolicy, isLikelyInvalidKeyError, RotatingKeySearchEngine, } from "./key-rotation.js";
export { RoundRobinSearchEngine } from "./round-robin.js";
export { extractSiteFromQuery, hostMatchesSite, InMemorySiteAvailabilityTracker, SiteRoutedSearchEngine, } from "./site-routed.js";
//# sourceMappingURL=index.js.map