/**
 * Human-readable CLI formatters — separate from cli.ts's routing (SRP) and
 * separate from the machine-facing --json path per the human-readable-output
 * rule: stable JSON for machines, names/actionable language for humans.
 * These never run for --json invocations; they format whatever operation
 * output shape service.ts's fetch/crawl/search/cache.* handlers returned.
 */
import type {
	CachedPageListResult,
	CachedPageSearchResult,
	CategoryAssignmentResult,
	CategoryListResult,
	CategoryRenameResult,
} from "./cache/page.ts";
import type { WebSearchOutput } from "./search/search-service.ts";
import type { SearchEngineUsageEntry } from "./search/search-usage.ts";
import type { OperationOutputs } from "./service.ts";
import type { SessionInfo } from "./session/session.ts";
import type { SessionActOutput } from "./session/session-service.ts";

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
		if (typeof result.nextAction === "string" && result.nextAction !== "complete") lines.push(`Stopped early: ${result.nextAction}`);
		const pages = Array.isArray(result.pages) ? result.pages : [];
		for (const page of pages.slice(0, PREVIEW_ROW_LIMIT)) {
			if (!isRecord(page)) continue;
			const type = typeof page.pageType === "string" ? ` [${page.pageType}]` : "";
			lines.push(`  ${String(page.title ?? page.url ?? "")}${type}  ${String(page.url ?? "")}`);
		}
		if (pages.length > PREVIEW_ROW_LIMIT) lines.push(`  … ${pages.length - PREVIEW_ROW_LIMIT} more`);
		if (typeof result.note === "string") lines.push(result.note);
		return lines.join("\n");
	}

	// Crawl/fetch highlights — hits carry heading/score/text.
	if (Array.isArray(result.hits) && result.hits.every((hit) => isRecord(hit) && "heading" in hit)) {
		if (result.hits.length === 0) return "No matches.";
		return result.hits
			.map((hit) => {
				const h = hit as Record<string, unknown>;
				return `[${Number(h.score ?? 0).toFixed(2)}] ${String(h.heading ?? "")}\n  ${String(h.text ?? "")}`;
			})
			.join("\n\n");
	}

	// Tree query hits.
	if (Array.isArray(result.hits) && result.hits.every((hit) => isRecord(hit) && "path" in hit)) {
		if (result.hits.length === 0) return "No matches.";
		return result.hits
			.map((hit) => {
				const h = hit as Record<string, unknown>;
				return `${String(h.path ?? "")} (${String(h.tag ?? "")}) — ${String(h.snippet ?? "")}`;
			})
			.join("\n");
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
		]
			.filter(Boolean)
			.join(" · ");
		const preview =
			result.markdown.length > PREVIEW_MARKDOWN_CHARACTERS
				? `${result.markdown.slice(0, PREVIEW_MARKDOWN_CHARACTERS)}…\n[use --json for the full body]`
				: result.markdown;
		return `${header}\n\n${preview}`;
	}

	// Lean fetch (no markdown, has headings).
	if (Array.isArray(result.headings)) {
		const header = [
			String(result.title ?? result.url ?? ""),
			typeof result.wordCount === "number" ? `${result.wordCount} words` : undefined,
		]
			.filter(Boolean)
			.join(" · ");
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

function formatUsageEntryLine(entry: SearchEngineUsageEntry): string {
	const parts = [`observedAt=${new Date(entry.observedAt).toISOString()}`];
	if (entry.credits !== undefined) parts.push(`credits=${entry.credits}`);
	if (entry.costUsd !== undefined) parts.push(`costUsd=${entry.costUsd}`);
	if (entry.rateLimitHeaders) parts.push(`headers=${JSON.stringify(entry.rateLimitHeaders)}`);
	return `  ${entry.engine}  ${parts.join("  ")}`;
}

export function formatSearchUsageResult(result: { entries: SearchEngineUsageEntry[] }): string {
	if (result.entries.length === 0)
		return "No search usage recorded yet -- never a running account balance, only what each call itself reported.";
	return [`${result.entries.length} usage entry(ies), newest first`, ...result.entries.map(formatUsageEntryLine)].join("\n");
}

export function formatSearchTestKeysResult(result: { engine: string; results: Array<{ index: number; status: string }> }): string {
	if (result.results.length === 0) return `${result.engine}: no search keys stored -- nothing to test.`;
	return [
		`${result.engine}: ${result.results.length} key(s) tested`,
		...result.results.map((entry) => `  #${entry.index}  ${entry.status}`),
	].join("\n");
}

export function formatCacheListResult(result: CachedPageListResult): string {
	if (result.pages.length === 0) return "No cached pages.";
	const suffix =
		result.filtered !== result.total ? ` (${result.filtered} of ${result.total} match the filter)` : ` (${result.total} total)`;
	return [`${result.pages.length} cached page(s)${suffix}`, ...result.pages.map((page) => `  ${page.title || page.url}  ${page.url}`)].join(
		"\n",
	);
}

export function formatCacheSearchResult(result: CachedPageSearchResult): string {
	if (result.hits.length === 0) return `No matches for "${result.query}" across ${result.pagesSearched} cached page(s).`;
	return [
		`${result.hits.length} hit(s) for "${result.query}" across ${result.pagesSearched} cached page(s)`,
		...result.hits.map((hit) => `  [${hit.score.toFixed(2)}] ${hit.title} · ${hit.heading}\n    ${hit.text}`),
	].join("\n");
}

export function formatCategoryAssignResult(result: CategoryAssignmentResult): string {
	return `"${result.url}" → category "${result.category}" (id=${result.categoryId}).`;
}

export function formatCategoryRemoveResult(result: { url: string; category: string; removed: true }): string {
	return `"${result.url}" removed from category "${result.category}".`;
}

export function formatCategoryRenameResult(result: CategoryRenameResult): string {
	return result.merged
		? `Merged into existing category "${result.name}" (id=${result.categoryId}).`
		: `Renamed to "${result.name}" (id=${result.categoryId}).`;
}

export function formatCategoryListResult(result: CategoryListResult): string {
	if (result.categories.length === 0) return "No categories yet.";
	return [
		`${result.categories.length} categor${result.categories.length === 1 ? "y" : "ies"}`,
		...result.categories.map((c) => `  ${c.name}  (${c.pageCount} page(s), id=${c.id})`),
	].join("\n");
}

export function formatDaemonDiagnoseResult(result: OperationOutputs["daemon.diagnose"]): string {
	const lines = [
		`instance ${result.instanceId} (pid ${result.pid}, ${result.provenance})`,
		`started ${result.startedAt}`,
		result.history.length === 0 ? "No recorded restart history yet." : `Recent history (${result.history.length}):`,
		...result.history.map((event) => {
			const reason = event.reason ? ` -- ${event.reason}` : "";
			return `  ${event.at}  ${event.type}  instance=${event.instanceId} pid=${event.pid}${reason}`;
		}),
	];
	return lines.join("\n");
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
	if (
		result.action === "eval" ||
		result.action === "queryText" ||
		result.action === "readTable" ||
		result.action === "snapshot" ||
		result.action === "downloads" ||
		result.action === "consoleMessages" ||
		result.action === "networkRequests" ||
		result.action === "tabs"
	)
		return `${header}\n  result: ${JSON.stringify(result.result)}`;
	if (result.action === "screenshot")
		return `${header}\n  screenshot: ${result.screenshotBase64?.length ?? 0} base64 characters (use --json to capture the image data)`;
	return header;
}
