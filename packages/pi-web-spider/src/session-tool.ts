/**
 * web_session — tmux-style persistent browser sessions. A thin, faithful
 * pass-through to the daemon's session.create/list/close/act operations,
 * deliberately kept separate from web_fetch rather than overloading its
 * contract (web_fetch's contract must never change). See daemon-side
 * session-service.ts for the actual behavior/safety guarantees this tool
 * exposes but does not reimplement:
 *   - one owned Playwright browser process per named session, isolated
 *     from the operator's own browser and every other session.
 *   - snapshotVersion is a deliberate safety mechanism, not busywork: the
 *     daemon fails closed (a StaleSnapshotError) if the page navigated or
 *     changed since the caller last observed it. This tool does NOT track
 *     snapshotVersion on the caller's behalf — every act() response
 *     returns the current value; pass it back on the next call. Removing
 *     this friction here would silently undermine the reason it exists.
 *   - every act() call is journaled (content-free — selectors and enum
 *     values only, never typed text, scripts, or page content).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";
import {
	createSessionActDetails,
	createSessionLifecycleDetails,
	createSessionListDetails,
	renderWebSessionCall,
	renderWebSessionResult,
} from "./session-presentation.js";
import type { CallMeta, VehicleGateway } from "./vehicle-gateway.js";

const sessionParamsSchema = Type.Object({
	operation: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("close"), Type.Literal("act")], {
		description: "create/list/close a named session, or act on one",
	}),
	name: Type.Optional(Type.String({ description: "Session name (create/close/act)" })),
	forceChromeChannel: Type.Optional(
		Type.Boolean({ description: "create: use the full installed Chrome channel instead of the default headless shell" }),
	),
	snapshotVersion: Type.Optional(
		Type.Number({
			description:
				"act, required: expected snapshot version, from the previous response (create returns 0). " +
				"A stale value fails closed rather than acting on a page that navigated underneath you.",
		}),
	),
	action: Type.Optional(
		Type.Union(
			[
				Type.Literal("navigate"),
				Type.Literal("click"),
				Type.Literal("hover"),
				Type.Literal("pressKey"),
				Type.Literal("type"),
				Type.Literal("select"),
				Type.Literal("waitFor"),
				Type.Literal("queryText"),
				Type.Literal("readTable"),
				Type.Literal("snapshot"),
				Type.Literal("handleDialog"),
				Type.Literal("downloads"),
				Type.Literal("consoleMessages"),
				Type.Literal("networkRequests"),
				Type.Literal("tabs"),
				Type.Literal("eval"),
				Type.Literal("screenshot"),
			],
			{
				description:
					"act, required. navigate/click/hover/pressKey/type/select act on the page (track snapshotVersion). " +
					"waitFor blocks for a condition instead of guessing a delay. queryText/readTable return structured " +
					"data. snapshot returns a YAML a11y tree -- prefer it over screenshot for page structure. " +
					"handleDialog arms accept/dismiss for the next dialog. downloads/consoleMessages/networkRequests read " +
					"captured session activity. tabs manages multiple tabs. eval runs arbitrary JavaScript -- prefer the " +
					"structured actions above when they fit. screenshot returns a PNG.",
			},
		),
	),
	url: Type.Optional(Type.String({ description: "navigate: URL to load. tabs (new): optional URL for the new tab." })),
	selector: Type.Optional(
		Type.String({
			description:
				"CSS selector for click/hover/type/select/waitFor/queryText/readTable/snapshot(scope)/screenshot(scope); optional focus target for pressKey.",
		}),
	),
	text: Type.Optional(Type.String({ description: "type: text to type as real keystrokes. waitFor: text to wait for." })),
	clear: Type.Optional(Type.Boolean({ description: "type: clear existing content first (default true)" })),
	value: Type.Optional(Type.String({ description: "select: match an option by its value attribute" })),
	label: Type.Optional(Type.String({ description: "select: match an option by its visible label" })),
	loadState: Type.Optional(
		Type.Union([Type.Literal("load"), Type.Literal("domcontentloaded"), Type.Literal("networkidle")], {
			description: "waitFor: navigation state to wait for instead of a selector/text condition",
		}),
	),
	state: Type.Optional(
		Type.Union([Type.Literal("visible"), Type.Literal("hidden"), Type.Literal("attached"), Type.Literal("detached")], {
			description: "waitFor: element state to wait for alongside selector/text (default visible)",
		}),
	),
	script: Type.Optional(Type.String({ description: "eval: JavaScript to run in the page; returns its JSON-serializable result" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Per-action timeout ms (Playwright's own default applies when omitted)" })),
	key: Type.Optional(Type.String({ description: 'pressKey: key to press, e.g. "Enter", "Escape", "Tab", "ArrowLeft"' })),
	fullPage: Type.Optional(
		Type.Boolean({ description: "screenshot: capture the whole scrollable page instead of the viewport; not valid with selector" }),
	),
	scale: Type.Optional(
		Type.Union([Type.Literal("css"), Type.Literal("device")], {
			description: "screenshot: image resolution -- css pixels (default) or real device pixel ratio",
		}),
	),
	depth: Type.Optional(Type.Number({ description: "snapshot: limit the accessibility tree's depth" })),
	boxes: Type.Optional(Type.Boolean({ description: "snapshot: include each node's viewport-relative bounding box" })),
	mode: Type.Optional(
		Type.Union([Type.Literal("ai"), Type.Literal("default")], {
			description:
				'snapshot: "ai" adds element references, doesn\'t wait for a matching element, and includes <iframe> content (default "default")',
		}),
	),
	accept: Type.Optional(Type.Boolean({ description: "handleDialog, required: accept (true) or dismiss (false) the next native dialog" })),
	promptText: Type.Optional(Type.String({ description: "handleDialog: text to answer a prompt() dialog with" })),
	includeStatic: Type.Optional(Type.Boolean({ description: "networkRequests: include successful static resources too (default false)" })),
	tabOperation: Type.Optional(
		Type.Union([Type.Literal("list"), Type.Literal("new"), Type.Literal("close"), Type.Literal("select")], {
			description: "tabs, required: list open tabs; new opens one; close closes one (default active); select switches (tabIndex required)",
		}),
	),
	tabIndex: Type.Optional(
		Type.Number({ description: "tabs: 0-based tab index; required for select, optional for close (default active)" }),
	),
});

type SessionParams = Static<typeof sessionParamsSchema>;

interface SessionActResult {
	name: string;
	action: string;
	snapshotVersion: number;
	result?: unknown;
	screenshotBase64?: string;
}

type SessionToolResult = {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	details: unknown;
};

// ---------------------------------------------------------------------------
// operation=... dispatch (Strategy pattern, OCP): a new operation is one new
// entry here, not a new branch in a growing if/else chain.
// ---------------------------------------------------------------------------
type SessionOperationHandler = (params: SessionParams, callMeta: CallMeta, gateway: VehicleGateway) => Promise<SessionToolResult>;

const SESSION_OPERATION_HANDLERS: Record<SessionParams["operation"], SessionOperationHandler> = {
	async create(params, callMeta, gateway) {
		if (!params.name) throw new Error("name is required for operation=create");
		const result = await gateway.invoke<{ name: string; snapshotVersion: number; closed: boolean }>(
			"session.create",
			{ name: params.name, forceChromeChannel: params.forceChromeChannel },
			callMeta,
		);
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: createSessionLifecycleDetails("create", result.name, { snapshotVersion: result.snapshotVersion }),
		};
	},

	async list(_params, callMeta, gateway) {
		const result = await gateway.invoke<{ sessions: Array<{ name: string; closed: boolean }> }>("session.list", {}, callMeta);
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: createSessionListDetails(result.sessions),
		};
	},

	async close(params, callMeta, gateway) {
		if (!params.name) throw new Error("name is required for operation=close");
		const result = await gateway.invoke<{ name: string; closed: true }>("session.close", { name: params.name }, callMeta);
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: createSessionLifecycleDetails("close", result.name, { closed: true }),
		};
	},

	async act(params, callMeta, gateway) {
		if (!params.name) throw new Error("name is required for operation=act");
		if (params.snapshotVersion === undefined) throw new Error("snapshotVersion is required for operation=act");
		if (!params.action) throw new Error("action is required for operation=act");
		const result = await gateway.invoke<SessionActResult>(
			"session.act",
			{
				name: params.name,
				snapshotVersion: params.snapshotVersion,
				action: params.action,
				url: params.url,
				selector: params.selector,
				script: params.script,
				timeoutMs: params.timeoutMs,
				text: params.text,
				clear: params.clear,
				value: params.value,
				label: params.label,
				loadState: params.loadState,
				state: params.state,
				key: params.key,
				fullPage: params.fullPage,
				scale: params.scale,
				depth: params.depth,
				boxes: params.boxes,
				mode: params.mode,
				accept: params.accept,
				promptText: params.promptText,
				includeStatic: params.includeStatic,
				tabOperation: params.tabOperation,
				tabIndex: params.tabIndex,
			},
			callMeta,
		);

		if (params.action === "screenshot" && typeof result.screenshotBase64 === "string") {
			const summary = { name: result.name, action: result.action, snapshotVersion: result.snapshotVersion };
			return {
				content: [
					{ type: "text", text: JSON.stringify(summary) },
					{ type: "image", data: result.screenshotBase64, mimeType: "image/png" },
				],
				details: createSessionActDetails({ name: result.name, action: result.action, snapshotVersion: result.snapshotVersion }),
			};
		}
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: createSessionActDetails({
				name: result.name,
				action: result.action,
				snapshotVersion: result.snapshotVersion,
				result: result.result,
			}),
		};
	},
};

/** Registers web_session. `gateway` is the one seam this module depends on instead of importing a concrete daemon client (DIP) -- see vehicle-gateway.ts. */
export function registerSessionTool(pi: ExtensionAPI, gateway: VehicleGateway): void {
	pi.registerTool({
		name: "web_session",
		label: "Web Session",
		description: [
			"Persistent, named browser sessions for pages that need real interaction -- typing, selecting dropdowns, waiting on async results, reading tables -- rather than a single fetch.",
			"tmux-session semantics: create once, act on the same page repeatedly, close when done. hover is the only way to trigger CSS :hover-revealed menus/tooltips. Always close sessions you no longer need.",
			"",
			"Every act() response returns snapshotVersion; pass it back on your next call for that session. A stale value is rejected rather than silently acting on a page that may have navigated underneath you. create returns snapshotVersion:0.",
		].join("\n"),
		promptSnippet:
			"Persistent browser sessions: create/act(navigate|click|hover|pressKey|type|select|waitFor|queryText|readTable|snapshot|handleDialog|downloads|consoleMessages|networkRequests|tabs|eval|screenshot)/list/close",
		parameters: sessionParamsSchema,
		renderCall(args, theme, context) {
			return renderWebSessionCall(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderWebSessionResult(result, options, theme, context);
		},
		async execute(toolCallId, params: SessionParams, signal, _onUpdate, context) {
			const callMeta: CallMeta = { toolName: "web_session", toolCallId, signal, context };
			try {
				return await SESSION_OPERATION_HANDLERS[params.operation](params, callMeta, gateway);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`web_session failed: ${message}`);
			}
		},
	});
}
