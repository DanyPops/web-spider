import { describe, expect, test } from "bun:test";
import { defaultBrowserLauncher, PlaywrightSessionRegistry } from "../src/adapters/playwright-session-registry.ts";
import { fakeLauncher } from "./helpers/fake-session-registry.ts";

describe("PlaywrightSessionRegistry — create", () => {
	test("returns a fresh SessionInfo and forwards forceChromeChannel (default false)", async () => {
		const seenChannels: boolean[] = [];
		const { launcher } = fakeLauncher({ onLaunch: (fcc) => seenChannels.push(fcc) });
		const registry = new PlaywrightSessionRegistry({ launcher, now: () => 42 });

		const info = await registry.create("agent1");
		expect(info).toEqual({ name: "agent1", createdAt: 42, lastActivityAt: 42, snapshotVersion: 0, closed: false });
		expect(seenChannels).toEqual([false]);
	});

	test("forwards forceChromeChannel:true when the caller opts in", async () => {
		const seenChannels: boolean[] = [];
		const { launcher } = fakeLauncher({ onLaunch: (fcc) => seenChannels.push(fcc) });
		const registry = new PlaywrightSessionRegistry({ launcher });

		await registry.create("agent1", { forceChromeChannel: true });
		expect(seenChannels).toEqual([true]);
	});

	test("rejects an invalid name without ever calling the launcher", async () => {
		let calls = 0;
		const { launcher } = fakeLauncher({ onLaunch: () => { calls++; } });
		const registry = new PlaywrightSessionRegistry({ launcher });

		await expect(registry.create("../etc/passwd")).rejects.toThrow(/invalid session name/);
		expect(calls).toBe(0);
	});

	test("rejects a duplicate name without launching a second browser", async () => {
		const { launcher, launched } = fakeLauncher();
		const registry = new PlaywrightSessionRegistry({ launcher });

		await registry.create("agent1");
		await expect(registry.create("agent1")).rejects.toThrow(/already exists/);
		expect(launched).toHaveLength(1);
	});

	test("enforces the concurrent-session ceiling and rejects past it", async () => {
		const { launcher, launched } = fakeLauncher();
		const registry = new PlaywrightSessionRegistry({ launcher, maxConcurrent: 2 });

		await registry.create("a");
		await registry.create("b");
		await expect(registry.create("c")).rejects.toThrow(/session limit reached/);
		expect(launched).toHaveLength(2);
	});

	test("closing a session frees a ceiling slot for a new create()", async () => {
		const { launcher } = fakeLauncher();
		const registry = new PlaywrightSessionRegistry({ launcher, maxConcurrent: 1 });

		await registry.create("a");
		await expect(registry.create("b")).rejects.toThrow(/session limit reached/);
		await registry.close("a");
		await expect(registry.create("b")).resolves.toBeDefined();
	});

	test("two concurrent create() calls for the same name: exactly one wins, only one browser is launched", async () => {
		const { launcher, launched } = fakeLauncher({ delayMs: 20 });
		const registry = new PlaywrightSessionRegistry({ launcher });

		const results = await Promise.allSettled([registry.create("race"), registry.create("race")]);
		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already exists/);
		expect(launched).toHaveLength(1);
		expect(registry.list()).toHaveLength(1);
	});

	test("a race against the ceiling never overshoots it", async () => {
		const { launcher, launched } = fakeLauncher({ delayMs: 20 });
		const registry = new PlaywrightSessionRegistry({ launcher, maxConcurrent: 1 });

		const results = await Promise.allSettled([registry.create("a"), registry.create("b")]);
		const fulfilled = results.filter((r) => r.status === "fulfilled");
		expect(fulfilled).toHaveLength(1);
		expect(launched).toHaveLength(1);
	});
});

describe("PlaywrightSessionRegistry — list / get", () => {
	test("list() returns every live session; get() finds one by name and is undefined for unknown", async () => {
		const { launcher } = fakeLauncher();
		const registry = new PlaywrightSessionRegistry({ launcher });

		await registry.create("a");
		await registry.create("b");
		expect(registry.list().map((s) => s.name).sort()).toEqual(["a", "b"]);
		expect(registry.get("a")?.name).toBe("a");
		expect(registry.get("does-not-exist")).toBeUndefined();
	});
});

