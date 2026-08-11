/**
 * OperationGateway — the one seam every tool module depends on instead of
 * importing invokeWebSpiderVehicleOperation directly (DIP): each tool file
 * takes an OperationGateway as a parameter rather than reaching for a concrete
 * daemon-client import itself, so a fake implementation can stand in for
 * unit tests without a real daemon, and so the "log the operation name/error
 * on failure" policy lives in exactly one place instead of being
 * reimplemented per tool (web_category previously grew its own ad-hoc,
 * non-logging copy of this instead of sharing it).
 *
 * Diagnostics go only to a file — never to stdout/stderr, which belong to
 * Pi's TUI.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { invokeWebSpiderVehicleOperation } from "./retrying-client.js";

/** Every operation goes through invoke() below -- every web-spider operation has migrated onto the real Vehicle protocol (task 4057390d), carrying whichever tool actually dispatched it (web_fetch/web_session/web_category/web_quotes), its toolCallId, abort signal, and ExtensionContext. */
export type CallMeta = { toolName: string; toolCallId: string; signal?: AbortSignal; context: ExtensionContext };

export type DiagLevel = "info" | "warn" | "error";

export interface OperationGateway {
	/** Routes an operation through invokeWebSpiderVehicleOperation(), giving every caller the same cross-cutting policy (activity broadcasting, the /safety gate, approval retry) uniformly, and logging (never throwing silently) on failure. */
	invoke<T = unknown>(operation: string, input: Record<string, unknown>, callMeta: CallMeta): Promise<T>;
	/** File-based diagnostics -- see the module doc comment. */
	log(level: DiagLevel, msg: string, extra?: unknown): void;
}

export function createOperationGateway(
	diagPath: string = process.env.WEB_SPIDER_DIAG_PATH ?? join(homedir(), ".cache", "web-spider", "diag.log"),
): OperationGateway {
	const diag = (entry: Record<string, unknown>) => {
		const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
		try {
			mkdirSync(dirname(diagPath), { recursive: true });
			appendFileSync(diagPath, `${line}\n`);
		} catch {
			/* best-effort */
		}
	};
	const log = (level: DiagLevel, msg: string, extra?: unknown) => {
		diag({ level, msg, ...(extra !== undefined ? { extra } : {}) });
	};

	return {
		log,
		async invoke<T = unknown>(operation: string, input: Record<string, unknown>, callMeta: CallMeta): Promise<T> {
			try {
				const result = await invokeWebSpiderVehicleOperation(operation, input, callMeta);
				return result.details.output as T;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log("error", "daemon operation failed", { operation, error: message });
				throw error;
			}
		},
	};
}
