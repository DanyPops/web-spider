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

	test("screenshot forwards fullPage/selector/scale to the page and journals the selector when element-scoped", async () => {
		const { service, journal, pages } = makeHarness();
		await service.create({ name: "a" });

		await service.act({ name: "a", snapshotVersion: 0, action: "screenshot", fullPage: true });
		expect(pages[0]!.screenshotCalls[0]).toEqual({ fullPage: true, selector: undefined, scale: undefined });
		expect(journal.entries[0]!.target).toBe("<screenshot>");

		await service.act({ name: "a", snapshotVersion: 0, action: "screenshot", selector: "#chart", scale: "device" });
		expect(pages[0]!.screenshotCalls[1]).toEqual({ fullPage: undefined, selector: "#chart", scale: "device" });
		expect(journal.entries[1]!.target).toBe("#chart");
	});

	test("screenshot rejects fullPage combined with selector before touching the page", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "screenshot", fullPage: true, selector: "#chart" }))
			.rejects.toThrow(/fullPage or selector, not both/);
		expect(pages).toHaveLength(0);
	});
});

describe("SessionService — act: type (does not bump snapshotVersion)", () => {
	test("a successful type clears by default, calls pressSequentially via the page, and journals only the selector", async () => {
		const { service, journal, pages } = makeHarness();
		await service.create({ name: "a" });
		const out = await service.act({ name: "a", snapshotVersion: 0, action: "type", selector: "#search", text: "super-secret-password" });
		expect(out.snapshotVersion).toBe(0);
		expect(pages[0]!.typeCalls).toEqual([{ selector: "#search", text: "super-secret-password", timeoutMs: undefined, clear: undefined }]);
		expect(journal.entries[0]).toMatchObject({ action: "type", outcome: "ok", target: "#search" });
		expect(JSON.stringify(journal.entries)).not.toContain("super-secret-password");
	});

	test("clear:false is forwarded through to the page", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		await service.act({ name: "a", snapshotVersion: 0, action: "type", selector: "#search", text: "hi", clear: false });
		expect(pages[0]!.typeCalls[0]!.clear).toBe(false);
	});

	test("type without a selector is rejected before touching the page", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "type", text: "hi" })).rejects.toThrow(/selector is required/);
		expect(pages).toHaveLength(0);
	});

	test("type without text is rejected before touching the page", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "type", selector: "#search" })).rejects.toThrow(/text is required/);
		expect(pages).toHaveLength(0);
	});

	test("oversized text is rejected before touching the page", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		const huge = "x".repeat(3_000);
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "type", selector: "#search", text: huge })).rejects.toThrow(/exceeds/);
		expect(pages).toHaveLength(0);
	});

	test("a page-level type failure is journaled and rethrown", async () => {
		const { service, journal } = makeHarness((i) => (i === 0 ? { failType: true } : {}));
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "type", selector: "#missing", text: "hi" })).rejects.toThrow(/simulated type failure/);
		expect(journal.entries[0]).toMatchObject({ outcome: "error" });
	});
});

describe("SessionService — act: select (does not bump snapshotVersion)", () => {
	test("selects by value and journals only the selector", async () => {
		const { service, journal, pages } = makeHarness();
		await service.create({ name: "a" });
		const out = await service.act({ name: "a", snapshotVersion: 0, action: "select", selector: "#wg", value: "wg3" });
		expect(out.snapshotVersion).toBe(0);
		expect(pages[0]!.selectCalls).toEqual([{ selector: "#wg", target: { value: "wg3", label: undefined }, timeoutMs: undefined }]);
		expect(journal.entries[0]).toMatchObject({ action: "select", outcome: "ok", target: "#wg" });
	});

	test("selects by label", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		await service.act({ name: "a", snapshotVersion: 0, action: "select", selector: "#wg", label: "WG3: Near-real-time RIC and E2 Interface Workgroup" });
		expect(pages[0]!.selectCalls[0]!.target).toEqual({ value: undefined, label: "WG3: Near-real-time RIC and E2 Interface Workgroup" });
	});

	test("select without a selector is rejected before touching the page", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "select", value: "wg3" })).rejects.toThrow(/selector is required/);
		expect(pages).toHaveLength(0);
	});

	test("select without value or label is rejected before touching the page", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "select", selector: "#wg" })).rejects.toThrow(/value or label is required/);
		expect(pages).toHaveLength(0);
	});

	test("select with both value and label is rejected before touching the page", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "select", selector: "#wg", value: "wg3", label: "WG3" })).rejects.toThrow(/only one of value or label/);
		expect(pages).toHaveLength(0);
	});

	test("a page-level select failure is journaled and rethrown", async () => {
		const { service, journal } = makeHarness((i) => (i === 0 ? { failSelect: true } : {}));
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "select", selector: "#wg", value: "ghost" })).rejects.toThrow(/simulated select failure/);
		expect(journal.entries[0]).toMatchObject({ outcome: "error" });
	});
});

