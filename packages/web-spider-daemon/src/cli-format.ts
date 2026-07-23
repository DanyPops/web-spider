/**
 * Human-readable CLI formatters — separate from cli.ts's routing (SRP) and
 * separate from the machine-facing --json path per the human-readable-output
 * rule: stable JSON for machines, names/actionable language for humans.
 * These never run for --json invocations; they format whatever operation
 * output shape service.ts's fetch/crawl/search/cache.* handlers returned.
 */
import type { CachedPageListResult, CachedPageSearchResult } from "./domain/page.ts";
import type { SessionInfo } from "./domain/session.ts";
import type { PapyrusIngestOutput } from "./papyrus-ingest-service.ts";
import type { WebSearchOutput } from "./search-service.ts";
import type { SessionActOutput } from "./session-service.ts";

const PREVIEW_MARKDOWN_CHARACTERS = 500;
const PREVIEW_ROW_LIMIT = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Formats the result of `fetch` and `crawl` (depth-routed through the same CLI command). */
export function formatFetchResult(result: unknown): string {
	if (!isRecord(result)) return String(result);

	if (result.blocked === true) {
		return `Blocked by robots.txt — ${String(result.url ?? "")}`;
	}

	if (result.found === false) {
		return `No node at path "${String(result.path ?? "")}"`;
	}

	// Crawl summary (pagesFound is unique to the crawl operation's output).
	if (typeof result.pagesFound === "number") {
		const lines = [`Crawled ${result.pagesFound} page${result.pagesFound === 1 ? "" : "s"}`];
		if (typeof result.errors === "number" && result.errors > 0) lines.push(`${result.errors} error(s)`);
		const pages = Array.isArray(result.pages) ? result.pages : [];
		for (const page of pages.slice(0, PREVIEW_ROW_LIMIT)) {
			if (!isRecord(page)) continue;
			lines.push(`  ${String(page.title ?? page.url ?? "")}  ${String(page.url ?? "")}`);
		}
		if (pages.length > PREVIEW_ROW_LIMIT) lines.push(`  … ${pages.length - PREVIEW_ROW_LIMIT} more`);
		if (typeof result.note === "string") lines.push(result.note);
		return lines.join("\n");
	}

	// Crawl/fetch highlights — hits carry heading/score/text.
	if (Array.isArray(result.hits) && result.hits.every((hit) => isRecord(hit) && "heading" in hit)) {
		if (result.hits.length === 0) return "No matches.";
		return result.hits.map((hit) => {
			const h = hit as Record<string, unknown>;
			return `[${Number(h.score ?? 0).toFixed(2)}] ${String(h.heading ?? "")}\n  ${String(h.text ?? "")}`;
		}).join("\n\n");
	}

	// Tree query hits.
	if (Array.isArray(result.hits) && result.hits.every((hit) => isRecord(hit) && "path" in hit)) {
		if (result.hits.length === 0) return "No matches.";
		return result.hits.map((hit) => {
			const h = hit as Record<string, unknown>;
			return `${String(h.path ?? "")} (${String(h.tag ?? "")}) — ${String(h.snippet ?? "")}`;
		}).join("\n");
	}

	// Tree node (full tree or a navigated path result).
	if (typeof result.tag === "string" && typeof result.path === "string") {
		return `${result.path} <${result.tag}>${result.text ? `\n${String(result.text)}` : ""}`;
	}

	// Links format.
	if (Array.isArray(result.bodyLinks) && result.markdown === undefined) {
		const links = result.bodyLinks as Array<Record<string, unknown>>;
		const header = `${String(result.title ?? result.url ?? "")}`;
		if (links.length === 0) return `${header}\n  (no body links)`;
		return [header, ...links.map((link) => `  ${String(link.text ?? "")}  ${String(link.href ?? "")}`)].join("\n");
	}

	// Markdown fetch.
	if (typeof result.markdown === "string") {
		const header = [
			String(result.title ?? result.url ?? ""),
			typeof result.wordCount === "number" ? `${result.wordCount} words` : undefined,
			typeof result.cache === "string" ? `cache ${result.cache}` : undefined,
			result.truncated ? "truncated" : undefined,
		].filter(Boolean).join(" · ");
		const preview = result.markdown.length > PREVIEW_MARKDOWN_CHARACTERS
			? `${result.markdown.slice(0, PREVIEW_MARKDOWN_CHARACTERS)}…\n[use --json for the full body]`
			: result.markdown;
		return `${header}\n\n${preview}`;
	}

	// Lean fetch (no markdown, has headings).
	if (Array.isArray(result.headings)) {
		const header = [
			String(result.title ?? result.url ?? ""),
			typeof result.wordCount === "number" ? `${result.wordCount} words` : undefined,
		].filter(Boolean).join(" · ");
		return [header, ...(result.headings as string[])].join("\n");
	}

	return JSON.stringify(result);
}

