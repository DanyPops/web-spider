/**
 * Minimal structured daemon logging, matching papyrus/src/log.ts's shape.
 * Exists because the periodic checkpoint/optimize maintenance timers used
 * to swallow failures with an empty catch block -- a real failure (e.g. a
 * corrupted WAL file, disk full) would vanish with zero signal anywhere.
 */
export type LogLevel = "info" | "warn" | "error";

/** Credential-safe structured daemon event. Callers must pass bounded, non-sensitive fields. */
export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
	console.error(JSON.stringify({ timestamp: new Date().toISOString(), level, component: "web-spider-daemon", event, ...fields }));
}
