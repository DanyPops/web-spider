/**
 * Orchestrates SessionRegistry + SessionAuditJournal into the four
 * session.* daemon operations. See task
 * daemon-operations-cli-parity-sessioncreatelistcloseact-with--dw0n and its
 * Seeshell-derived corrections:
 *   - every act() call records a content-free journal entry regardless of
 *     outcome (attempt/dispatch/result), including rejected attempts
 *     (unknown session, stale snapshot) — an audit trail of what was
 *     *tried* matters as much as what succeeded.
 *   - act() fails closed on a snapshot-version mismatch rather than acting
 *     against a page that may have navigated or changed underneath it.
 *   - script/url/selector inputs are never written to the journal verbatim
 *     — see domain/session-audit.ts's journalTargetFor()/boundedJournalError().
 */
import type { Logger } from "@danypops/vehicle-server/logging";
import {
	SESSION_ACT_DEFAULT_TIMEOUT_MS,
	SESSION_ACT_EXTRACT_ITEM_MAX_LENGTH,
	SESSION_ACT_EXTRACT_MAX_ITEMS,
	SESSION_ACT_SCRIPT_MAX_LENGTH,
	SESSION_ACT_SNAPSHOT_MAX_LENGTH,
	SESSION_ACT_TEXT_MAX_LENGTH,
} from "../constants.ts";
import type { SessionInfo } from "./session.ts";
import { boundedJournalError, journalTargetFor, type SessionAction } from "./session-audit.ts";
import type { SessionAuditJournal } from "./session-audit-journal.ts";
import type { CreateSessionOptions, SessionPage, SessionRegistry } from "./session-registry.ts";

export class SessionNotFoundError extends Error {}
export class StaleSnapshotError extends Error {}

export interface SessionCreateInput extends CreateSessionOptions {
	name: string;
}

export interface SessionCloseInput {
	name: string;
}

export interface SessionActInput {
	name: string;
	snapshotVersion: number;
	action: SessionAction;
	url?: string;
	selector?: string;
	script?: string;
	timeoutMs?: number;
	/** type action's text to type. Never journaled — could carry a secret. */
	text?: string;
	/** type action only: clear existing content first (default true). */
	clear?: boolean;
	/** select action: match an option by its value attribute. */
	value?: string;
	/** select action: match an option by its visible label. Exactly one of value/label is required. */
	label?: string;
	/** waitFor action: wait for a page navigation state instead of a selector/text condition. Exactly one of selector/text/loadState is required. */
	loadState?: "load" | "domcontentloaded" | "networkidle";
	/** waitFor action: the element state to wait for when using selector/text (default "visible"). Not valid alongside loadState. */
	state?: "visible" | "hidden" | "attached" | "detached";
	/** screenshot action: whole scrollable page instead of just the viewport (default false, matching Playwright's own real default). Not valid alongside selector. */
	fullPage?: boolean;
	/** screenshot action: CSS-pixel-sized (default) vs. device-pixel-ratio resolution. */
	scale?: "css" | "device";
	/** snapshot action: limit the accessibility tree's depth. */
	depth?: number;
	/** snapshot action: include each node's bounding box ([box=x,y,width,height], viewport-relative CSS pixels). */
	boxes?: boolean;
	/** snapshot action: "ai" mode adds element refs, doesn't wait for the element, and includes iframe snapshots. Default "default". */
	mode?: "ai" | "default";
	/** handleDialog action: whether to accept (true) or dismiss (false) the next dialog. Required. */
	accept?: boolean;
	/** handleDialog action: text to answer a prompt() dialog with. Ignored for alert/confirm/beforeunload. */
	promptText?: string;
	/** pressKey action: the key to press (e.g. "Enter", "Escape", "Tab", "ArrowLeft"). Required. */
	key?: string;
	/** networkRequests action: include successful static resources (image/stylesheet/font/script) in the result. Default false, matching Playwright MCP's own convention. */
	includeStatic?: boolean;
	/** tabs action: which tab sub-operation to perform. Required. */
	tabOperation?: "list" | "new" | "close" | "select";
	/** tabs action: the tab index for close (defaults to the active tab)/select (required). Index-addressed, matching Playwright MCP's own tab convention. */
	tabIndex?: number;
}

