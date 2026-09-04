import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import type { Logger } from "@danypops/vehicle-server/logging";
import {
	SESSION_ACT_URL_MAX_LENGTH,
	SESSION_DOWNLOAD_DAEMON_MAX_BYTES,
	SESSION_DOWNLOAD_FILE_MAX_BYTES,
	SESSION_DOWNLOAD_SESSION_MAX_BYTES,
	SESSION_MAX_DOWNLOADS_TRACKED,
} from "../constants.ts";

export interface DownloadStoragePolicy {
	readonly maxFileBytes: number;
	readonly maxSessionBytes: number;
	readonly maxDaemonBytes: number;
	readonly maxTrackedPerSession: number;
}

export interface BrowserDownloadSource {
	suggestedFilename(): string;
	createReadStream(): Promise<Readable>;
	cancel(): Promise<void>;
	url(): string;
	failure(): Promise<string | null>;
}

export interface SessionDownloadRecord {
	readonly filename: string;
	readonly suggestedFilename: string;
	readonly path: string | null;
	readonly url: string;
	readonly bytes: number;
	readonly status: "saved" | "rejected" | "failed";
	readonly truncated: boolean;
	readonly failure: string | null;
}

export interface SessionDownloadListing {
	readonly downloads: readonly SessionDownloadRecord[];
	readonly usage: {
		readonly fileMaxBytes: number;
		readonly sessionBytes: number;
		readonly sessionMaxBytes: number;
		readonly daemonBytes: number;
		readonly daemonMaxBytes: number;
	};
	readonly evictedCount: number;
	readonly failureCount: number;
}

const DEFAULT_DOWNLOAD_POLICY: DownloadStoragePolicy = Object.freeze({
	maxFileBytes: SESSION_DOWNLOAD_FILE_MAX_BYTES,
	maxSessionBytes: SESSION_DOWNLOAD_SESSION_MAX_BYTES,
	maxDaemonBytes: SESSION_DOWNLOAD_DAEMON_MAX_BYTES,
	maxTrackedPerSession: SESSION_MAX_DOWNLOADS_TRACKED,
});

function boundedPositiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
	return value;
}

export function resolveDownloadStoragePolicy(policy: Partial<DownloadStoragePolicy> = {}): DownloadStoragePolicy {
	const resolved = {
		maxFileBytes: boundedPositiveInteger(policy.maxFileBytes ?? DEFAULT_DOWNLOAD_POLICY.maxFileBytes, "maxFileBytes"),
		maxSessionBytes: boundedPositiveInteger(policy.maxSessionBytes ?? DEFAULT_DOWNLOAD_POLICY.maxSessionBytes, "maxSessionBytes"),
		maxDaemonBytes: boundedPositiveInteger(policy.maxDaemonBytes ?? DEFAULT_DOWNLOAD_POLICY.maxDaemonBytes, "maxDaemonBytes"),
		maxTrackedPerSession: boundedPositiveInteger(
			policy.maxTrackedPerSession ?? DEFAULT_DOWNLOAD_POLICY.maxTrackedPerSession,
			"maxTrackedPerSession",
		),
	};
	if (resolved.maxFileBytes > resolved.maxSessionBytes) throw new Error("maxFileBytes must not exceed maxSessionBytes");
	if (resolved.maxSessionBytes > resolved.maxDaemonBytes) throw new Error("maxSessionBytes must not exceed maxDaemonBytes");
	return Object.freeze(resolved);
}

/** Produces a display-friendly basename; the actual stored name also receives an opaque collision-resistant prefix. */
export function safeSuggestedFilename(value: string): string {
	const leaf = basename(value.replaceAll("\\", "/"));
	const sanitized = leaf
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}._-]+/gu, "_")
		.replace(/^\.+/, "")
		.slice(0, 120);
	return sanitized && /[\p{L}\p{N}]/u.test(sanitized) ? sanitized : "download";
}

class DownloadLimitError extends Error {
	constructor(readonly scope: "file" | "session" | "daemon") {
		super(`${scope} download byte limit exceeded`);
	}
}

export class DownloadStorageCoordinator {
	private daemonBytes = 0;
	readonly policy: DownloadStoragePolicy;

	constructor(
		policy: Partial<DownloadStoragePolicy> = {},
		private readonly idFactory: () => string = randomUUID,
	) {
		this.policy = resolveDownloadStoragePolicy(policy);
	}

	createSession(directory: string, logger?: Logger): SessionDownloadStore {
		return new SessionDownloadStore(this, directory, logger, this.idFactory);
	}

	tryReserve(sessionBytes: number, additionalBytes: number): "session" | "daemon" | undefined {
		if (sessionBytes + additionalBytes > this.policy.maxSessionBytes) return "session";
		if (this.daemonBytes + additionalBytes > this.policy.maxDaemonBytes) return "daemon";
		this.daemonBytes += additionalBytes;
		return undefined;
	}

	release(bytes: number): void {
		this.daemonBytes = Math.max(0, this.daemonBytes - bytes);
	}

	usageBytes(): number {
		return this.daemonBytes;
	}
}