describe("SessionService — act: waitFor (does not bump snapshotVersion)", () => {
	test("waits on a selector and journals the selector", async () => {
		const { service, journal, pages } = makeHarness();
		await service.create({ name: "a" });
		const out = await service.act({ name: "a", snapshotVersion: 0, action: "waitFor", selector: "#results" });
		expect(out.snapshotVersion).toBe(0);
		expect(pages[0]!.waitForCalls).toEqual([{ target: { selector: "#results", text: undefined, loadState: undefined }, timeoutMs: undefined, state: undefined }]);
		expect(journal.entries[0]).toMatchObject({ action: "waitFor", outcome: "ok", target: "#results" });
	});

	test("waits on text and journals only a fixed placeholder, never the text", async () => {
		const { service, journal, pages } = makeHarness();
		await service.create({ name: "a" });
		await service.act({ name: "a", snapshotVersion: 0, action: "waitFor", text: "secret-marker" });
		expect(pages[0]!.waitForCalls[0]!.target).toEqual({ selector: undefined, text: "secret-marker", loadState: undefined });
		expect(journal.entries[0]!.target).toBe("<text-wait>");
		expect(JSON.stringify(journal.entries)).not.toContain("secret-marker");
	});

	test("waits on a load state and forwards the element state option only when using selector/text", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		await service.act({ name: "a", snapshotVersion: 0, action: "waitFor", loadState: "networkidle" });
		expect(pages[0]!.waitForCalls[0]!.target).toEqual({ selector: undefined, text: undefined, loadState: "networkidle" });

		await service.act({ name: "a", snapshotVersion: 0, action: "waitFor", selector: "#x", state: "hidden" });
		expect(pages[0]!.waitForCalls[1]!.state).toBe("hidden");
	});

	test("requires exactly one of selector/text/loadState — rejects zero before touching the page", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "waitFor" })).rejects.toThrow(/requires exactly one/);
		expect(pages).toHaveLength(0);
	});

	test("requires exactly one of selector/text/loadState — rejects more than one before touching the page", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "waitFor", selector: "#x", text: "y" })).rejects.toThrow(/only one/);
		expect(pages).toHaveLength(0);
	});

	test("rejects state alongside loadState before touching the page", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "waitFor", loadState: "load", state: "visible" })).rejects.toThrow(/state is not valid alongside loadState/);
		expect(pages).toHaveLength(0);
	});

	test("a page-level waitFor timeout is journaled and rethrown", async () => {
		const { service, journal } = makeHarness((i) => (i === 0 ? { failWaitFor: true } : {}));
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "waitFor", selector: "#never-appears" })).rejects.toThrow(/simulated waitFor failure/);
		expect(journal.entries[0]).toMatchObject({ outcome: "error" });
	});
});

describe("SessionService — act: queryText (does not bump snapshotVersion)", () => {
	test("returns extracted text and journals only the selector", async () => {
		const { service, journal, pages } = makeHarness((i) => (i === 0 ? { queryTextResult: [" foo ", "bar"] } : {}));
		await service.create({ name: "a" });
		const out = await service.act({ name: "a", snapshotVersion: 0, action: "queryText", selector: "li" });
		expect(out.snapshotVersion).toBe(0);
		expect(out.result).toEqual([" foo ", "bar"]);
		expect(pages[0]!.queryTextCalls).toEqual([{ selector: "li", timeoutMs: undefined }]);
		expect(journal.entries[0]).toMatchObject({ action: "queryText", outcome: "ok", target: "li" });
		expect(JSON.stringify(journal.entries)).not.toContain("foo");
	});

	test("bounds the number of items returned", async () => {
		const many = Array.from({ length: 500 }, (_, i) => `item-${i}`);
		const { service } = makeHarness(() => ({ queryTextResult: many }));
		await service.create({ name: "a" });
		const out = await service.act({ name: "a", snapshotVersion: 0, action: "queryText", selector: "li" });
		expect((out.result as string[]).length).toBe(200);
	});

	test("bounds the length of each item returned", async () => {
		const { service } = makeHarness(() => ({ queryTextResult: ["x".repeat(5_000)] }));
		await service.create({ name: "a" });
		const out = await service.act({ name: "a", snapshotVersion: 0, action: "queryText", selector: "li" });
		expect((out.result as string[])[0]!.length).toBe(2_000);
	});

	test("requires a selector", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "queryText" })).rejects.toThrow(/selector is required/);
		expect(pages).toHaveLength(0);
	});

	test("a page-level failure is journaled and rethrown", async () => {
		const { service, journal } = makeHarness((i) => (i === 0 ? { failQueryText: true } : {}));
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "queryText", selector: "#missing" })).rejects.toThrow(/simulated queryText failure/);
		expect(journal.entries[0]).toMatchObject({ outcome: "error" });
	});
});

