/**
 * Wires vehicle-server's generic daemon-lifecycle.ts (structured event log +
 * diagnoseDaemon()) into this daemon's own path layout and Node fs adapter --
 * a few lines, not a bespoke reimplementation, matching the pattern this
 * module was extracted from ("every daemon in this ecosystem previously
 * hand-rolled its own ad-hoc, unstructured lifecycle logging"; web-spider's
 * own daemon.ts had none at all before this).
 */

import { dirname, join } from "node:path";
import { createNodeAtomicJsonFsAdapter } from "@danypops/vehicle-server/atomic-json";
import { type DaemonIdentity, type DaemonLifecycleLog, openDaemonLifecycleLog } from "@danypops/vehicle-server/daemon-lifecycle";
import { LIFECYCLE_LOG_FILENAME } from "./constants.ts";
import type { WebSpiderPaths } from "./state.ts";

/** Sibling of the auth-token file (persistent XDG_STATE_HOME, not the ephemeral XDG_RUNTIME_DIR handle) so restart history survives across restarts -- the whole point of a lifecycle log. Same sibling-of-token convention as search-secrets.ts's resolveSearchKeysDir. */
export function resolveDaemonLifecycleLogPath(paths: WebSpiderPaths): string {
	return join(dirname(paths.token), LIFECYCLE_LOG_FILENAME);
}

export function createWebSpiderLifecycleLog(path: string): DaemonLifecycleLog {
	return openDaemonLifecycleLog({ path, fs: createNodeAtomicJsonFsAdapter() });
}

export interface ResolveCurrentIdentityOrWaitOptions {
	/** Defaults to 500ms -- generous for what should only ever be a handful of JS event-loop ticks plus one small file write (see this function's own doc comment for the exact race), not a real I/O-bound wait. */
	timeoutMs?: number;
	/** Defaults to 10ms. */
	pollIntervalMs?: number;
	/** Injectable for deterministic tests. Defaults to Date.now. */
	now?: () => number;
	/** Injectable for deterministic tests. Defaults to a real setTimeout-backed sleep. */
	sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_IDENTITY_WAIT_TIMEOUT_MS = 500;
const DEFAULT_IDENTITY_WAIT_POLL_INTERVAL_MS = 10;

/**
 * Bridges a real, narrow race: vehicle-server's own startDaemon() writes the daemon handle file
 * (what every real client -- connectWithPolicy's own poll loop, a test, this daemon's own CLI --
 * uses to decide "the daemon is up") *before* its onListen callback fires (a few JS event-loop
 * ticks and one more awaited lifecycle-log file write apart -- see daemon.ts's own onListen).
 * A caller that polls the handle and immediately calls daemon.diagnose can genuinely observe
 * getCurrentIdentity() still returning undefined. Reproduced live, not hypothetical: an 8-run
 * stress test of this daemon's own real end-to-end suite hit this exact race twice.
 *
 * Bounded, not unconditional: a real, permanent misconfiguration (getCurrentIdentity forever
 * returning undefined) still fails -- with a clear, actionable message -- instead of hanging the
 * request forever.
 */
export async function resolveCurrentIdentityOrWait(
	getCurrentIdentity: () => DaemonIdentity | undefined,
	options: ResolveCurrentIdentityOrWaitOptions = {},
): Promise<DaemonIdentity> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_IDENTITY_WAIT_TIMEOUT_MS;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_IDENTITY_WAIT_POLL_INTERVAL_MS;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const deadline = now() + timeoutMs;
	for (;;) {
		const identity = getCurrentIdentity();
		if (identity) return identity;
		if (now() >= deadline) throw new Error("daemon identity is not ready yet; retry daemon.diagnose shortly");
		await sleep(pollIntervalMs);
	}
}
