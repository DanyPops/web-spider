/**
 * Pure redaction/shaping logic for the session audit journal — no SQLite,
 * no Playwright. Seeshell-derived principle (see task
 * daemon-operations-cli-parity-sessioncreatelistcloseact-with--dw0n):
 * the journal records that an action was attempted/dispatched and its
 * outcome, never page content or anything that could carry a secret.
 * The operation's own response to the caller is NOT bound by this — only
 * what gets written to the append-only journal.
 */
import { SESSION_ACT_SELECTOR_MAX_LENGTH, SESSION_ACT_URL_MAX_LENGTH, SESSION_JOURNAL_ERROR_MAX_LENGTH } from "../constants.ts";

export type SessionAction = "navigate" | "click" | "type" | "select" | "waitFor" | "queryText" | "readTable" | "eval" | "screenshot";
export type SessionActOutcome = "ok" | "error" | "stale-snapshot";

export interface SessionAuditEntry {
	ts: number;
	sessionName: string;
	action: SessionAction;
	/** The snapshot version the caller supplied when the attempt was made — not necessarily the session's version afterward. */
	snapshotVersion: number;
	/** Content-free descriptor of what was dispatched — see journalTargetFor(). Never raw script source or page content. */
	target: string;
	outcome: SessionActOutcome;
	/** Bounded, truncated error message. Empty string when outcome is "ok". */
	error: string;
}

const SENSITIVE_QUERY_KEY = /(?:token|key|secret|auth|signature|credential|password)/iu;

/** Redacts suspicious query-string values and bounds length — mirrors the pi-extension's sanitizeWebUrl, kept local since this daemon must not depend on that package. */
export function sanitizeUrlForJournal(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return "<non-http-url>";
		url.username = "";
		url.password = "";
		for (const key of [...url.searchParams.keys()]) {
			if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, "[redacted]");
		}
		url.hash = "";
		return url.toString().slice(0, SESSION_ACT_URL_MAX_LENGTH);
	} catch {
		return "<invalid-url>";
	}
}

function boundedSelector(selector: string): string {
	return selector.slice(0, SESSION_ACT_SELECTOR_MAX_LENGTH);
}

/**
 * The only thing this journal ever records about *what* an action targeted.
 * eval and screenshot never carry page-derived or caller-scripted content —
 * script source is never logged (it could embed secrets or be arbitrarily
 * large), and screenshots have no meaningful non-binary "target" at all.
 */
export function journalTargetFor(action: SessionAction, input: { url?: string; selector?: string; loadState?: string; text?: string }): string {
	switch (action) {
		case "navigate":
			return input.url ? sanitizeUrlForJournal(input.url) : "";
		case "click":
			return input.selector ? boundedSelector(input.selector) : "";
		case "type":
			// The selector is fine to log (it's not sensitive); the typed text
			// itself never is — it could be a password or any other secret.
			return input.selector ? boundedSelector(input.selector) : "";
		case "select":
			// Same reasoning as click — a dropdown's value/label is essentially
			// never sensitive, but the selector alone is enough for an audit
			// trail and keeps this case symmetric with click/type.
			return input.selector ? boundedSelector(input.selector) : "";
		case "waitFor":
			// A CSS selector or an enum load-state name are never sensitive and
			// are logged verbatim/bounded; caller-supplied wait text is treated
			// the same as type's text — never journaled, only that a text wait
			// happened.
			if (input.selector) return boundedSelector(input.selector);
			if (input.loadState) return `<load-state:${input.loadState}>`;
			if (input.text !== undefined) return "<text-wait>";
			return "";
		case "queryText":
		case "readTable":
			// The selector is fine to log; the *extracted page content* itself
			// is never journaled — it's part of the operation's own response to
			// the caller, not the append-only journal (see file header).
			return input.selector ? boundedSelector(input.selector) : "";
		case "eval":
			return "<script>";
		case "screenshot":
			return "<screenshot>";
	}
}

export function boundedJournalError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, SESSION_JOURNAL_ERROR_MAX_LENGTH);
}