describe("SessionService — act: readTable (does not bump snapshotVersion)", () => {
	test("returns extracted rows and journals only the selector", async () => {
		const { service, journal, pages } = makeHarness((i) => (i === 0 ? { readTableResult: [["a", "b"], ["c", "d"]] } : {}));
		await service.create({ name: "a" });
		const out = await service.act({ name: "a", snapshotVersion: 0, action: "readTable", selector: "table" });
		expect(out.snapshotVersion).toBe(0);
		expect(out.result).toEqual([["a", "b"], ["c", "d"]]);
		expect(pages[0]!.readTableCalls).toEqual([{ selector: "table", timeoutMs: undefined }]);
		expect(journal.entries[0]).toMatchObject({ action: "readTable", outcome: "ok", target: "table" });
	});

	test("bounds the number of rows and the number/length of cells per row", async () => {
		const manyRows = Array.from({ length: 500 }, (_, i) => [`row-${i}`, "x".repeat(5_000)]);
		const { service } = makeHarness(() => ({ readTableResult: manyRows }));
		await service.create({ name: "a" });
		const out = await service.act({ name: "a", snapshotVersion: 0, action: "readTable", selector: "table" });
		const rows = out.result as string[][];
		expect(rows.length).toBe(200);
		expect(rows[0]![1]!.length).toBe(2_000);
	});

	test("requires a selector", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "readTable" })).rejects.toThrow(/selector is required/);
		expect(pages).toHaveLength(0);
	});

	test("a page-level failure is journaled and rethrown", async () => {
		const { service, journal } = makeHarness((i) => (i === 0 ? { failReadTable: true } : {}));
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "readTable", selector: "#missing" })).rejects.toThrow(/simulated readTable failure/);
		expect(journal.entries[0]).toMatchObject({ outcome: "error" });
	});
});

describe("SessionService — act: snapshot (does not bump snapshotVersion)", () => {
	test("returns the accessibility tree and journals a fixed placeholder for a whole-page snapshot", async () => {
		const { service, journal, pages } = makeHarness((i) => (i === 0 ? { snapshotResult: '- heading "Title" [level=1]' } : {}));
		await service.create({ name: "a" });
		const out = await service.act({ name: "a", snapshotVersion: 0, action: "snapshot" });
		expect(out.snapshotVersion).toBe(0);
		expect(out.result).toBe('- heading "Title" [level=1]');
		expect(journal.entries[0]).toMatchObject({ action: "snapshot", outcome: "ok", target: "<snapshot>" });
	});

	test("applies an explicit bounded default timeout when the caller omits one (Playwright's own ariaSnapshot default is unbounded)", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		await service.act({ name: "a", snapshotVersion: 0, action: "snapshot" });
		expect(pages[0]!.snapshotCalls[0]!.timeoutMs).toBeGreaterThan(0);
	});

	test("forwards an explicit timeoutMs instead of the default when the caller supplies one", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		await service.act({ name: "a", snapshotVersion: 0, action: "snapshot", timeoutMs: 5_000 });
		expect(pages[0]!.snapshotCalls[0]!.timeoutMs).toBe(5_000);
	});

	test("forwards selector/depth/boxes/mode and journals the selector when element-scoped", async () => {
		const { service, journal, pages } = makeHarness();
		await service.create({ name: "a" });
		await service.act({ name: "a", snapshotVersion: 0, action: "snapshot", selector: "nav", depth: 2, boxes: true, mode: "ai" });
		expect(pages[0]!.snapshotCalls[0]).toMatchObject({ selector: "nav", depth: 2, boxes: true, mode: "ai" });
		expect(journal.entries[0]!.target).toBe("nav");
	});

	test("rejects a negative or non-integer depth before touching the page", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "snapshot", depth: -1 })).rejects.toThrow(/non-negative integer/);
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "snapshot", depth: 1.5 })).rejects.toThrow(/non-negative integer/);
		expect(pages).toHaveLength(0);
	});

	test("bounds an oversized snapshot with a truncation marker", async () => {
		const huge = "x".repeat(30_000);
		const { service } = makeHarness(() => ({ snapshotResult: huge }));
		await service.create({ name: "a" });
		const out = await service.act({ name: "a", snapshotVersion: 0, action: "snapshot" });
		expect((out.result as string).length).toBeLessThan(huge.length);
		expect(out.result as string).toContain("[truncated]");
	});

	test("a page-level failure is journaled and rethrown", async () => {
		const { service, journal } = makeHarness((i) => (i === 0 ? { failSnapshot: true } : {}));
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "snapshot" })).rejects.toThrow(/simulated snapshot failure/);
		expect(journal.entries[0]).toMatchObject({ outcome: "error" });
	});
});

