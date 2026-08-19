import { expandHint, shouldShowExpandHint } from "@danypops/vehicle-client-pi/expand-hint";
import { type AgentToolResult, getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, hyperlink, Markdown, type MarkdownTheme, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	COLLAPSED_ITEM_PREVIEW,
	DETAILS_MAX_FIELD_CHARACTERS,
	DETAILS_MAX_ITEMS,
	DETAILS_MAX_SERIALIZED_CHARACTERS,
	DETAILS_VERSION,
	EXPANDED_PRIMARY_MAX_LINES,
	MODEL_CONTENT_MAX_CHARACTERS,
} from "./constants.js";

export type WebOperation = "search" | "fetch" | "crawl" | "cache-list" | "cache-search" | "tree-full" | "tree-query" | "tree-path";
export type WebFormat = "search" | "markdown" | "lean" | "links" | "highlights" | "tree" | "source" | "meta";
export type WebStatus = "ok" | "empty" | "blocked";

export interface WebItemDetails {
	title: string;
	url: string;
}

export interface WebPresentationDetails {
	version: typeof DETAILS_VERSION;
	kind: "web";
	operation: WebOperation;
	format: WebFormat;
	status: WebStatus;
	url?: string;
	title?: string;
	query?: string;
	path?: string;
	depth?: number;
	pages?: number;
	hits?: number;
	links?: number;
	errors?: number;
	wordCount?: number;
	cache?: "hit" | "miss" | "listing" | "search";
	enhanced?: boolean;
	blockedBy?: "robots.txt";
	items: WebItemDetails[];
	truncated: boolean;
	complete: boolean;
	contentCharacters: number;
	deliveredCharacters: number;
}

export interface CreateWebDetailsInput
	extends Partial<
		Omit<WebPresentationDetails, "version" | "kind" | "items" | "truncated" | "complete" | "contentCharacters" | "deliveredCharacters">
	> {
	operation: WebOperation;
	format: WebFormat;
	items?: Array<{ title?: string; url: string }>;
	truncated?: boolean;
	complete?: boolean;
}

function bounded(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	if (!normalized) return undefined;
	return normalized.slice(0, DETAILS_MAX_FIELD_CHARACTERS);
}

const SENSITIVE_QUERY_KEY = /(?:token|key|secret|auth|signature|credential|password)/iu;

export function sanitizeWebUrl(value: unknown): string | undefined {
	const raw = bounded(value);
	if (!raw) return undefined;
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		url.username = "";
		url.password = "";
		for (const key of [...url.searchParams.keys()]) {
			if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, "[redacted]");
		}
		url.hash = "";
		return url.toString().slice(0, DETAILS_MAX_FIELD_CHARACTERS);
	} catch {
		return undefined;
	}
}

export function createWebDetails(input: CreateWebDetailsInput): WebPresentationDetails {
	const items = (input.items ?? []).slice(0, DETAILS_MAX_ITEMS).flatMap((item) => {
		const url = sanitizeWebUrl(item.url);
		if (!url) return [];
		return [{ title: bounded(item.title) ?? url, url }];
	});
	return {
		version: DETAILS_VERSION,
		kind: "web",
		operation: input.operation,
		format: input.format,
		status: input.status ?? "ok",
		...(sanitizeWebUrl(input.url) ? { url: sanitizeWebUrl(input.url) } : {}),
		...(bounded(input.title) ? { title: bounded(input.title) } : {}),
		...(bounded(input.query) ? { query: bounded(input.query) } : {}),
		...(bounded(input.path) ? { path: bounded(input.path) } : {}),
		...(validCount(input.depth) ? { depth: input.depth } : {}),
		...(validCount(input.pages) ? { pages: input.pages } : {}),
		...(validCount(input.hits) ? { hits: input.hits } : {}),
		...(validCount(input.links) ? { links: input.links } : {}),
		...(validCount(input.errors) ? { errors: input.errors } : {}),
		...(validCount(input.wordCount) ? { wordCount: input.wordCount } : {}),
		...(input.cache ? { cache: input.cache } : {}),
		...(input.enhanced ? { enhanced: true } : {}),
		...(input.blockedBy ? { blockedBy: input.blockedBy } : {}),
		items,
		truncated: input.truncated ?? false,
		complete: input.complete ?? !(input.truncated ?? false),
		contentCharacters: 0,
		deliveredCharacters: 0,
	};
}

