/**
 * SQLite-backed, append-only SessionAuditJournal. See db.ts's
 * MIGRATION_2_SESSION_AUDIT_LOG for the schema and domain/session-audit.ts
 * for the content-free redaction contract this table's rows must satisfy —
 * this adapter trusts its caller (SessionService) to have already redacted;
 * it does not re-validate content here.
 */
import type { Database } from "bun:sqlite";
import { SESSION_AUDIT_LOG_MAX_ROWS } from "../constants.ts";
import type { SessionAction, SessionActOutcome, SessionAuditEntry } from "../domain/session-audit.ts";
import type { SessionAuditJournal } from "../ports/session-audit-journal.ts";

interface AuditRow {
	ts: number;
	session_name: string;
	action: string;
	snapshot_version: number;
	target: string;
	outcome: string;
	error: string;
}

function rowToEntry(row: AuditRow): SessionAuditEntry {
	return {
		ts: row.ts,
		sessionName: row.session_name,
		action: row.action as SessionAction,
		snapshotVersion: row.snapshot_version,
		target: row.target,
		outcome: row.outcome as SessionActOutcome,
		error: row.error,
	};
}

export class SQLiteSessionAuditJournal implements SessionAuditJournal {
	private readonly maxRows: number;

	constructor(
		private readonly db: Database,
		opts: { maxRows?: number } = {},
	) {
		this.maxRows = opts.maxRows ?? SESSION_AUDIT_LOG_MAX_ROWS;
	}

	record(entry: SessionAuditEntry): void {
		this.db
			.query(
				"INSERT INTO session_audit_log (ts, session_name, action, snapshot_version, target, outcome, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(entry.ts, entry.sessionName, entry.action, entry.snapshotVersion, entry.target, entry.outcome, entry.error);
		this.pruneOldest();
	}

	recent(opts: { sessionName?: string; limit?: number } = {}): SessionAuditEntry[] {
		const limit = Math.max(1, Math.min(opts.limit ?? 100, this.maxRows));
		const rows = opts.sessionName
			? (this.db
					.query("SELECT ts, session_name, action, snapshot_version, target, outcome, error FROM session_audit_log WHERE session_name = ? ORDER BY id DESC LIMIT ?")
					.all(opts.sessionName, limit) as AuditRow[])
			: (this.db
					.query("SELECT ts, session_name, action, snapshot_version, target, outcome, error FROM session_audit_log ORDER BY id DESC LIMIT ?")
					.all(limit) as AuditRow[]);
		return rows.map(rowToEntry);
	}

	pruneOldest(): number {
		// Pre-count and pass the exact row count to DELETE explicitly rather than
		// trusting bun:sqlite's post-hoc .changes -- this table has no FK-cascade
		// children today, but pre-counting avoids ever silently miscounting again
		// (see sqlite-cache-store.ts's pruneExpired for the original real bug).
		const { count } = this.db.query("SELECT COUNT(*) as count FROM session_audit_log").get() as { count: number };
		const excess = count - this.maxRows;
		if (excess <= 0) return 0;
		this.db
			.query(
				"DELETE FROM session_audit_log WHERE id IN (SELECT id FROM session_audit_log ORDER BY id ASC LIMIT ?)",
			)
			.run(excess);
		return excess;
	}
}
