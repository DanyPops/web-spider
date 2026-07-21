import type { SessionAuditEntry } from "../domain/session-audit.ts";

/**
 * Append-only audit journal — record() is the only write path application
 * code ever calls; there is deliberately no update/delete-a-row method.
 * pruneOldest() removes whole old rows once the bound is exceeded, it never
 * edits kept rows' content.
 */
export interface SessionAuditJournal {
	record(entry: SessionAuditEntry): void;
	/** Bounded read, newest first — for tests/inspection, not (yet) exposed as a public operation. */
	recent(opts?: { sessionName?: string; limit?: number }): SessionAuditEntry[];
	/** Deletes oldest rows beyond the configured cap. Returns rows removed. */
	pruneOldest(): number;
}
