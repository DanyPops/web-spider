/**
 * SpideredPage / search result → Papyrus Doc mapping — design doc §6. Subtypes are namespaced
 * as "web-spider:<specific>" so this tool's subtype vocabulary can never collide with another
 * external tool's; existing ingested Docs created before this rename keep their bare "web" /
 * "web-search-result" subtype (Papyrus Docs are immutable once created, so they are
 * grandfathered rather than rewritten).
 *
 * Pure functions — no network, no Papyrus dependency here. Ingested Docs are immutable
 * service output: these functions only ever produce a *new* Doc's fields, never an update.
 */
import type { SpideredPage, WebSearchResult } from "@danypops/web-spider";
import type { PapyrusDocInput } from "./ports/papyrus-ingest.ts";

/** Matches scribe-bridge.ts's existing markdown truncation bound, so the two ingestion paths stay visually consistent. */
const BODY_MARKDOWN_MAX_CHARACTERS = 4_000;

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function omitEmptyExtra(extra: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined && v !== ""));
}

function hostnameOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

export function pageToPapyrusDoc(page: SpideredPage): PapyrusDocInput {
	const sections: string[] = [];
	if (page.description) sections.push(page.description);
	if (page.markdown) sections.push(truncate(page.markdown, BODY_MARKDOWN_MAX_CHARACTERS));
	if (page.headings.length > 0) {
		sections.push(page.headings.map((h) => `${"#".repeat(h.level)} ${h.text}`).join("\n"));
	}

	return {
		title: page.title || page.url,
		subtype: "web-spider:web",
		body: sections.join("\n\n"),
		labels: ["source:web-spider", `domain:${page.domain}`, ...page.tags.map((tag) => `tag:${tag}`)],
		extra: omitEmptyExtra({
			url: page.url,
			canonicalUrl: page.canonicalUrl,
			fetchedAt: page.fetchedAt,
			wordCount: page.wordCount,
			readingTimeMinutes: page.readingTimeMinutes,
			lang: page.lang,
			author: page.author,
			publishedAt: page.publishedAt,
		}),
	};
}

export interface SearchResultIngestContext {
	query: string;
	engine?: string;
}

export function searchResultToPapyrusDoc(result: WebSearchResult, context: SearchResultIngestContext): PapyrusDocInput {
	return {
		title: result.title || result.url,
		subtype: "web-spider:web-search-result",
		body: result.snippet,
		labels: ["source:web-spider", `domain:${hostnameOf(result.url)}`],
		extra: omitEmptyExtra({
			url: result.url,
			query: context.query,
			engine: context.engine,
			publishedAt: result.publishedAt,
		}),
	};
}
