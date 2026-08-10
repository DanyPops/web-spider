/**
 * Dual-channel presentation for web_quotes -- mirrors presentation.ts's
 * web_fetch/web_session pattern (createWebResult/WebResultCard/
 * renderWebFetchResult): the model channel (`content`) stays a bounded,
 * complete-enough JSON payload the LLM can actually quote from; the
 * presentation channel (`details`) is a small, separately-bounded summary
 * used only to render a compact card in the TUI. Before this module
 * existed, web_quotes had neither bound nor a card renderer -- its raw
 * JSON (which can run to tens of thousands of characters once several
 * urls' full quote text is included) was dumped verbatim into the
 * terminal collapsed view, the same channel meant for a one-line summary.
 */
import { type AgentToolResult, getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, type MarkdownTheme, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	COLLAPSED_ITEM_PREVIEW,
	DETAILS_MAX_ITEMS,
	DETAILS_MAX_SERIALIZED_CHARACTERS,
	DETAILS_VERSION,
	EXPANDED_PRIMARY_MAX_LINES,
	MODEL_CONTENT_MAX_CHARACTERS,
} from "./constants.js";

export interface QuotesPresentationDetails {
	version: typeof DETAILS_VERSION;
	kind: "web-quotes";
	query: string;
	urlsRequested: number;
	quotesReturned: number;
	errors: number;
	/** Presentation-only preview rows (e.g. "Title  (3 quote(s))" or "url  ERROR: msg") -- bounded, never the quote text itself. */
	items: string[];
	total: number;
	/** True if `items` itself was capped at DETAILS_MAX_ITEMS -- independent of model-channel truncation below. */
	presentationTruncated: boolean;
	truncated: boolean;
	complete: boolean;
	contentCharacters: number;
	deliveredCharacters: number;
}

