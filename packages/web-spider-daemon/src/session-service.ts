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
import { SESSION_ACT_EXTRACT_ITEM_MAX_LENGTH, SESSION_ACT_EXTRACT_MAX_ITEMS, SESSION_ACT_SCRIPT_MAX_LENGTH, SESSION_ACT_TEXT_MAX_LENGTH } from "./constants.ts";
import { boundedJournalError, journalTargetFor, type SessionAction } from "./domain/session-audit.ts";
import type { SessionInfo } from "./domain/session.ts";
import type { SessionAuditJournal } from "./ports/session-audit-journal.ts";
import type { CreateSessionOptions, SessionRegistry } from "./ports/session-registry.ts";

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
	return items.slice(0, SESSION_ACT_EXTRACT_MAX_ITEMS).map((item) => (typeof item === "string" ? item.slice(0, SESSION_ACT_EXTRACT_ITEM_MAX_LENGTH) : item) as T);
}

export class SessionService {
	constructor(
		private readonly registry: SessionRegistry,
		private readonly journal: SessionAuditJournal,
		private readonly now: () => number = Date.now,
	) {}

	create(input: SessionCreateInput): Promise<SessionInfo> {
		return this.registry.create(input.name, { forceChromeChannel: input.forceChromeChannel });
	}

	list(): SessionInfo[] {
		return this.registry.list();
	}

	async close(input: SessionCloseInput): Promise<{ name: string; closed: true }> {
		await this.registry.close(input.name);
		return { name: input.name, closed: true };
	}

	async act(input: SessionActInput): Promise<SessionActOutput> {
		const target = journalTargetFor(input.action, { url: input.url, selector: input.selector, loadState: input.loadState, text: input.action === "waitFor" ? input.text : undefined });
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
			// Validate action-specific inputs before ever touching the browser page
			// (an oversized eval script, or a missing url/selector, should never
			// cause a page/browser round trip at all).
			if (input.action === "navigate" && !input.url) throw new Error("url is required for a navigate action");
			if (input.action === "click" && !input.selector) throw new Error("selector is required for a click action");
			if (input.action === "eval") {
				if (!input.script) throw new Error("script is required for an eval action");
				if (input.script.length > SESSION_ACT_SCRIPT_MAX_LENGTH) throw new Error(`script exceeds ${SESSION_ACT_SCRIPT_MAX_LENGTH} characters`);
			}
			if (input.action === "type") {
				if (!input.selector) throw new Error("selector is required for a type action");
				if (input.text === undefined) throw new Error("text is required for a type action");
				if (input.text.length > SESSION_ACT_TEXT_MAX_LENGTH) throw new Error(`text exceeds ${SESSION_ACT_TEXT_MAX_LENGTH} characters`);
			}
			if (input.action === "select") {
				if (!input.selector) throw new Error("selector is required for a select action");
				if (input.value === undefined && input.label === undefined) throw new Error("value or label is required for a select action");
				if (input.value !== undefined && input.label !== undefined) throw new Error("select accepts only one of value or label, not both");
			}
			if (input.action === "waitFor") {
				const targets = [input.selector, input.text, input.loadState].filter((v) => v !== undefined);
				if (targets.length === 0) throw new Error("waitFor requires exactly one of selector, text, or loadState");
				if (targets.length > 1) throw new Error("waitFor accepts only one of selector, text, or loadState, not more than one");
				if (input.loadState !== undefined && input.state !== undefined) throw new Error("state is not valid alongside loadState");
			}
			if ((input.action === "queryText" || input.action === "readTable") && !input.selector) {
				throw new Error(`selector is required for a ${input.action} action`);
			}

			const page = await this.registry.page(input.name);
			let result: unknown;
			let screenshotBase64: string | undefined;

			switch (input.action) {
				case "navigate": {
					await page.goto(input.url as string, { timeoutMs: input.timeoutMs });
					break;
				}
				case "click": {
					await page.click(input.selector as string, { timeoutMs: input.timeoutMs });
					break;
				}
				case "type": {
					await page.type(input.selector as string, input.text as string, { timeoutMs: input.timeoutMs, clear: input.clear });
					break;
				}
				case "select": {
					await page.select(input.selector as string, { value: input.value, label: input.label }, { timeoutMs: input.timeoutMs });
					break;
				}
				case "waitFor": {
					await page.waitFor(
						{ selector: input.selector, text: input.text, loadState: input.loadState },
						{ timeoutMs: input.timeoutMs, state: input.state },
					);
					break;
				}
				case "queryText": {
					const texts = await page.queryText(input.selector as string, { timeoutMs: input.timeoutMs });
					result = boundExtractedItems(texts);
					break;
				}
				case "readTable": {
					const rows = await page.readTable(input.selector as string, { timeoutMs: input.timeoutMs });
					result = boundExtractedItems(rows).map((row) => boundExtractedItems(row));
					break;
				}
				case "eval": {
					result = await page.evaluate(input.script as string);
					break;
				}
				case "screenshot": {
					const png = await page.screenshot();
					screenshotBase64 = Buffer.from(png).toString("base64");
					break;
				}
			}

			const updated = input.action === "navigate" ? this.registry.bumpSnapshotVersion(input.name) : this.registry.touchActivity(input.name);
			record("ok", "");
			return { name: input.name, action: input.action, snapshotVersion: updated.snapshotVersion, result, screenshotBase64 };
		} catch (error) {
			record("error", boundedJournalError(error));
			throw error;
		}
	}
}
