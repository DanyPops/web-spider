/**
 * Adopts @danypops/vehicle-conformance's dual-channel matrix against pi-web-spider's real
 * production rendering path (createWebResult/renderWebFetchResult/parseWebDetails/
 * renderWebFetchCall) -- proves the fix for doc 4e9e08c1 Finding 1 (primaryLines() non-
 * exhaustive format handling) generalizes to the shared ecosystem contract, not just the
 * hand-picked regression cases in presentation.test.ts.
 *
 * bun:test only -- vehicle-conformance is a Bun-only devDependency (imports from "bun:test"
 * directly), while the rest of this package's own tests run under vitest. Wired into this
 * package's own "test" script as a second, separate `bun test` invocation.
 */
import { runToolShellDualChannelConformance, type ToolShellDualChannelFixture } from "@danypops/vehicle-conformance";
import { initTheme, Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { createWebDetails, createWebResult, renderWebFetchCall, renderWebFetchResult, type WebFormat } from "../src/presentation.js";

// A real Theme emitting real ANSI SGR escapes -- required because the conformance suite's own
// physical-line-width assertion strips real ANSI via a CSI regex before counting visible width.
const REAL_FG_COLORS: Record<ThemeColor, string> = {
	accent: "#ee0000",
	border: "#4d4d4d",
	borderAccent: "#ee0000",
	borderMuted: "#383838",
	success: "#6c9b4b",
	error: "#bd6e51",
	warning: "#dca614",
	muted: "#8f8f8f",
	dim: "#757575",
	text: "#e0e0e0",
	thinkingText: "#8f8f8f",
	userMessageText: "#e0e0e0",
	customMessageText: "#e0e0e0",
	customMessageLabel: "#876fd4",
	toolTitle: "#d39292",
	toolOutput: "#e0e0e0",
	mdHeading: "#e0e0e0",
	mdLink: "#0066cc",
	mdLinkUrl: "#0066cc",
	mdCode: "#e0e0e0",
	mdCodeBlock: "#e0e0e0",
	mdCodeBlockBorder: "#383838",
	mdQuote: "#8f8f8f",
	mdQuoteBorder: "#383838",
	mdHr: "#383838",
	mdListBullet: "#e0e0e0",
	toolDiffAdded: "#6c9b4b",
	toolDiffRemoved: "#bd6e51",
	toolDiffContext: "#8f8f8f",
	syntaxComment: "#8f8f8f",
	syntaxKeyword: "#876fd4",
	syntaxFunction: "#63bdbd",
	syntaxVariable: "#e0e0e0",
	syntaxString: "#6c9b4b",
	syntaxNumber: "#dca614",
	syntaxType: "#63bdbd",
	syntaxOperator: "#e0e0e0",
	syntaxPunctuation: "#e0e0e0",
	thinkingOff: "#8f8f8f",
	thinkingMinimal: "#8f8f8f",
	thinkingLow: "#8f8f8f",
	thinkingMedium: "#8f8f8f",
	thinkingHigh: "#8f8f8f",
	thinkingXhigh: "#8f8f8f",
	thinkingMax: "#8f8f8f",
	bashMode: "#e0e0e0",
};

const REAL_BG_COLORS = {
	selectedBg: "#292929",
	userMessageBg: "#1f1f1f",
	customMessageBg: "#1b0d33",
	toolPendingBg: "#1f1f1f",
	toolSuccessBg: "#1d2b12",
	toolErrorBg: "#4c1405",
};

const theme = new Theme(REAL_FG_COLORS, REAL_BG_COLORS, "truecolor");
initTheme();

function render(payload: unknown, format: WebFormat, expanded: boolean, width: 40 | 80 | 120): string[] {
	const result = createWebResult(payload, createWebDetails({ operation: "fetch", format }));
	return renderWebFetchResult(result, { expanded, isPartial: false }, theme, { isPartial: false, lastComponent: undefined }).render(width);
}

const fixture: ToolShellDualChannelFixture = {
	label: "pi-web-spider",
	async create() {
		const subject = {
			bounds: { modelContentBytes: 50_000, presentationDetailsBytes: 24_000 },
			execute: async () => {
				// The raw application payload IS the model channel (createWebResult serializes it
				// verbatim as content) -- an independent PRESENTATION_ONLY marker lives only in the
				// projected details (title), never in the payload itself.
				const payload = { markdown: "MODEL_ONLY: semantic body" };
				const result = createWebResult(
					payload,
					createWebDetails({ operation: "fetch", format: "markdown", title: "PRESENTATION_ONLY headline", url: "https://example.com" }),
				);
				return { content: result.content[0]!.text, details: result.details };
			},
			render: (snapshot: { content: string; details: unknown }, options: { width: 40 | 80 | 120; expanded: boolean; partial?: boolean }) =>
				renderWebFetchResult(
					{ content: [{ type: "text" as const, text: snapshot.content }], details: snapshot.details },
					{ expanded: options.expanded, isPartial: options.partial ?? false },
					theme,
					{ isPartial: options.partial ?? false, lastComponent: undefined },
				).render(options.width),
			replay: (details: unknown, fallbackContent: string, options: { width: 40 | 80 | 120 }) =>
				renderWebFetchResult(
					{ content: [{ type: "text" as const, text: fallbackContent }], details },
					{ expanded: false, isPartial: false },
					theme,
					{ isPartial: false, lastComponent: undefined },
				).render(options.width),
			renderCall: (args: unknown, width: 40 | 80 | 120) =>
				renderWebFetchCall(args as Record<string, unknown>, theme, { lastComponent: undefined }).render(width),
			invalidProjection: async () => {
				// parseWebDetails fails closed (returns undefined) rather than throwing for a cyclic
				// value -- the real production analog here is JSON.stringify itself throwing when
				// createWebResult tries to serialize a cyclic application payload.
				const cyclic: Record<string, unknown> = {};
				cyclic.self = cyclic;
				return createWebResult(cyclic, createWebDetails({ operation: "fetch", format: "markdown" }));
			},
			// One representative real payload per declared WebFormat value (see doc 4e9e08c1 Finding 1
			// / presentation.test.ts's own regression test) -- proves the fixed primaryLines() dispatch
			// generically, through the shared ecosystem assertion, not just this repo's own hand test.
			declaredValueCases: [
				{ value: "markdown", rawPayload: { url: "https://example.com", title: "Example", markdown: "# Heading\n\nBody text." } },
				{ value: "search", rawPayload: { query: "q", results: [{ title: "Result", url: "https://r.test", snippet: "Evidence snippet" }] } },
				{ value: "lean", rawPayload: { title: "Example", description: "A page.", headings: ["## Intro", "## Details"], wordCount: 120 } },
				{ value: "links", rawPayload: { bodyLinks: [{ text: "Docs", href: "https://docs.test" }] } },
				{ value: "highlights", rawPayload: { hits: [{ heading: "Install", score: 0.9, text: "npm install foo" }] } },
				{ value: "tree", rawPayload: { tag: "article", path: "article", text: "npm install", children: [] } },
				{
					value: "source",
					rawPayload: { url: "https://example.com", contentType: "text/html", content: "Normalized text.", complete: true },
				},
				{
					value: "meta",
					rawPayload: { url: "https://example.com", openGraph: { "og:title": "Example" }, twitterCard: { "twitter:card": "summary" } },
				},
			],
			renderDeclaredValue: (value: string, rawPayload: unknown, options: { width: 40 | 80 | 120; expanded: boolean }) =>
				render(rawPayload, value as WebFormat, options.expanded, options.width),
		};
		return { subject, cleanup: () => Promise.resolve() };
	},
};

runToolShellDualChannelConformance(fixture);
