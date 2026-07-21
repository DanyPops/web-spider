import { describe, expect, test } from "bun:test";
import { PlaywrightSessionRegistry } from "../src/adapters/playwright-session-registry.ts";
import type { SessionAuditEntry } from "../src/domain/session-audit.ts";
import type { SessionAuditJournal } from "../src/ports/session-audit-journal.ts";
import { SessionNotFoundError, SessionService, StaleSnapshotError } from "../src/session-service.ts";
import { fakeLauncher } from "./helpers/fake-session-registry.ts";

class FakeAuditJournal implements SessionAuditJournal {
	entries: SessionAuditEntry[] = [];
	record(entry: SessionAuditEntry): void { this.entries.push(entry); }
	recent(opts: { sessionName?: string; limit?: number } = {}): SessionAuditEntry[] {
		const filtered = opts.sessionName ? this.entries.filter((e) => e.sessionName === opts.sessionName) : this.entries;
		return filtered.slice(-(opts.limit ?? 100)).reverse();
	}
	pruneOldest(): number { return 0; }
}

function makeHarness(pageOptionsForSession?: NonNullable<Parameters<typeof fakeLauncher>[0]>["pageOptionsForSession"]) {
	const { launcher, pages } = fakeLauncher({ pageOptionsForSession });
	const registry = new PlaywrightSessionRegistry({ launcher, now: () => 1_000 });
	const journal = new FakeAuditJournal();
	const service = new SessionService(registry, journal, () => 2_000);
	return { service, journal, registry, pages };
}

describe("SessionService — create/list/close", () => {
	test("create forwards to the registry and returns the SessionInfo", async () => {
		const { service } = makeHarness();
		const info = await service.create({ name: "agent1" });
		expect(info).toEqual({ name: "agent1", createdAt: 1_000, lastActivityAt: 1_000, snapshotVersion: 0, closed: false });
	});

	test("list forwards to the registry", async () => {
		const { service } = makeHarness();
		await service.create({ name: "a" });
		await service.create({ name: "b" });
		expect(service.list().map((s) => s.name).sort()).toEqual(["a", "b"]);
	});

	test("close forwards to the registry and returns {name, closed:true}", async () => {
		const { service } = makeHarness();
		await service.create({ name: "a" });
		await expect(service.close({ name: "a" })).resolves.toEqual({ name: "a", closed: true });
		expect(service.list()).toHaveLength(0);
	});
});

describe("SessionService — act: navigate", () => {
	test("a successful navigate bumps snapshotVersion and journals outcome:ok with a sanitized URL target", async () => {
		const { service, journal } = makeHarness();
		await service.create({ name: "a" });
		const out = await service.act({ name: "a", snapshotVersion: 0, action: "navigate", url: "https://example.com/page?token=SECRET123&q=hi" });
		expect(out).toEqual({ name: "a", action: "navigate", snapshotVersion: 1 });
		expect(journal.entries).toHaveLength(1);
		expect(journal.entries[0]).toMatchObject({ sessionName: "a", action: "navigate", outcome: "ok", error: "" });
		expect(journal.entries[0]!.target).toContain("token=%5Bredacted%5D");
		expect(journal.entries[0]!.target).not.toContain("SECRET123");
	});

	test("navigate without a url is rejected and journaled as an error, without bumping the version", async () => {
		const { service, journal, registry } = makeHarness();
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "navigate" })).rejects.toThrow(/url is required/);
		expect(registry.get("a")?.snapshotVersion).toBe(0);
		expect(journal.entries[0]).toMatchObject({ outcome: "error" });
		expect(journal.entries[0]!.error).toMatch(/url is required/);
	});
});

describe("SessionService — act: click / eval / screenshot (do not bump snapshotVersion)", () => {
	test("a successful click touches activity but does not bump snapshotVersion, and journals the selector verbatim (not sensitive)", async () => {
		const { service, journal, registry } = makeHarness();
		await service.create({ name: "a" });
		const out = await service.act({ name: "a", snapshotVersion: 0, action: "click", selector: "#submit" });
		expect(out.snapshotVersion).toBe(0);
		expect(registry.get("a")?.snapshotVersion).toBe(0);
		expect(journal.entries[0]).toMatchObject({ action: "click", outcome: "ok", target: "#submit" });
	});

	test("a successful eval returns the result but the journal never records the script source, only '<script>'", async () => {
		const { service, journal, pages } = makeHarness();
		await service.create({ name: "a" });
		// pages[0] resolves whatever evaluateResult the fake was configured with (undefined by default) — assert the shape and journal content-freeness instead.
		const out = await service.act({ name: "a", snapshotVersion: 0, action: "eval", script: "document.title = 'super-secret-value-should-not-leak'" });
		expect(out.action).toBe("eval");
		expect(pages[0]!.evaluateCalls).toEqual(["document.title = 'super-secret-value-should-not-leak'"]);
		expect(journal.entries[0]!.target).toBe("<script>");
		expect(JSON.stringify(journal.entries)).not.toContain("super-secret-value-should-not-leak");
	});

	test("eval rejects an oversized script before ever calling the page", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		const huge = "x".repeat(20_000);
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "eval", script: huge })).rejects.toThrow(/exceeds/);
		expect(pages).toHaveLength(0);
	});

	test("a successful screenshot returns base64 bytes and the journal records only a fixed placeholder, never image bytes", async () => {
		const { service, journal } = makeHarness();
		await service.create({ name: "a" });
		const out = await service.act({ name: "a", snapshotVersion: 0, action: "screenshot" });
		expect(typeof out.screenshotBase64).toBe("string");
		expect(out.screenshotBase64!.length).toBeGreaterThan(0);
		expect(journal.entries[0]!.target).toBe("<screenshot>");
		expect(JSON.stringify(journal.entries)).not.toContain(out.screenshotBase64);
	});
});

describe("SessionService — act: fails closed", () => {
	test("acting on an unknown session throws SessionNotFoundError and journals the rejected attempt", async () => {
		const { service, journal } = makeHarness();
		await expect(service.act({ name: "ghost", snapshotVersion: 0, action: "click", selector: "#x" }))
			.rejects.toThrow(SessionNotFoundError);
		expect(journal.entries[0]).toMatchObject({ sessionName: "ghost", outcome: "error" });
	});

	test("a stale snapshotVersion is rejected with StaleSnapshotError, journaled as stale-snapshot, and never dispatches to the page", async () => {
		const { service, journal, pages } = makeHarness();
		await service.create({ name: "a" });
		await service.act({ name: "a", snapshotVersion: 0, action: "navigate", url: "https://example.com/1" }); // bumps to version 1

		await expect(service.act({ name: "a", snapshotVersion: 0, action: "click", selector: "#x" }))
			.rejects.toThrow(StaleSnapshotError);
		expect(journal.entries[1]).toMatchObject({ outcome: "stale-snapshot", snapshotVersion: 0 });
		// only the earlier navigate reached the page; the stale click never did.
		expect(pages[0]!.clickCalls).toHaveLength(0);
	});

	test("a page-level failure (e.g. click on a missing element) is journaled with a bounded error message and rethrown", async () => {
		const { service, journal } = makeHarness((i) => (i === 0 ? { failClick: true } : {}));
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "click", selector: "#missing" }))
			.rejects.toThrow(/simulated click failure/);
		expect(journal.entries[0]).toMatchObject({ outcome: "error" });
		expect(journal.entries[0]!.error).toMatch(/simulated click failure/);
	});
});
