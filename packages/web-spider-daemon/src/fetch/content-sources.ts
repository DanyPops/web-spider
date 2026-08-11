/**
 * Resolves a `sources` daemon input — an array of ContentSourceStrategy
 * names (see @danypops/web-spider's src/sources/registry.ts, and
 * docs/content-source-strategies.md) — into real strategy instances for
 * spider()/crawl()'s own `contentSources` option.
 *
 * Centralized here so FetchService, CrawlService, and QuotesService all
 * clamp the same way and throw the same, actionable error shape for a typo'd
 * name instead of three slightly different copies of this logic.
 */
import type { ContentSourceStrategy } from "@danypops/web-spider";
import { listRegisteredContentSources, resolveContentSources } from "@danypops/web-spider";
import { SOURCES_MAX_COUNT } from "../constants.ts";

/**
 * Returns undefined for an empty/absent list (spider()'s own default),
 * so callers can pass the result straight through as `contentSources`
 * without an extra `?? []` at every call site. Throws a descriptive error
 * naming every currently-registered strategy when a requested name isn't
 * one of them — the same "don't guess, tell the caller what's real" shape
 * resolveContentSources() itself already uses, just with the full list
 * attached for a caller that has no other way to discover it.
 */
export function resolveSourcesOption(names: string[] | undefined): ContentSourceStrategy[] | undefined {
	if (!names || names.length === 0) return undefined;
	const clamped = names.slice(0, SOURCES_MAX_COUNT);
	try {
		return resolveContentSources(clamped);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`${message} Known content sources: ${listRegisteredContentSources().join(", ")}.`);
	}
}