function bounded(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

export function createQuotesDetails(query: string, resources: Array<Record<string, unknown>>): QuotesPresentationDetails {
	let quotesReturned = 0;
	let errorCount = 0;
	const rows = resources.map((resource) => {
		if (typeof resource.error === "string") {
			errorCount += 1;
			return bounded(`${String(resource.url ?? "")}  ERROR: ${resource.error}`, 500);
		}
		const quotes = Array.isArray(resource.quotes) ? resource.quotes : [];
		quotesReturned += quotes.length;
		return bounded(`${String(resource.title ?? resource.url ?? "")}  (${quotes.length} quote(s))`, 500);
	});
	const items = rows.slice(0, DETAILS_MAX_ITEMS);
	return {
		version: DETAILS_VERSION,
		kind: "web-quotes",
		query: bounded(query, 500),
		urlsRequested: resources.length,
		quotesReturned,
		errors: errorCount,
		items,
		total: rows.length,
		presentationTruncated: rows.length > items.length,
		truncated: false,
		complete: true,
		contentCharacters: 0,
		deliveredCharacters: 0,
	};
}

/** Generic binary-search preview truncation -- same technique presentation.ts's own truncatePayload uses for web_fetch, adapted with a quotes-appropriate hint. */
function truncateQuotesPayload(serialized: string): string {
	const base = {
		truncated: true,
		originalCharacters: serialized.length,
		preview: "",
		hint: "Use a smaller maxQuotesTotal/maxQuotesPerUrl, or fewer urls, for complete content.",
	};
	let low = 0;
	let high = Math.min(serialized.length, MODEL_CONTENT_MAX_CHARACTERS);
	let best = JSON.stringify(base);
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = JSON.stringify({ ...base, preview: serialized.slice(0, middle) });
		if (candidate.length <= MODEL_CONTENT_MAX_CHARACTERS) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return best;
}

export function createQuotesResult(payload: unknown, inputDetails: QuotesPresentationDetails) {
	const serialized = JSON.stringify(payload);
	const content = serialized.length <= MODEL_CONTENT_MAX_CHARACTERS ? serialized : truncateQuotesPayload(serialized);
	const truncated = serialized.length > MODEL_CONTENT_MAX_CHARACTERS;
	const details: QuotesPresentationDetails = {
		...inputDetails,
		truncated,
		complete: !truncated,
		contentCharacters: serialized.length,
		deliveredCharacters: content.length,
	};
	return { content: [{ type: "text" as const, text: content }], details };
}

function validCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseQuotesDetails(value: unknown): QuotesPresentationDetails | undefined {
	try {
		if (!value || typeof value !== "object" || JSON.stringify(value).length > DETAILS_MAX_SERIALIZED_CHARACTERS) return undefined;
		const details = value as Record<string, unknown>;
		if (details.version !== DETAILS_VERSION || details.kind !== "web-quotes") return undefined;
		if (typeof details.query !== "string") return undefined;
		if (!validCount(details.urlsRequested) || !validCount(details.quotesReturned) || !validCount(details.errors)) return undefined;
		if (!Array.isArray(details.items) || details.items.length > DETAILS_MAX_ITEMS || !details.items.every((i) => typeof i === "string"))
			return undefined;
		if (!validCount(details.total)) return undefined;
		if (typeof details.presentationTruncated !== "boolean") return undefined;
		if (typeof details.truncated !== "boolean" || typeof details.complete !== "boolean") return undefined;
		if (details.truncated && details.complete) return undefined;
		if (!validCount(details.contentCharacters) || !validCount(details.deliveredCharacters)) return undefined;
		if (details.deliveredCharacters > MODEL_CONTENT_MAX_CHARACTERS) return undefined;
		return value as QuotesPresentationDetails;
	} catch {
		return undefined;
	}
}

function urlCount(args: Record<string, unknown>): number {
	return Array.isArray(args.urls) ? args.urls.length : 0;
}

function callText(args: Record<string, unknown>): string {
	const query = typeof args.query === "string" && args.query.trim() ? args.query.trim() : "(no query)";
	const count = urlCount(args);
	return `Quotes · ${query} · ${count} url${count === 1 ? "" : "s"}`;
}

export interface QuotesCallContext {
	lastComponent: Component | undefined;
}

export function renderWebQuotesCall(
	args: Record<string, unknown>,
	theme: Theme,
	context: QuotesCallContext = { lastComponent: undefined },
): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(theme.fg("toolTitle", theme.bold(truncateToWidth(callText(args), 160))));
	return text;
}

function summary(details: QuotesPresentationDetails): string {
	const parts = [
		`${details.quotesReturned} quote${details.quotesReturned === 1 ? "" : "s"}`,
		`${details.urlsRequested} url${details.urlsRequested === 1 ? "" : "s"}`,
		details.errors > 0 ? `${details.errors} error${details.errors === 1 ? "" : "s"}` : undefined,
		details.truncated ? "truncated" : undefined,
	].filter(Boolean);
	return `Quotes for "${details.query}" · ${parts.join(" · ")}`;
}

function fallbackText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function markdownTheme(theme: Theme): MarkdownTheme {
	let highlightCode: MarkdownTheme["highlightCode"] | undefined;
	try {
		highlightCode = getMarkdownTheme().highlightCode;
	} catch {
		highlightCode = undefined;
	}
	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		strikethrough: (text) => theme.strikethrough(text),
		underline: (text) => theme.underline(text),
		highlightCode: (code, language) => {
			try {
				return highlightCode?.(code, language) ?? code.split("\n");
			} catch {
				return code.split("\n");
			}
		},
	};
}

