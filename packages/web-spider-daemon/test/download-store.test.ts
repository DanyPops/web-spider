import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import {
	type BrowserDownloadSource,
	DownloadStorageCoordinator,
	resolveDownloadStoragePolicy,
	safeSuggestedFilename,
} from "../src/session/download-store.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "web-spider-download-store-"));
	directories.push(directory);
	return directory;
}

function source(name: string, chunks: readonly string[], state: { cancelled: number } = { cancelled: 0 }): BrowserDownloadSource {
	return {
		suggestedFilename: () => name,
		createReadStream: async () => Readable.from(chunks.map((chunk) => Buffer.from(chunk))),
		cancel: async () => {
			state.cancelled += 1;
		},
		url: () => "https://example.test/download",
		failure: async () => null,
	};
}

describe("download storage policy", () => {
	test("validates finite hierarchical ceilings", () => {
		expect(() => resolveDownloadStoragePolicy({ maxFileBytes: 0 })).toThrow("maxFileBytes");
		expect(() => resolveDownloadStoragePolicy({ maxFileBytes: 10, maxSessionBytes: 9 })).toThrow("must not exceed");
		expect(() => resolveDownloadStoragePolicy({ maxSessionBytes: 10, maxDaemonBytes: 9 })).toThrow("must not exceed");
	});

	test("rejects per-file overflow and removes the partial file", async () => {
		const state = { cancelled: 0 };
		const directory = tempDirectory();
		const store = new DownloadStorageCoordinator({ maxFileBytes: 4, maxSessionBytes: 8, maxDaemonBytes: 16 }).createSession(directory);

		await store.capture(source("large.bin", ["abc", "def"], state));

		const listing = store.list();
		expect(listing.downloads).toEqual([
			expect.objectContaining({ suggestedFilename: "large.bin", path: null, bytes: 0, status: "rejected", truncated: true }),
		]);
		expect(listing.usage.sessionBytes).toBe(0);
		expect(state.cancelled).toBe(1);
		expect(existsSync(join(directory, listing.downloads[0]!.filename))).toBe(false);
	});

	test("enforces session and daemon ceilings independently", async () => {
		const coordinator = new DownloadStorageCoordinator({ maxFileBytes: 6, maxSessionBytes: 8, maxDaemonBytes: 10 });
		const first = coordinator.createSession(tempDirectory());
		const second = coordinator.createSession(tempDirectory());

		await first.capture(source("one.bin", ["123456"]));
		await first.capture(source("session.bin", ["abc"]));
		expect(first.list().downloads.at(-1)).toMatchObject({ status: "rejected", failure: "session download byte limit exceeded" });

		await second.capture(source("daemon.bin", ["12345"]));
		expect(second.list().downloads.at(-1)).toMatchObject({ status: "rejected", failure: "daemon download byte limit exceeded" });
		expect(second.list().usage.daemonBytes).toBe(6);
	});
});

describe("download ownership", () => {
	test("metadata eviction deletes the oldest owned file and releases quota", async () => {
		const directory = tempDirectory();
		const ids = ["first", "second"];
		const store = new DownloadStorageCoordinator(
			{ maxFileBytes: 8, maxSessionBytes: 16, maxDaemonBytes: 16, maxTrackedPerSession: 1 },
			() => ids.shift() as string,
		).createSession(directory);
		await store.capture(source("same.txt", ["first"]));
		const firstPath = store.list().downloads[0]!.path as string;
		await store.capture(source("same.txt", ["two"]));

		const listing = store.list();
		expect(listing.downloads).toHaveLength(1);
		expect(listing.downloads[0]).toMatchObject({ suggestedFilename: "same.txt", bytes: 3, status: "saved" });
		expect(listing.evictedCount).toBe(1);
		expect(listing.usage.sessionBytes).toBe(3);
		expect(existsSync(firstPath)).toBe(false);
	});

	test("session close removes every owned file and releases daemon usage", async () => {
		const coordinator = new DownloadStorageCoordinator({ maxFileBytes: 8, maxSessionBytes: 8, maxDaemonBytes: 8 });
		const firstDirectory = tempDirectory();
		const first = coordinator.createSession(firstDirectory);
		await first.capture(source("one.txt", ["12345678"]));
		expect(coordinator.usageBytes()).toBe(8);

		await first.close();
		expect(existsSync(firstDirectory)).toBe(false);
		expect(coordinator.usageBytes()).toBe(0);

		const second = coordinator.createSession(tempDirectory());
		await second.capture(source("two.txt", ["12345678"]));
		expect(second.list().downloads[0]).toMatchObject({ status: "saved", bytes: 8 });
	});

	test("confines duplicate and traversal-like suggested names", async () => {
		const directory = tempDirectory();
		const ids = ["first", "second", "third"];
		const store = new DownloadStorageCoordinator(
			{ maxFileBytes: 8, maxSessionBytes: 24, maxDaemonBytes: 24, maxTrackedPerSession: 3 },
			() => ids.shift() as string,
		).createSession(directory);

		await store.capture(source("../../secret.txt", ["a"]));
		await store.capture(source("../../secret.txt", ["b"]));
		await store.capture(source("..\\..\\💥", ["c"]));

		const records = store.list().downloads;
		expect(records.map((record) => record.filename)).toEqual(["first-secret.txt", "second-secret.txt", "third-download"]);
		expect(new Set(records.map((record) => record.path)).size).toBe(3);
		for (const record of records) expect(dirname(record.path as string)).toBe(directory);
		expect(safeSuggestedFilename("../..\\bad name?.pdf")).toBe("bad_name_.pdf");
	});
});
