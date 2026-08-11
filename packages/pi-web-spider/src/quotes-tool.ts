/**
 * web_quotes -- standalone resource finder. Given a query and an explicit
 * urls list (typically a prior web_fetch(searchQuery=...) call's own
 * results), fetches each one and returns ranked, verbatim BM25F quotes per
 * url -- never an LLM-digested answer (see the daemon's quotes-service.ts
 * doc comment and the "standalone quote/resource-finder extraction mode"
 * design task for the full rationale). Kept as its own tool rather than a
 * web_fetch mode, matching this project's own precedent (web_session,
 * web_category): a genuinely new capability gets its own contract.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { CallMeta, OperationGateway } from "./operation-gateway.js";
import { createQuotesDetails, createQuotesResult, renderWebQuotesCall, renderWebQuotesResult } from "./quotes-presentation.js";

const quotesParamsSchema = Type.Object({
	query: Type.String({ description: "Text to rank quotes against -- the same query you'd pass to web_fetch(searchQuery=...)" }),
	urls: Type.Array(Type.String(), {
		description: "URLs to fetch and extract quotes from -- typically a prior web_fetch(searchQuery=...) call's own result urls",
	}),
	maxQuotesPerUrl: Type.Optional(
		Type.Number({ description: "Per-url quote cap so one page can't dominate the combined result (default 3, max 20)" }),
	),
	maxQuotesTotal: Type.Optional(Type.Number({ description: "Combined quote cap across every url (default 15, max 100)" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Per-request timeout in milliseconds" })),
	enhanced: Type.Optional(Type.Boolean({ description: "Force headless-browser rendering for SPAs/JS-heavy/bot-gated pages" })),
	ignoreRobots: Type.Optional(
		Type.Boolean({ description: "Explicit, audited bypass of robots.txt for this one request -- human-directed only" }),
	),
	sources: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Named per-site strategies to try before generic fetch+Readability, applied to every url -- see web_fetch's own sources parameter for the full list and rationale.",
		}),
	),
	maxCacheAgeMs: Type.Optional(
		Type.Number({
			description: "Reject an already-cached hit older than this many ms for every url -- see web_fetch's own maxCacheAgeMs.",
		}),
	),
});

type QuotesParams = Static<typeof quotesParamsSchema>;

/** Registers web_quotes. `gateway` is the one seam this module depends on instead of importing a concrete daemon client (DIP) -- see operation-gateway.ts. */
export function registerQuotesTool(pi: ExtensionAPI, gateway: OperationGateway): void {
	pi.registerTool({
		name: "web_quotes",
		label: "Web Quotes",
		description: [
			"A standalone resource finder -- fetches an explicit set of urls (e.g. a prior web_fetch(searchQuery=...) call's own results) and returns ranked, verbatim BM25F quotes per url as resource cards. Never an LLM-digested answer: every quote is the source's own exact text, never paraphrased or summarized. The intended two-call recipe is web_fetch(searchQuery=...) to find urls, then web_quotes(query, urls) to pull exact quotes from them.",
			"",
			"Every quote carries citationUrl, a real, standards-based URL Text Fragment (#:~:text=...) that scrolls to and highlights the exact quoted passage in any modern browser. Always cite each quote's citationUrl (falling back to its resource's url) verbatim when presenting it to the user -- never state a quote's content without its source link.",
			"",
			"maxQuotesPerUrl (default 3, max 20) caps each url's own share so one page can't dominate the combined result; maxQuotesTotal (default 15, max 100) bounds the whole response. A url that fails to fetch becomes { url, error } in its own resource card rather than failing the whole batch.",
			"",
			"sources=[...] applies named per-site strategies (llms-txt, markdown-suffix, github, mediawiki, youtube) to every url before generic fetch+Readability -- see web_fetch's own sources parameter.",
			"",
			"maxCacheAgeMs rejects an already-cached hit older than this many ms for every url -- see web_fetch's own maxCacheAgeMs.",
		].join("\n"),
		promptSnippet: "Resource finder: ranked, verbatim BM25F quotes per url, each with a citationUrl -- never an LLM-digested answer",
		parameters: quotesParamsSchema,
		renderCall(args, theme, context) {
			return renderWebQuotesCall(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderWebQuotesResult(result, options, theme, context);
		},
		async execute(toolCallId, params: QuotesParams, signal, _onUpdate, context) {
			try {
				if (!params.query?.trim()) throw new Error("query is required and must be non-empty");
				if (!params.urls || params.urls.length === 0) throw new Error("urls is required and must contain at least one url");
				const callMeta: CallMeta = { toolName: "web_quotes", toolCallId, signal, context };
				const result = await gateway.invoke<{
					query: string;
					urlsRequested: number;
					errors?: number;
					errorUrls?: string[];
					resources: Array<Record<string, unknown>>;
				}>(
					"quotes",
					{
						query: params.query,
						urls: params.urls,
						maxQuotesPerUrl: params.maxQuotesPerUrl,
						maxQuotesTotal: params.maxQuotesTotal,
						timeoutMs: params.timeoutMs,
						enhanced: params.enhanced,
						ignoreRobots: params.ignoreRobots,
						sources: params.sources,
						maxCacheAgeMs: params.maxCacheAgeMs,
					},
					callMeta,
				);
				return createQuotesResult(result, createQuotesDetails(result.query, result.resources));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`web_quotes failed: ${message}`);
			}
		},
	});
}