/** Renders each resource's quotes as readable Markdown blockquotes with their citationUrl -- never the raw JSON escape-soup a bare Text/JSON.stringify dump would produce. */
function expandedMarkdown(text: string): string {
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		return text;
	}
	if (!payload || typeof payload !== "object" || !Array.isArray((payload as Record<string, unknown>).resources)) {
		return JSON.stringify(payload, null, 2);
	}
	const resources = (payload as { resources: Array<Record<string, unknown>> }).resources;
	const lines: string[] = [];
	for (const resource of resources) {
		lines.push(`### ${String(resource.title ?? resource.url ?? "")}`);
		lines.push(String(resource.url ?? ""));
		if (typeof resource.error === "string") {
			lines.push("", `**Error:** ${resource.error}`, "");
			continue;
		}
		const quotes = Array.isArray(resource.quotes) ? (resource.quotes as Array<Record<string, unknown>>) : [];
		for (const quote of quotes) {
			lines.push("", `> ${String(quote.text ?? "")}`, "");
			if (typeof quote.citationUrl === "string") lines.push(`[source](${quote.citationUrl})`, "");
		}
	}
	return lines.join("\n");
}

function primaryLines(text: string, width: number, theme: Theme): string[] {
	const markdown = expandedMarkdown(text);
	const component = new Markdown(markdown, 0, 0, markdownTheme(theme), { color: (value) => theme.fg("text", value) });
	const lines = component.render(width);
	if (lines.length <= EXPANDED_PRIMARY_MAX_LINES) return lines;
	return [
		...lines.slice(0, EXPANDED_PRIMARY_MAX_LINES),
		theme.fg("warning", `… ${lines.length - EXPANDED_PRIMARY_MAX_LINES} rendered lines omitted`),
	];
}

/** Width-cached result card -- same reuse pattern as presentation.ts's WebResultCard. */
export class QuotesResultCard implements Component {
	private result: AgentToolResult<unknown>;
	private details: QuotesPresentationDetails;
	private expanded: boolean;
	private theme: Theme;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(result: AgentToolResult<unknown>, details: QuotesPresentationDetails, expanded: boolean, theme: Theme) {
		this.result = result;
		this.details = details;
		this.expanded = expanded;
		this.theme = theme;
	}

	update(result: AgentToolResult<unknown>, details: QuotesPresentationDetails, expanded: boolean, theme: Theme): void {
		this.result = result;
		this.details = details;
		this.expanded = expanded;
		this.theme = theme;
		this.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		if (this.cachedLines && this.cachedWidth === safeWidth) return this.cachedLines;

		const details = this.details;
		const theme = this.theme;
		const expanded = this.expanded;
		const color = details.errors > 0 && details.quotesReturned === 0 ? "warning" : "success";
		const lines = [truncateToWidth(theme.fg(color, summary(details)), safeWidth)];
		const shown = expanded ? details.items : details.items.slice(0, COLLAPSED_ITEM_PREVIEW);
		for (const item of shown) lines.push(truncateToWidth(theme.fg("accent", `  ${item}`), safeWidth));
		if (!expanded && details.items.length > shown.length) lines.push(theme.fg("muted", `  … ${details.items.length - shown.length} more`));

		let finalLines = lines;
		if (expanded) {
			const text = fallbackText(this.result);
			if (text) finalLines = [...lines, "", ...primaryLines(text, safeWidth, theme)];
		}

		this.cachedWidth = safeWidth;
		this.cachedLines = finalLines;
		return finalLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export interface QuotesResultContext {
	isPartial: boolean;
	lastComponent: Component | undefined;
}

export function renderWebQuotesResult(
	result: AgentToolResult<unknown>,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: QuotesResultContext,
): Component {
	if (options.isPartial || context.isPartial) return new Text(theme.fg("accent", "Finding quotes…"), 0, 0);

	const details = parseQuotesDetails(result.details);
	if (!details) return new Text(fallbackText(result), 0, 0);

	const previous = context.lastComponent instanceof QuotesResultCard ? context.lastComponent : undefined;
	if (previous) {
		previous.update(result, details, options.expanded, theme);
		return previous;
	}
	return new QuotesResultCard(result, details, options.expanded, theme);
}