function truncateSourcePayload(payload: Record<string, unknown>, originalCharacters: number): string | undefined {
	if (typeof payload.content !== "string" || typeof payload.contentType !== "string") return undefined;
	const base = {
		...payload,
		content: "",
		complete: false,
		truncated: true,
		originalCharacters,
		hint: "Use a lower tokenBudget or narrower request for complete normalized source.",
	};
	let low = 0;
	let high = payload.content.length;
	let best = JSON.stringify(base);
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = JSON.stringify({ ...base, content: payload.content.slice(0, middle) });
		if (candidate.length <= MODEL_CONTENT_MAX_CHARACTERS) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return best;
}

function truncateMarkdownPayload(payload: Record<string, unknown>, originalCharacters: number): string | undefined {
	if (typeof payload.markdown !== "string") return undefined;
	const base = {
		...payload,
		markdown: "",
		truncated: true,
		originalCharacters,
		hint: "Use highlights, a tree query/path, or selectors for complete evidence.",
	};
	let low = 0;
	let high = payload.markdown.length;
	let best = JSON.stringify(base);
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = JSON.stringify({ ...base, markdown: payload.markdown.slice(0, middle) });
		if (candidate.length <= MODEL_CONTENT_MAX_CHARACTERS) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return best;
}

function truncatePayload(serialized: string): string {
	const base = {
		truncated: true,
		originalCharacters: serialized.length,
		preview: "",
		hint: "Use a narrower format, query, tree path, selector, or lower crawl scope for complete content.",
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

export function createWebResult(payload: unknown, inputDetails: WebPresentationDetails) {
	const serialized = JSON.stringify(payload);
	const content =
		serialized.length <= MODEL_CONTENT_MAX_CHARACTERS
			? serialized
			: payload && typeof payload === "object" && !Array.isArray(payload)
				? (truncateSourcePayload(payload as Record<string, unknown>, serialized.length) ??
					truncateMarkdownPayload(payload as Record<string, unknown>, serialized.length) ??
					truncatePayload(serialized))
				: truncatePayload(serialized);
	const truncated = inputDetails.truncated || serialized.length > MODEL_CONTENT_MAX_CHARACTERS;
	const details: WebPresentationDetails = {
		...inputDetails,
		truncated,
		complete: inputDetails.complete && !truncated,
		contentCharacters: serialized.length,
		deliveredCharacters: content.length,
	};
	return { content: [{ type: "text" as const, text: content }], details };
}

const OPERATIONS = new Set<WebOperation>([
	"search",
	"fetch",
	"crawl",
	"cache-list",
	"cache-search",
	"tree-full",
	"tree-query",
	"tree-path",
]);
const FORMATS = new Set<WebFormat>(["search", "markdown", "lean", "links", "highlights", "tree", "source", "meta"]);
const STATUSES = new Set<WebStatus>(["ok", "empty", "blocked"]);

export function parseWebDetails(value: unknown): WebPresentationDetails | undefined {
	try {
		if (!value || typeof value !== "object" || JSON.stringify(value).length > DETAILS_MAX_SERIALIZED_CHARACTERS) return undefined;
		const details = value as Record<string, unknown>;
		if (details.version !== DETAILS_VERSION || details.kind !== "web") return undefined;
		if (typeof details.operation !== "string" || !OPERATIONS.has(details.operation as WebOperation)) return undefined;
		if (typeof details.format !== "string" || !FORMATS.has(details.format as WebFormat)) return undefined;
		if (typeof details.status !== "string" || !STATUSES.has(details.status as WebStatus)) return undefined;
		if (!Array.isArray(details.items) || details.items.length > DETAILS_MAX_ITEMS) return undefined;
		if (!details.items.every((item) => validItem(item))) return undefined;
		if (typeof details.truncated !== "boolean" || typeof details.complete !== "boolean") return undefined;
		if (details.truncated && details.complete) return undefined;
		if (
			!validCount(details.contentCharacters) ||
			!validCount(details.deliveredCharacters) ||
			details.deliveredCharacters > MODEL_CONTENT_MAX_CHARACTERS
		)
			return undefined;
		if (details.cache !== undefined && (typeof details.cache !== "string" || !["hit", "miss", "listing", "search"].includes(details.cache)))
			return undefined;
		if (details.enhanced !== undefined && typeof details.enhanced !== "boolean") return undefined;
		if (details.blockedBy !== undefined && details.blockedBy !== "robots.txt") return undefined;
		for (const field of ["url", "title", "query", "path"] as const) {
			if (details[field] !== undefined && (typeof details[field] !== "string" || details[field].length > DETAILS_MAX_FIELD_CHARACTERS))
				return undefined;
		}
		for (const field of ["depth", "pages", "hits", "links", "errors", "wordCount"] as const) {
			if (details[field] !== undefined && !validCount(details[field])) return undefined;
		}
		return value as WebPresentationDetails;
	} catch {
		return undefined;
	}
}

function validCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validItem(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return (
		typeof item.title === "string" &&
		item.title.length <= DETAILS_MAX_FIELD_CHARACTERS &&
		typeof item.url === "string" &&
		item.url.length <= DETAILS_MAX_FIELD_CHARACTERS
	);
}

function host(value: unknown): string {
	const safe = sanitizeWebUrl(value);
	if (!safe) return "";
	try {
		return new URL(safe).hostname;
	} catch {
		return safe;
	}
}

/** web_fetch's own declared parameters never include any of these -- this is a defensive net for
 * an unrecognized/malformed args shape reaching the no-url branch, not a real historical param.
 * Without it, that shape silently rendered the same "Cache list" text a genuine cache-listing call
 * shows, even when the caller clearly meant something else (an identity-shaped field was present).
 * Never a vector for a real credential: only checked when none of url/searchQuery/query matched. */
const GENERIC_IDENTITY_ARG_KEYS = ["name", "title", "id", "text"] as const;

function genericIdentityFallback(args: Record<string, unknown>): string | undefined {
	for (const key of GENERIC_IDENTITY_ARG_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function callText(args: Record<string, unknown>): string {
	const format = typeof args.format === "string" ? args.format : "markdown";
	if (typeof args.searchQuery === "string" && args.searchQuery.trim()) return `Search · ${args.searchQuery.trim()}`;
	if (!args.url) {
		if (typeof args.query === "string" && args.query.trim()) return `Cache search · ${args.query.trim()}`;
		const identity = genericIdentityFallback(args);
		if (identity) return `Web Fetch · ${identity}`;
		return `Cache list${typeof args.grep === "string" && args.grep.trim() ? ` · ${args.grep.trim()}` : ""}`;
	}
	const domain = host(args.url);
	if (format === "tree") {
		if (typeof args.path === "string" && args.path.trim()) return `Tree path · ${domain} · ${args.path.trim()}`;
		if (typeof args.query === "string" && args.query.trim()) return `Tree query · ${domain} · ${args.query.trim()}`;
		return `Tree · ${domain}`;
	}
	if (typeof args.depth === "number" && args.depth > 0) return `Crawl · ${domain} · depth ${Math.floor(args.depth)}`;
	return `Fetch ${format} · ${domain}`;
}

export interface WebFetchCallContext {
	/** The previously returned call-slot component, if any — reuse per Pi's documented best practice. */
	lastComponent: Component | undefined;
}

/**
 * Reuses `context.lastComponent` (a `Text`) via `setText()` instead of allocating a new
 * component on every render, per docs/extensions.md's own renderCall example — `Text`
 * already caches its own rendered lines internally and only recomputes when the text
 * actually changes.
 */
export function renderWebFetchCall(
	args: Record<string, unknown>,
	theme: Theme,
	context: WebFetchCallContext = { lastComponent: undefined },
): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(theme.fg("toolTitle", theme.bold(truncateToWidth(callText(args), 160))));
	return text;
}

function summary(details: WebPresentationDetails): string {
	if (details.status === "blocked") return `Blocked by ${details.blockedBy ?? "policy"} · ${host(details.url)}`;
	const suffix = [
		details.wordCount !== undefined ? `${details.wordCount} words` : undefined,
		details.pages !== undefined ? `${details.pages} pages` : undefined,
		details.hits !== undefined ? `${details.hits} ${details.operation === "search" ? "results" : "hits"}` : undefined,
		details.links !== undefined ? `${details.links} links` : undefined,
		details.cache ? `cache ${details.cache}` : undefined,
		details.enhanced ? "browser" : undefined,
		details.truncated ? "truncated" : undefined,
	]
		.filter(Boolean)
		.join(" · ");
	const identity = details.title || host(details.url) || details.query;
	const action =
		details.operation === "search"
			? "Search complete"
			: details.operation === "crawl"
				? "Crawled"
				: details.operation === "cache-list"
					? "Cached pages"
					: details.operation === "cache-search"
						? "Cache search"
						: details.operation.startsWith("tree")
							? "Tree"
							: `Fetched ${details.format}`;
	return [action, identity, suffix].filter(Boolean).join(" · ");
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

function boundedLines(lines: string[], theme: Theme): string[] {
	if (lines.length <= EXPANDED_PRIMARY_MAX_LINES) return lines;
	return [
		...lines.slice(0, EXPANDED_PRIMARY_MAX_LINES),
		theme.fg("warning", `… ${lines.length - EXPANDED_PRIMARY_MAX_LINES} rendered lines omitted`),
	];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deliberately-labeled last resort for a sub-shape a format branch below doesn't recognize
 * (e.g. cache-list's own {total,pages} shape arriving under format="lean") -- never the silent,
 * unlabeled `JSON.stringify` dump every non-"markdown" format used to fall through to (see doc
 * 4e9e08c1, Finding 1). The label makes this path visibly distinct from a deliberately-curated
 * render, satisfying the declared-value coverage contract (vehicle-conformance's
 * evaluateDeclaredValueCoverage) even for a shape variant this file's per-format polish hasn't
 * reached yet.
 */
function renderLabeledPreview(label: string, payload: unknown, width: number, theme: Theme): string[] {
	const pretty = JSON.stringify(payload, null, 2) ?? String(payload);
	return boundedLines([theme.fg("dim", `(${label})`), ...new Text(pretty, 0, 0).render(width)], theme);
}

/** url/title(+optional description-shaped field) rows shared by search results and page listings. */
function identityRowLines(
	items: unknown[],
	width: number,
	theme: Theme,
	describe?: (item: Record<string, unknown>) => string | undefined,
): string[] {
	const lines: string[] = [];
	for (const raw of items) {
		if (!isRecord(raw) || typeof raw.url !== "string") continue;
		const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : raw.url;
		lines.push(truncateToWidth(theme.fg("accent", title), width));
		// A clickable OSC 8 hyperlink (falls back to plain text automatically on a terminal
		// without OSC 8 support) so an end user can actually reach the page, not just read its url.
		lines.push(truncateToWidth(theme.fg("dim", `  ${hyperlink(raw.url, raw.url)}`), width));
		const description = describe?.(raw);
		if (description?.trim()) lines.push(...new Text(`  ${description.trim()}`, 0, 0).render(width));
		lines.push("");
	}
	return lines;
}

/** A highlights hit across all 3 real shapes this format carries (single fetch: {heading,score,text,citationUrl};
 * cache-search/crawl: {url,heading,score,text}) -- every field is optional-checked, never assumed. */
function highlightHitLines(hits: unknown[], width: number, theme: Theme): string[] {
	const lines: string[] = [];
	for (const raw of hits) {
		if (!isRecord(raw)) continue;
		const heading =
			typeof raw.heading === "string" && raw.heading.trim() ? raw.heading.trim() : typeof raw.url === "string" ? raw.url : "Match";
		const score = typeof raw.score === "number" ? ` (${raw.score.toFixed(2)})` : "";
		lines.push(truncateToWidth(theme.fg("accent", `${heading}${score}`), width));
		if (typeof raw.url === "string" && raw.url !== heading) {
			lines.push(truncateToWidth(theme.fg("dim", `  ${hyperlink(raw.url, raw.url)}`), width));
		}
		if (typeof raw.text === "string" && raw.text.trim()) lines.push(...new Text(`  ${raw.text.trim()}`, 0, 0).render(width));
		lines.push("");
	}
	return lines;
}

function linkListLines(links: unknown[], width: number, theme: Theme): string[] {
	const lines: string[] = [];
	for (const raw of links) {
		if (!isRecord(raw) || typeof raw.href !== "string") continue;
		const text = typeof raw.text === "string" && raw.text.trim() ? raw.text.trim() : raw.href;
		lines.push(truncateToWidth(`${theme.fg("accent", text)} ${theme.fg("dim", hyperlink(raw.href, raw.href))}`, width));
	}
	return lines;
}

function keyValueLines(record: Record<string, unknown>, width: number, theme: Theme): string[] {
	return Object.entries(record)
		.filter((entry): entry is [string, string] => typeof entry[1] === "string")
		.map(([key, value]) => truncateToWidth(`${theme.fg("muted", key)}: ${value}`, width));
}

/** Bounded recursive outline of a DOMNode (or a navigated single node, which has the same tag/path/text/children shape). */
function treeNodeOutlineLines(node: Record<string, unknown>, width: number, theme: Theme, depth = 0): string[] {
	const tag = typeof node.tag === "string" ? node.tag : "node";
	const path = typeof node.path === "string" ? node.path : undefined;
	const text = typeof node.text === "string" && node.text.trim() ? ` "${node.text.trim().slice(0, 60)}"` : "";
	const label = `${"  ".repeat(depth)}${theme.fg("accent", `<${tag}>`)}${path ? ` ${theme.fg("dim", path)}` : ""}${text}`;
	const lines = [truncateToWidth(label, width)];
	const children = Array.isArray(node.children) ? node.children : [];
	const visibleChildren = children.slice(0, 20);
	for (const child of visibleChildren) {
		if (isRecord(child)) lines.push(...treeNodeOutlineLines(child, width, theme, depth + 1));
	}
	if (children.length > visibleChildren.length) {
		lines.push(truncateToWidth(theme.fg("muted", `${"  ".repeat(depth + 1)}… ${children.length - visibleChildren.length} more`), width));
	}
	return lines;
}

function treeQueryHitLines(hits: unknown[], width: number, theme: Theme): string[] {
	const lines: string[] = [];
	for (const raw of hits) {
		if (!isRecord(raw)) continue;
		const tag = typeof raw.tag === "string" ? raw.tag : "node";
		const path = typeof raw.path === "string" ? raw.path : "";
		const score = typeof raw.score === "number" ? ` (${raw.score.toFixed(2)})` : "";
		lines.push(truncateToWidth(`${theme.fg("accent", `<${tag}>`)} ${theme.fg("dim", path)}${score}`, width));
		const snippet = typeof raw.snippet === "string" ? raw.snippet : typeof raw.text === "string" ? raw.text : undefined;
		if (snippet?.trim()) lines.push(...new Text(`  ${snippet.trim()}`, 0, 0).render(width));
	}
	return lines;
}

/**
 * Every declared WebFormat value gets its own deliberate branch -- the `const exhaustive: never`
 * default (matching pi-lector's package-source/rendering.ts precedent) means a future new format
 * fails the build instead of silently degrading to a raw JSON dump the way every non-"markdown"
 * format used to (doc 4e9e08c1, Finding 1). A format's *own* payload shape still varies by which
 * operation produced it (e.g. format="lean" is a LeanPage-shaped object for a single fetch, but
 * {total,pages,...} for a cache listing) -- each branch checks its expected shape defensively and
 * falls to the labeled (never silent) renderLabeledPreview when it doesn't match; full per-shape
 * polish for every operation/format combination is a follow-up, not this fix's scope.
 */
function primaryLines(text: string, details: WebPresentationDetails, width: number, theme: Theme): string[] {
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		return new Text(text, 0, 0).render(width);
	}
	const record = isRecord(payload) ? payload : undefined;

	switch (details.format) {
		case "markdown": {
			if (record && typeof record.markdown === "string") {
				const component = new Markdown(record.markdown, 0, 0, markdownTheme(theme), { color: (value) => theme.fg("text", value) });
				return boundedLines(component.render(width), theme);
			}
			return renderLabeledPreview("unexpected markdown payload shape", payload, width, theme);
		}
		case "search": {
			const results = record && Array.isArray(record.results) ? record.results : undefined;
			if (!results) return renderLabeledPreview("unexpected search payload shape", payload, width, theme);
			if (results.length === 0) return [theme.fg("muted", "No results.")];
			return boundedLines(
				identityRowLines(results, width, theme, (item) => (typeof item.snippet === "string" ? item.snippet : undefined)),
				theme,
			);
		}
		case "lean": {
			// Cache listing / crawl reuse format="lean" for a {pages:[...]} envelope, distinct from a
			// single fetch's LeanPage-shaped {title,description,headings,...}.
			if (record && Array.isArray(record.pages)) return boundedLines(identityRowLines(record.pages, width, theme), theme);
			if (record && (typeof record.title === "string" || Array.isArray(record.headings))) {
				const lines: string[] = [];
				if (typeof record.title === "string" && record.title) lines.push(truncateToWidth(theme.bold(record.title), width));
				if (typeof record.description === "string" && record.description) lines.push(...new Text(record.description, 0, 0).render(width));
				if (Array.isArray(record.headings)) {
					for (const heading of record.headings.slice(0, 30)) {
						if (typeof heading === "string") lines.push(truncateToWidth(theme.fg("dim", heading), width));
					}
				}
				return boundedLines(lines, theme);
			}
			return renderLabeledPreview("unexpected lean payload shape", payload, width, theme);
		}
		case "links": {
			const links = record && Array.isArray(record.bodyLinks) ? record.bodyLinks : undefined;
			if (!links) return renderLabeledPreview("unexpected links payload shape", payload, width, theme);
			if (links.length === 0) return [theme.fg("muted", "No links found.")];
			return boundedLines(linkListLines(links, width, theme), theme);
		}
		case "highlights": {
			const hits = record && Array.isArray(record.hits) ? record.hits : undefined;
			if (!hits) return renderLabeledPreview("unexpected highlights payload shape", payload, width, theme);
			if (hits.length === 0) return [theme.fg("muted", "No matches.")];
			return boundedLines(highlightHitLines(hits, width, theme), theme);
		}
		case "tree": {
			if (record && Array.isArray(record.hits)) return boundedLines(treeQueryHitLines(record.hits, width, theme), theme);
			if (record && record.found === false) {
				return [theme.fg("warning", `Not found: ${typeof record.path === "string" ? record.path : "(path)"}`)];
			}
			if (record && typeof record.tag === "string") return boundedLines(treeNodeOutlineLines(record, width, theme), theme);
			return renderLabeledPreview("unexpected tree payload shape", payload, width, theme);
		}
		case "source": {
			if (record && typeof record.content === "string") {
				const lines: string[] = [];
				if (typeof record.contentType === "string")
					lines.push(truncateToWidth(theme.fg("muted", `Content-Type: ${record.contentType}`), width));
				lines.push(...new Text(record.content, 0, 0).render(width));
				return boundedLines(lines, theme);
			}
			return renderLabeledPreview("unexpected source payload shape", payload, width, theme);
		}
		case "meta": {
			if (record) {
				const lines: string[] = [];
				if (isRecord(record.openGraph)) {
					lines.push(theme.fg("toolTitle", "Open Graph"));
					lines.push(...keyValueLines(record.openGraph, width, theme));
				}
				if (isRecord(record.twitterCard)) {
					lines.push(theme.fg("toolTitle", "Twitter Card"));
					lines.push(...keyValueLines(record.twitterCard, width, theme));
				}
				if (Array.isArray(record.jsonLd) && record.jsonLd.length > 0) {
					lines.push(theme.fg("toolTitle", `JSON-LD (${record.jsonLd.length} block${record.jsonLd.length === 1 ? "" : "s"})`));
				}
				if (lines.length === 0) {
					return [theme.fg("muted", typeof record.hint === "string" ? record.hint : "No structured metadata found.")];
				}
				return boundedLines(lines, theme);
			}
			return renderLabeledPreview("unexpected meta payload shape", payload, width, theme);
		}
		default: {
			const exhaustive: never = details.format;
			return renderLabeledPreview(`unrecognized format ${String(exhaustive)}`, payload, width, theme);
		}
	}
}

function fallbackText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

/**
 * Reusable width-cached result card — mirrors the documented Pi Component performance
 * pattern (docs/tui.md "Performance": cache render lines per width, clear on invalidate())
 * and Papyrus's ArtifactCard shape. Constructed once per tool-call result slot and
 * updated in place via `update()` on subsequent renders of the same call
 * (see docs/extensions.md: "Reuse context.lastComponent when the same component
 * instance can be updated in place").
 *
 * Known limitation shared with every component that pre-bakes theme colors into
 * cached lines (see docs/tui.md "Invalidation and Theme Changes"): a bare theme
 * switch with no new tool result calls only `invalidate()`, not `update()`, so the
 * next render recomputes from the *previous* theme reference until this call's
 * result changes again. This is the same accepted trade-off Papyrus's ArtifactCard/
 * ArtifactListCard/TaskHierarchyPreview already ship with in production.
 */
export class WebResultCard implements Component {
	private result: AgentToolResult<unknown>;
	private details: WebPresentationDetails;
	private expanded: boolean;
	private theme: Theme;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(result: AgentToolResult<unknown>, details: WebPresentationDetails, expanded: boolean, theme: Theme) {
		this.result = result;
		this.details = details;
		this.expanded = expanded;
		this.theme = theme;
	}

	update(result: AgentToolResult<unknown>, details: WebPresentationDetails, expanded: boolean, theme: Theme): void {
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
		const color = details.status === "blocked" ? "warning" : details.status === "empty" ? "muted" : "success";
		const text = fallbackText(this.result);
		const shown = expanded ? details.items : details.items.slice(0, COLLAPSED_ITEM_PREVIEW);
		const hasHiddenContent = text.length > 0 || details.items.length > shown.length;
		const headerText = shouldShowExpandHint(expanded, hasHiddenContent) ? `${summary(details)} · ${expandHint()}` : summary(details);
		const lines = [truncateToWidth(theme.fg(color, headerText), safeWidth)];
		for (const item of shown) {
			lines.push(truncateToWidth(theme.fg("accent", `  ${item.title}`), safeWidth));
			if (expanded) lines.push(truncateToWidth(theme.fg("dim", `    ${item.url}`), safeWidth));
		}
		if (!expanded && details.items.length > shown.length) lines.push(theme.fg("muted", `  … ${details.items.length - shown.length} more`));

		let finalLines = lines;
		if (expanded && text) finalLines = [...lines, "", ...primaryLines(text, details, safeWidth, theme)];

		this.cachedWidth = safeWidth;
		this.cachedLines = finalLines;
		return finalLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export interface WebFetchResultContext {
	isPartial: boolean;
	/** The previously returned result-slot component, if any — reuse per Pi's documented best practice. */
	lastComponent: Component | undefined;
}

export function renderWebFetchResult(
	result: AgentToolResult<unknown>,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: WebFetchResultContext,
): Component {
	const details = parseWebDetails(result.details);
	if (options.isPartial || context.isPartial) {
		const activity =
			details?.operation === "search" ? "Searching the web…" : details?.operation === "crawl" ? "Crawling pages…" : "Fetching web content…";
		return new Text(theme.fg("accent", activity), 0, 0);
	}
	if (!details) return new Text(fallbackText(result), 0, 0);

	const previous = context.lastComponent instanceof WebResultCard ? context.lastComponent : undefined;
	if (previous) {
		previous.update(result, details, options.expanded, theme);
		return previous;
	}
	return new WebResultCard(result, details, options.expanded, theme);
}