export interface SessionActOutput {
	name: string;
	action: SessionAction;
	/** The session's snapshot version after this action — bumped only for a successful navigate. */
	snapshotVersion: number;
	/** eval's return value, JSON-serializable. Undefined for other actions. */
	result?: unknown;
	/** Base64-encoded PNG, only for a successful screenshot action. */
	screenshotBase64?: string;
}

/** queryText/readTable: never an unbounded page dump — caps item count and per-item length. */
function boundExtractedItems<T extends string | string[]>(items: T[]): T[] {
	return items
		.slice(0, SESSION_ACT_EXTRACT_MAX_ITEMS)
		.map((item) => (typeof item === "string" ? item.slice(0, SESSION_ACT_EXTRACT_ITEM_MAX_LENGTH) : item) as T);
}

interface ActionRunResult {
	result?: unknown;
	screenshotBase64?: string;
}

/**
 * One entry per SessionAction. Adding a new action means registering a new
 * entry here — no existing branch is ever edited. Replaces what used to be
 * two parallel structures (a validation if-chain and a dispatch switch) both
 * keyed on the same action name, both requiring a new branch for every new
 * action (a real, observed growth pattern — hover/pressKey, tabs, dialogs,
 * downloads, console/network, and screenshot were all added as separate
 * changes to those two structures).
 */
interface ActionHandler {
	/** Throws for invalid input. Runs before the browser page is ever touched. */
	validate(input: SessionActInput): void;
	run(page: SessionPage, input: SessionActInput, registry: SessionRegistry, name: string): Promise<ActionRunResult>;
}

const noValidation: ActionHandler["validate"] = () => {};