describe("PlaywrightSessionRegistry — close / closeAll", () => {
	test("close() tears the session down and removes it from list()/get()", async () => {
		const { launcher, launched } = fakeLauncher();
		const registry = new PlaywrightSessionRegistry({ launcher });

		await registry.create("a");
		await registry.close("a");
		expect(registry.list()).toHaveLength(0);
		expect(registry.get("a")).toBeUndefined();
		expect(launched).toHaveLength(1);
	});

	test("closing an unknown session throws a clear error", async () => {
		const { launcher } = fakeLauncher();
		const registry = new PlaywrightSessionRegistry({ launcher });
		await expect(registry.close("ghost")).rejects.toThrow(/no such session/);
	});

	test("closing an already-closed session throws (it is removed on first close, not left in a closed state)", async () => {
		const { launcher } = fakeLauncher();
		const registry = new PlaywrightSessionRegistry({ launcher });
		await registry.create("a");
		await registry.close("a");
		await expect(registry.close("a")).rejects.toThrow(/no such session/);
	});

	test("close() still removes the session from the registry even if the underlying browser.close() rejects", async () => {
		const { launcher } = fakeLauncher({ failClose: true });
		const registry = new PlaywrightSessionRegistry({ launcher });
		await registry.create("a");
		await expect(registry.close("a")).rejects.toThrow(/simulated close failure/);
		expect(registry.list()).toHaveLength(0);
	});

	test("closeAll() tears every session down and never throws, even when some closes fail", async () => {
		const { launcher } = fakeLauncher({ failClose: true });
		const registry = new PlaywrightSessionRegistry({ launcher });
		await registry.create("a");
		await registry.create("b");
		await expect(registry.closeAll()).resolves.toBeUndefined();
		expect(registry.list()).toHaveLength(0);
	});
});