describe("SessionService — act: handleDialog (does not bump snapshotVersion)", () => {
	test("arms accept and journals a fixed placeholder, never promptText", async () => {
		const { service, journal, pages } = makeHarness();
		await service.create({ name: "a" });
		const out = await service.act({ name: "a", snapshotVersion: 0, action: "handleDialog", accept: true, promptText: "super-secret-answer" });
		expect(out.snapshotVersion).toBe(0);
		expect(pages[0]!.armDialogPolicyCalls).toEqual([{ accept: true, promptText: "super-secret-answer" }]);
		expect(journal.entries[0]).toMatchObject({ action: "handleDialog", outcome: "ok", target: "<dialog:accept>" });
		expect(JSON.stringify(journal.entries)).not.toContain("super-secret-answer");
	});

	test("arms dismiss and journals the distinct dismiss placeholder", async () => {
		const { service, journal, pages } = makeHarness();
		await service.create({ name: "a" });
		await service.act({ name: "a", snapshotVersion: 0, action: "handleDialog", accept: false });
		expect(pages[0]!.armDialogPolicyCalls).toEqual([{ accept: false, promptText: undefined }]);
		expect(journal.entries[0]!.target).toBe("<dialog:dismiss>");
	});

	test("requires accept to be specified before touching the page", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "handleDialog" })).rejects.toThrow(/accept is required/);
		expect(pages).toHaveLength(0);
	});

	test("a page-level failure is journaled and rethrown", async () => {
		const { service, journal } = makeHarness((i) => (i === 0 ? { failHandleDialog: true } : {}));
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "handleDialog", accept: true })).rejects.toThrow(/simulated handleDialog failure/);
		expect(journal.entries[0]).toMatchObject({ outcome: "error" });
	});
});

describe("SessionService — act: downloads (does not bump snapshotVersion)", () => {
	test("returns already-captured download metadata and journals a fixed placeholder", async () => {
		const record = { filename: "spec.pdf", path: "/tmp/x/spec.pdf", url: "https://x.test/spec.pdf", failure: null };
		const { service, journal, pages } = makeHarness((i) => (i === 0 ? { downloadsResult: [record] } : {}));
		await service.create({ name: "a" });
		const out = await service.act({ name: "a", snapshotVersion: 0, action: "downloads" });
		expect(out.snapshotVersion).toBe(0);
		expect(out.result).toEqual([record]);
		expect(pages[0]!.listDownloadsCallCount).toBe(1);
		expect(journal.entries[0]).toMatchObject({ action: "downloads", outcome: "ok", target: "<downloads>" });
	});

	test("a page-level failure is journaled and rethrown", async () => {
		const { service, journal } = makeHarness((i) => (i === 0 ? { failListDownloads: true } : {}));
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "downloads" })).rejects.toThrow(/simulated listDownloads failure/);
		expect(journal.entries[0]).toMatchObject({ outcome: "error" });
	});
});

describe("SessionService — act: hover (does not bump snapshotVersion)", () => {
	test("hovers and journals the selector", async () => {
		const { service, journal, pages } = makeHarness();
		await service.create({ name: "a" });
		const out = await service.act({ name: "a", snapshotVersion: 0, action: "hover", selector: "#menu" });
		expect(out.snapshotVersion).toBe(0);
		expect(pages[0]!.hoverCalls).toEqual([{ selector: "#menu", timeoutMs: undefined }]);
		expect(journal.entries[0]).toMatchObject({ action: "hover", outcome: "ok", target: "#menu" });
	});

	test("requires a selector", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "hover" })).rejects.toThrow(/selector is required/);
		expect(pages).toHaveLength(0);
	});

	test("a page-level failure is journaled and rethrown", async () => {
		const { service, journal } = makeHarness((i) => (i === 0 ? { failHover: true } : {}));
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "hover", selector: "#missing" })).rejects.toThrow(/simulated hover failure/);
		expect(journal.entries[0]).toMatchObject({ outcome: "error" });
	});
});