const ACTION_HANDLERS: Record<SessionAction, ActionHandler> = {
	navigate: {
		validate(input) {
			if (!input.url) throw new Error("url is required for a navigate action");
		},
		async run(page, input) {
			await page.goto(input.url as string, { timeoutMs: input.timeoutMs });
			return {};
		},
	},
	click: {
		validate(input) {
			if (!input.selector) throw new Error("selector is required for a click action");
		},
		async run(page, input) {
			await page.click(input.selector as string, { timeoutMs: input.timeoutMs });
			return {};
		},
	},
	hover: {
		validate(input) {
			if (!input.selector) throw new Error("selector is required for a hover action");
		},
		async run(page, input) {
			await page.hover(input.selector as string, { timeoutMs: input.timeoutMs });
			return {};
		},
	},
	pressKey: {
		validate(input) {
			if (!input.key) throw new Error("key is required for a pressKey action");
		},
		async run(page, input) {
			await page.pressKey(input.key as string, { selector: input.selector, timeoutMs: input.timeoutMs });
			return {};
		},
	},
	type: {
		validate(input) {
			if (!input.selector) throw new Error("selector is required for a type action");
			if (input.text === undefined) throw new Error("text is required for a type action");
			if (input.text.length > SESSION_ACT_TEXT_MAX_LENGTH) throw new Error(`text exceeds ${SESSION_ACT_TEXT_MAX_LENGTH} characters`);
		},
		async run(page, input) {
			await page.type(input.selector as string, input.text as string, { timeoutMs: input.timeoutMs, clear: input.clear });
			return {};
		},
	},
	select: {
		validate(input) {
			if (!input.selector) throw new Error("selector is required for a select action");
			if (input.value === undefined && input.label === undefined) throw new Error("value or label is required for a select action");
			if (input.value !== undefined && input.label !== undefined) throw new Error("select accepts only one of value or label, not both");
		},
		async run(page, input) {
			await page.select(input.selector as string, { value: input.value, label: input.label }, { timeoutMs: input.timeoutMs });
			return {};
		},
	},
	waitFor: {
		validate(input) {
			const targets = [input.selector, input.text, input.loadState].filter((v) => v !== undefined);
			if (targets.length === 0) throw new Error("waitFor requires exactly one of selector, text, or loadState");
			if (targets.length > 1) throw new Error("waitFor accepts only one of selector, text, or loadState, not more than one");
			if (input.loadState !== undefined && input.state !== undefined) throw new Error("state is not valid alongside loadState");
		},
		async run(page, input) {
			await page.waitFor(
				{ selector: input.selector, text: input.text, loadState: input.loadState },
				{ timeoutMs: input.timeoutMs, state: input.state },
			);
			return {};
		},
	},
	queryText: {
		validate(input) {
			if (!input.selector) throw new Error("selector is required for a queryText action");
		},
		async run(page, input) {
			const texts = await page.queryText(input.selector as string, { timeoutMs: input.timeoutMs });
			return { result: boundExtractedItems(texts) };
		},
	},
	readTable: {
		validate(input) {
			if (!input.selector) throw new Error("selector is required for a readTable action");
		},
		async run(page, input) {
			const rows = await page.readTable(input.selector as string, { timeoutMs: input.timeoutMs });
			return { result: boundExtractedItems(rows).map((row) => boundExtractedItems(row)) };
		},
	},
	snapshot: {
		validate(input) {
			if (input.depth !== undefined && (!Number.isInteger(input.depth) || input.depth < 0))
				throw new Error("depth must be a non-negative integer");
		},
		async run(page, input) {
			// Playwright's own default timeout for ariaSnapshot is 0 (no timeout) —
			// unlike every other action here, an explicit bounded fallback is
			// required rather than relying on Playwright's own default, or an
			// unresponsive page could hang this action forever.
			const tree = await page.snapshot({
				selector: input.selector,
				depth: input.depth,
				boxes: input.boxes,
				mode: input.mode,
				timeoutMs: input.timeoutMs ?? SESSION_ACT_DEFAULT_TIMEOUT_MS,
			});
			return {
				result: tree.length > SESSION_ACT_SNAPSHOT_MAX_LENGTH ? `${tree.slice(0, SESSION_ACT_SNAPSHOT_MAX_LENGTH)}\n... [truncated]` : tree,
			};
		},
	},
	handleDialog: {
		validate(input) {
			if (input.accept === undefined) throw new Error("accept is required for a handleDialog action");
		},
		async run(page, input) {
			await page.armDialogPolicy({ accept: input.accept as boolean, promptText: input.promptText });
			return {};
		},
	},
	// downloads/consoleMessages/networkRequests have no extra validation — reads of already-captured metadata.
	downloads: {
		validate: noValidation,
		async run(page) {
			return { result: await page.listDownloads() };
		},
	},
	consoleMessages: {
		validate: noValidation,
		async run(page) {
			return { result: await page.listConsoleMessages() };
		},
	},
	networkRequests: {
		validate: noValidation,
		async run(page, input) {
			const requests = await page.listNetworkRequests();
			const STATIC_RESOURCE_TYPES = new Set(["image", "stylesheet", "font", "script"]);
			const result = input.includeStatic
				? requests
				: requests.filter((r) => !(STATIC_RESOURCE_TYPES.has(r.resourceType) && r.status >= 200 && r.status < 300));
			return { result };
		},
	},
	tabs: {
		validate(input) {
			const validOps = new Set(["list", "new", "close", "select"]);
			if (!input.tabOperation || !validOps.has(input.tabOperation)) {
				throw new Error('tabOperation is required for a tabs action and must be one of "list", "new", "close", "select"');
			}
			if (input.tabOperation === "select" && input.tabIndex === undefined) {
				throw new Error("tabIndex is required for tabs tabOperation=select");
			}
		},
		// tabOperation's own 4-way dispatch is a small, stable, Playwright-tab-
		// convention-bounded sub-choice, not the growing action switch this map
		// replaces — left as a plain switch rather than a second registry.
		async run(_page, input, registry, name) {
			switch (input.tabOperation) {
				case "list":
					return { result: await registry.listTabs(name) };
				case "new":
					return { result: await registry.newTab(name, input.url) };
				case "close":
					return { result: await registry.closeTab(name, input.tabIndex) };
				case "select":
					return { result: await registry.selectTab(name, input.tabIndex as number) };
				default:
					return {};
			}
		},
	},
	eval: {
		validate(input) {
			if (!input.script) throw new Error("script is required for an eval action");
			if (input.script.length > SESSION_ACT_SCRIPT_MAX_LENGTH)
				throw new Error(`script exceeds ${SESSION_ACT_SCRIPT_MAX_LENGTH} characters`);
		},
		async run(page, input) {
			return { result: await page.evaluate(input.script as string) };
		},
	},
	screenshot: {
		validate(input) {
			if (input.fullPage === true && input.selector !== undefined) throw new Error("screenshot accepts fullPage or selector, not both");
		},
		async run(page, input) {
			const png = await page.screenshot({ fullPage: input.fullPage, selector: input.selector, scale: input.scale });
			return { screenshotBase64: Buffer.from(png).toString("base64") };
		},
	},
};