describe("defaultBrowserLauncher — real Playwright integration (walking skeleton)", () => {
	test("actually launches and closes a real, isolated chromium-headless-shell process end to end", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		const info = await registry.create("real-session");
		expect(info.name).toBe("real-session");
		expect(registry.list()).toHaveLength(1);
		await registry.close("real-session");
		expect(registry.list()).toHaveLength(0);
	}, 30_000);

	test("registry.page() returns the same persistent real page across calls, and can navigate/click/eval/screenshot", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-page-session");
		const page1 = await registry.page("real-page-session");
		const page2 = await registry.page("real-page-session");
		expect(page2).toBe(page1);

		await page1.goto("data:text/html,<button id='b'>click me</button>");
		await page1.click("#b");
		const title = await page1.evaluate<string>("document.querySelector('#b').textContent");
		expect(title).toBe("click me");
		const png = await page1.screenshot();
		expect(png.length).toBeGreaterThan(0);

		await registry.close("real-page-session");
	}, 30_000);

	test("real type() drives an actual input's value via per-key keyboard events (real page, not a synthetic dispatchEvent)", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-type-session");
		const page = await registry.page("real-type-session");

		// A framework-style input: only updates its own "model" div in response to
		// a real keyup event, exactly the shape a directly-set .value + a single
		// synthetic dispatchEvent does not reliably satisfy (the real gap that
		// motivated this task).
		await page.goto(
			"data:text/html,<input id='q'><div id='model'></div><script>document.getElementById('q').addEventListener('keyup', e => { document.getElementById('model').textContent = e.target.value; });</script>",
		);
		await page.type("#q", "E2");
		const modelValue = await page.evaluate<string>("document.querySelector('#model').textContent");
		expect(modelValue).toBe("E2");

		await registry.close("real-type-session");
	}, 30_000);

	test("real type() with clear:false appends rather than replacing existing content", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-type-append-session");
		const page = await registry.page("real-type-append-session");

		await page.goto("data:text/html,<input id='q' value='pre-'>");
		await page.type("#q", "fix", { clear: false });
		const value = await page.evaluate<string>("document.querySelector('#q').value");
		expect(value).toBe("pre-fix");

		await registry.close("real-type-append-session");
	}, 30_000);

	test("real select() picks a <select> option by value and by label", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-select-session");
		const page = await registry.page("real-select-session");

		await page.goto(
			"data:text/html,<select id='wg'><option value=''>-all-</option><option value='wg3'>WG3: Near-real-time RIC and E2 Interface Workgroup</option><option value='wg5'>WG5: Open F1/W1/E1/X2/Xn Interface Workgroup</option></select>",
		);
		await page.select("#wg", { value: "wg3" });
		expect(await page.evaluate<string>("document.querySelector('#wg').value")).toBe("wg3");

		await page.select("#wg", { label: "WG5: Open F1/W1/E1/X2/Xn Interface Workgroup" });
		expect(await page.evaluate<string>("document.querySelector('#wg').value")).toBe("wg5");

		await registry.close("real-select-session");
	}, 30_000);

	test("real waitFor() waits on a selector that appears asynchronously (replaces a blind sleep)", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-waitfor-selector-session");
		const page = await registry.page("real-waitfor-selector-session");

		// The element does not exist at load; a script inserts it after a delay.
		// A blind sleep shorter than the delay would miss it — waitFor must not.
		await page.goto(
			"data:text/html,<div id='root'></div><script>setTimeout(() => { const d = document.createElement('div'); d.id = 'late'; d.textContent = 'arrived'; document.getElementById('root').appendChild(d); }, 200);</script>",
		);
		await page.waitFor({ selector: "#late" }, { timeoutMs: 5_000 });
		expect(await page.evaluate<string>("document.querySelector('#late').textContent")).toBe("arrived");

		await registry.close("real-waitfor-selector-session");
	}, 30_000);

	test("real waitFor() times out (bounded, not unbounded) when the condition never becomes true", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-waitfor-timeout-session");
		const page = await registry.page("real-waitfor-timeout-session");

		await page.goto("data:text/html,<div id='root'></div>");
		await expect(page.waitFor({ selector: "#never-appears" }, { timeoutMs: 300 })).rejects.toThrow();

		await registry.close("real-waitfor-timeout-session");
	}, 30_000);

	test("real waitFor() waits on visible text without a caller-supplied selector", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-waitfor-text-session");
		const page = await registry.page("real-waitfor-text-session");

		await page.goto(
			"data:text/html,<div id='root'></div><script>setTimeout(() => { document.getElementById('root').textContent = 'WG3: Near-real-time RIC and E2 Interface Workgroup'; }, 200);</script>",
		);
		await page.waitFor({ text: "Near-real-time RIC" }, { timeoutMs: 5_000 });

		await registry.close("real-waitfor-text-session");
	}, 30_000);

	test("real waitFor() waits on a load state (domcontentloaded resolves immediately for an already-loaded page)", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-waitfor-loadstate-session");
		const page = await registry.page("real-waitfor-loadstate-session");

		await page.goto("data:text/html,<p>ready</p>");
		await page.waitFor({ loadState: "domcontentloaded" }, { timeoutMs: 5_000 });

		await registry.close("real-waitfor-loadstate-session");
	}, 30_000);

	test("real queryText() returns trimmed text per matched element, in document order", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-querytext-session");
		const page = await registry.page("real-querytext-session");

		await page.goto("data:text/html,<ul><li>  E2 Application Protocol  </li><li>E2SM-KPM</li><li>E2SM-RC</li></ul>");
		const texts = await page.queryText("li");
		expect(texts).toEqual(["E2 Application Protocol", "E2SM-KPM", "E2SM-RC"]);

		await registry.close("real-querytext-session");
	}, 30_000);

	test("real readTable() returns structured rows/cells, excluding a nested table's own rows", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-readtable-session");
		const page = await registry.page("real-readtable-session");

		await page.goto(
			"data:text/html,<table id='specs'><tbody>" +
				"<tr><td>O-RAN E2 Application Protocol</td><td>O-RAN.WG3.TS.E2AP-R004-v08.00</td></tr>" +
				"<tr><td>O-RAN E2SM-KPM<table><tr><td>nested-should-not-appear</td></tr></table></td><td>O-RAN.WG3.TS.E2SM-KPM-R005-v08.00</td></tr>" +
				"</tbody></table>",
		);
		const rows = await page.readTable("#specs");
		// :scope-rooting is what keeps this at 2, not 3 — without it, the nested
		// table's own <tr> would be flattened in as a third, misattributed
		// top-level row of #specs. A cell's own textContent naturally still
		// includes text nested inside it (that's correct, not a leak).
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual(["O-RAN E2 Application Protocol", "O-RAN.WG3.TS.E2AP-R004-v08.00"]);
		expect(rows[1]![0]).toContain("O-RAN E2SM-KPM");
		expect(rows[1]![1]).toBe("O-RAN.WG3.TS.E2SM-KPM-R005-v08.00");

		await registry.close("real-readtable-session");
	}, 30_000);
});
