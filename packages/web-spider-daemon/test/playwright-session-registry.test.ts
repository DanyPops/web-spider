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
});