describe("SessionService — act: pressKey (does not bump snapshotVersion)", () => {
	test("presses a global key (no selector) and journals the key name", async () => {
		const { service, journal, pages } = makeHarness();
		await service.create({ name: "a" });
		const out = await service.act({ name: "a", snapshotVersion: 0, action: "pressKey", key: "Enter" });
		expect(out.snapshotVersion).toBe(0);
		expect(pages[0]!.pressKeyCalls).toEqual([{ key: "Enter", selector: undefined, timeoutMs: undefined }]);
		expect(journal.entries[0]).toMatchObject({ action: "pressKey", outcome: "ok", target: "Enter" });
	});

	test("presses a key scoped to a selector", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		await service.act({ name: "a", snapshotVersion: 0, action: "pressKey", key: "Escape", selector: "#modal" });
		expect(pages[0]!.pressKeyCalls[0]).toEqual({ key: "Escape", selector: "#modal", timeoutMs: undefined });
	});

	test("requires a key", async () => {
		const { service, pages } = makeHarness();
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "pressKey" })).rejects.toThrow(/key is required/);
		expect(pages).toHaveLength(0);
	});

	test("a page-level failure is journaled and rethrown", async () => {
		const { service, journal } = makeHarness((i) => (i === 0 ? { failPressKey: true } : {}));
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "pressKey", key: "Enter" })).rejects.toThrow(/simulated pressKey failure/);
		expect(journal.entries[0]).toMatchObject({ outcome: "error" });
	});
});

describe("SessionService — act: consoleMessages (does not bump snapshotVersion)", () => {
	test("returns already-captured console messages and journals a fixed placeholder", async () => {
		const record = { type: "error", text: "boom", timestamp: 1_000 };
		const { service, journal, pages } = makeHarness((i) => (i === 0 ? { consoleMessagesResult: [record] } : {}));
		await service.create({ name: "a" });
		const out = await service.act({ name: "a", snapshotVersion: 0, action: "consoleMessages" });
		expect(out.result).toEqual([record]);
		expect(pages[0]!.listConsoleMessagesCallCount).toBe(1);
		expect(journal.entries[0]).toMatchObject({ action: "consoleMessages", outcome: "ok", target: "<console-messages>" });
	});

	test("a page-level failure is journaled and rethrown", async () => {
		const { service, journal } = makeHarness((i) => (i === 0 ? { failListConsoleMessages: true } : {}));
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "consoleMessages" })).rejects.toThrow(/simulated listConsoleMessages failure/);
		expect(journal.entries[0]).toMatchObject({ outcome: "error" });
	});
});

describe("SessionService — act: networkRequests (does not bump snapshotVersion)", () => {
	const apiRequest = { url: "https://x.test/api/data", method: "GET", status: 200, resourceType: "fetch" };
	const imageRequest = { url: "https://x.test/logo.png", method: "GET", status: 200, resourceType: "image" };
	const failedImageRequest = { url: "https://x.test/broken.png", method: "GET", status: 404, resourceType: "image" };

	test("excludes successful static resources by default", async () => {
		const { service, pages } = makeHarness(() => ({ networkRequestsResult: [apiRequest, imageRequest, failedImageRequest] }));
		await service.create({ name: "a" });
		const out = await service.act({ name: "a", snapshotVersion: 0, action: "networkRequests" });
		// The successful image is excluded; the API call and the *failed*
		// image (not "successful") both remain.
		expect(out.result).toEqual([apiRequest, failedImageRequest]);
	});

	test("includeStatic:true includes every request", async () => {
		const { service } = makeHarness(() => ({ networkRequestsResult: [apiRequest, imageRequest, failedImageRequest] }));
		await service.create({ name: "a" });
		const out = await service.act({ name: "a", snapshotVersion: 0, action: "networkRequests", includeStatic: true });
		expect(out.result).toEqual([apiRequest, imageRequest, failedImageRequest]);
	});

	test("journals a fixed placeholder", async () => {
		const { service, journal } = makeHarness();
		await service.create({ name: "a" });
		await service.act({ name: "a", snapshotVersion: 0, action: "networkRequests" });
		expect(journal.entries[0]).toMatchObject({ action: "networkRequests", outcome: "ok", target: "<network-requests>" });
	});

	test("a page-level failure is journaled and rethrown", async () => {
		const { service, journal } = makeHarness((i) => (i === 0 ? { failListNetworkRequests: true } : {}));
		await service.create({ name: "a" });
		await expect(service.act({ name: "a", snapshotVersion: 0, action: "networkRequests" })).rejects.toThrow(/simulated listNetworkRequests failure/);
		expect(journal.entries[0]).toMatchObject({ outcome: "error" });
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