export class SessionDownloadStore {
	private readonly records: SessionDownloadRecord[] = [];
	private readonly pending = new Set<Promise<void>>();
	private sessionBytes = 0;
	private evictedCount = 0;
	private failureCount = 0;
	private closed = false;

	constructor(
		private readonly coordinator: DownloadStorageCoordinator,
		private readonly directory: string,
		private readonly logger: Logger | undefined,
		private readonly idFactory: () => string,
	) {}

	capture(download: BrowserDownloadSource): Promise<void> {
		if (this.closed) return download.cancel().catch(() => undefined);
		if (this.pending.size >= this.coordinator.policy.maxTrackedPerSession) {
			this.failureCount += 1;
			this.logger?.warn("session_download_concurrency_limit", {
				maxPending: this.coordinator.policy.maxTrackedPerSession,
				filename: safeSuggestedFilename(download.suggestedFilename()),
			});
			return download.cancel().catch(() => undefined);
		}
		const pending = this.captureOwned(download).finally(() => this.pending.delete(pending));
		this.pending.add(pending);
		return pending;
	}

	private async captureOwned(download: BrowserDownloadSource): Promise<void> {
		const suggestedFilename = safeSuggestedFilename(download.suggestedFilename());
		const filename = `${this.idFactory()}-${suggestedFilename}`;
		const path = join(this.directory, filename);
		const url = download.url().slice(0, SESSION_ACT_URL_MAX_LENGTH);
		let reservedBytes = 0;
		let writer: ReturnType<typeof createWriteStream> | undefined;
		let writerFinished: Promise<void> | undefined;
		try {
			await mkdir(this.directory, { recursive: true });
			const stream = await download.createReadStream();
			writer = createWriteStream(path, { flags: "wx", mode: 0o600 });
			writerFinished = finished(writer);
			for await (const rawChunk of stream) {
				const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
				if (reservedBytes + chunk.byteLength > this.coordinator.policy.maxFileBytes) throw new DownloadLimitError("file");
				const exceeded = this.coordinator.tryReserve(this.sessionBytes, chunk.byteLength);
				if (exceeded) throw new DownloadLimitError(exceeded);
				reservedBytes += chunk.byteLength;
				this.sessionBytes += chunk.byteLength;
				if (!writer.write(chunk)) await once(writer, "drain");
			}
			writer.end();
			await writerFinished;
			const failure = await download.failure();
			if (failure) throw new Error(failure);
			await this.record({
				filename,
				suggestedFilename,
				path,
				url,
				bytes: reservedBytes,
				status: "saved",
				truncated: false,
				failure: null,
			});
		} catch (error) {
			writer?.destroy();
			await writerFinished?.catch(() => undefined);
			await download.cancel().catch(() => undefined);
			try {
				await rm(path, { force: true });
				this.release(reservedBytes);
			} catch (cleanupError) {
				this.logger?.warn("session_download_partial_cleanup_failed", { error: String(cleanupError), filename: suggestedFilename });
			}
			this.failureCount += 1;
			const limited = error instanceof DownloadLimitError;
			const failure = limited ? error.message : "download save failed";
			await this.record({
				filename,
				suggestedFilename,
				path: null,
				url,
				bytes: 0,
				status: limited ? "rejected" : "failed",
				truncated: limited,
				failure,
			});
			this.logger?.warn("session_download_handler_failed", { error: String(error), filename: suggestedFilename });
		}
	}

	private async record(record: SessionDownloadRecord): Promise<void> {
		this.records.push(record);
		while (this.records.length > this.coordinator.policy.maxTrackedPerSession) {
			const evicted = this.records.shift();
			if (!evicted) break;
			if (evicted.path) {
				try {
					await rm(evicted.path, { force: true });
				} catch (error) {
					this.records.unshift(evicted);
					const newest = this.records.pop();
					if (newest?.path) {
						try {
							await rm(newest.path, { force: true });
							this.release(newest.bytes);
						} catch {
							// Keep the bytes charged until session-directory cleanup succeeds.
						}
					}
					this.failureCount += 1;
					this.logger?.warn("session_download_eviction_failed", { error: String(error), filename: evicted.filename });
					return;
				}
				this.release(evicted.bytes);
			}
			this.evictedCount += 1;
		}
	}

	private release(bytes: number): void {
		this.sessionBytes = Math.max(0, this.sessionBytes - bytes);
		this.coordinator.release(bytes);
	}

	list(): SessionDownloadListing {
		return {
			downloads: [...this.records],
			usage: {
				fileMaxBytes: this.coordinator.policy.maxFileBytes,
				sessionBytes: this.sessionBytes,
				sessionMaxBytes: this.coordinator.policy.maxSessionBytes,
				daemonBytes: this.coordinator.usageBytes(),
				daemonMaxBytes: this.coordinator.policy.maxDaemonBytes,
			},
			evictedCount: this.evictedCount,
			failureCount: this.failureCount,
		};
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.allSettled([...this.pending]);
		await rm(this.directory, { recursive: true, force: true });
		this.release(this.sessionBytes);
		this.records.length = 0;
	}
}