export function formatSearchResult(result: WebSearchOutput): string {
	if (result.results.length === 0) return `No results for "${result.query}".`;
	return [
		`${result.results.length} result(s) for "${result.query}"`,
		...result.results.map((hit) => `  ${hit.title}\n    ${hit.url}\n    ${hit.snippet}`),
	].join("\n");
}

export function formatCacheListResult(result: CachedPageListResult): string {
	if (result.pages.length === 0) return "No cached pages.";
	const suffix = result.filtered !== result.total ? ` (${result.filtered} of ${result.total} match the filter)` : ` (${result.total} total)`;
	return [
		`${result.pages.length} cached page(s)${suffix}`,
		...result.pages.map((page) => `  ${page.title || page.url}  ${page.url}`),
	].join("\n");
}

export function formatPapyrusIngestResult(result: PapyrusIngestOutput): string {
	const lines: string[] = [];
	for (const item of result.ingested) lines.push(`✓ ${item.url} → ${item.docId}`);
	for (const item of result.skipped) lines.push(`✗ ${item.url} — ${item.reason}`);
	if (lines.length === 0) return "Nothing to ingest.";
	return lines.join("\n");
}

export function formatCacheSearchResult(result: CachedPageSearchResult): string {
	if (result.hits.length === 0) return `No matches for "${result.query}" across ${result.pagesSearched} cached page(s).`;
	return [
		`${result.hits.length} hit(s) for "${result.query}" across ${result.pagesSearched} cached page(s)`,
		...result.hits.map((hit) => `  [${hit.score.toFixed(2)}] ${hit.title} · ${hit.heading}\n    ${hit.text}`),
	].join("\n");
}

function formatSessionInfoLine(session: SessionInfo): string {
	return `${session.name}  snapshotVersion=${session.snapshotVersion}  createdAt=${new Date(session.createdAt).toISOString()}`;
}

export function formatSessionCreateResult(session: SessionInfo): string {
	return `Session "${session.name}" created (snapshotVersion=${session.snapshotVersion}).`;
}

export function formatSessionListResult(result: { sessions: SessionInfo[] }): string {
	if (result.sessions.length === 0) return "No active sessions.";
	return [`${result.sessions.length} active session(s)`, ...result.sessions.map((s) => `  ${formatSessionInfoLine(s)}`)].join("\n");
}

export function formatSessionCloseResult(result: { name: string; closed: true }): string {
	return `Session "${result.name}" closed.`;
}

export function formatSessionActResult(result: SessionActOutput): string {
	const header = `${result.action} on "${result.name}" — ok (snapshotVersion=${result.snapshotVersion})`;
	if (result.action === "eval" || result.action === "queryText" || result.action === "readTable" || result.action === "snapshot" || result.action === "downloads" || result.action === "consoleMessages" || result.action === "networkRequests") return `${header}\n  result: ${JSON.stringify(result.result)}`;
	if (result.action === "screenshot") return `${header}\n  screenshot: ${result.screenshotBase64?.length ?? 0} base64 characters (use --json to capture the image data)`;
	return header;
}