export class SessionService {
	constructor(
		private readonly registry: SessionRegistry,
		private readonly journal: SessionAuditJournal,
		private readonly now: () => number = Date.now,
		/** Structured logger for session lifecycle/action events — optional so existing tests/wiring that don't care about it keep working unchanged. */
		private readonly logger?: Logger,
	) {}

	async create(input: SessionCreateInput): Promise<SessionInfo> {
		const start = this.now();
		try {
			const info = await this.registry.create(input.name, {
				forceChromeChannel: input.forceChromeChannel,
				headed: input.headed,
			});
			this.logger?.debug("session_create", { sessionName: input.name, outcome: "ok", durationMs: this.now() - start });
			return info;
		} catch (error) {
			this.logger?.warn("session_create", {
				sessionName: input.name,
				outcome: "error",
				error: boundedJournalError(error),
				durationMs: this.now() - start,
			});
			throw error;
		}
	}

	list(): SessionInfo[] {
		return this.registry.list();
	}

	async close(input: SessionCloseInput): Promise<{ name: string; closed: true }> {
		const start = this.now();
		try {
			await this.registry.close(input.name);
			this.logger?.debug("session_close", { sessionName: input.name, outcome: "ok", durationMs: this.now() - start });
			return { name: input.name, closed: true };
		} catch (error) {
			this.logger?.warn("session_close", {
				sessionName: input.name,
				outcome: "error",
				error: boundedJournalError(error),
				durationMs: this.now() - start,
			});
			throw error;
		}
	}

	async act(input: SessionActInput): Promise<SessionActOutput> {
		const start = this.now();
		const target = journalTargetFor(input.action, {
			url: input.url,
			selector: input.selector,
			loadState: input.loadState,
			text: input.action === "waitFor" ? input.text : undefined,
			accept: input.accept,
			key: input.key,
			tabOperation: input.tabOperation,
			tabIndex: input.tabIndex,
		});
		// One structured event per act() call, success or failure — the counterpart
		// to the audit journal below, which is deliberately content-free and not a
		// substitute for operational logging. target/error are already redacted/
		// bounded for the journal (see domain/session-audit.ts) and are exactly as
		// safe to log here — never eval script source, typed text, or promptText.
		const record = (outcome: "ok" | "error" | "stale-snapshot", error: string) => {
			this.journal.record({
				ts: this.now(),
				sessionName: input.name,
				action: input.action,
				snapshotVersion: input.snapshotVersion,
				target,
				outcome,
				error,
			});
			const fields = { sessionName: input.name, action: input.action, target, outcome, durationMs: this.now() - start };
			if (outcome === "ok") this.logger?.debug("session_act", fields);
			else this.logger?.warn("session_act", { ...fields, error });
		};

		const current = this.registry.get(input.name);
		if (!current) {
			const message = `no such session: "${input.name}"`;
			record("error", message);
			throw new SessionNotFoundError(message);
		}
		if (current.snapshotVersion !== input.snapshotVersion) {
			const message = `session "${input.name}" snapshot version mismatch: caller supplied ${input.snapshotVersion}, current is ${current.snapshotVersion} — the page may have navigated or changed; fetch the session's current state before retrying`;
			record("stale-snapshot", message);
			throw new StaleSnapshotError(message);
		}

		try {
			const handler = ACTION_HANDLERS[input.action];
			// Validate action-specific inputs before ever touching the browser page
			// (an oversized eval script, or a missing url/selector, should never
			// cause a page/browser round trip at all).
			handler.validate(input);

			const page = await this.registry.page(input.name);
			const { result, screenshotBase64 } = await handler.run(page, input, this.registry, input.name);

			// Navigation revisions are advanced by committed browser events, not by
			// assuming a dispatched command caused one. This also covers human clicks,
			// reload/history actions, and redirects while avoiding false DOM freshness.
			const updated = this.registry.touchActivity(input.name);
			record("ok", "");
			return { name: input.name, action: input.action, snapshotVersion: updated.snapshotVersion, result, screenshotBase64 };
		} catch (error) {
			record("error", boundedJournalError(error));
			throw error;
		}
	}
}
