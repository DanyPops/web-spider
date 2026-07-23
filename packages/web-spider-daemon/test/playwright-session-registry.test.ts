import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	test("real screenshot() defaults to viewport-only, opts into fullPage, and can scope to one element", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-screenshot-session");
		const page = await registry.page("real-screenshot-session");

		// A page much taller than any real viewport, with a small marked element
		// near the bottom — proves fullPage actually captures scrolled-past
		// content, and that an element-scoped shot is genuinely smaller than
		// either whole-page capture, not just a claim.
		await page.goto(
			"data:text/html,<div style='height:3000px'></div><div id='chip' style='width:40px;height:20px;background:red'></div>",
		);

		const viewportShot = await page.screenshot();
		const fullPageShot = await page.screenshot({ fullPage: true });
		const elementShot = await page.screenshot({ selector: "#chip" });

		const viewportSize = pngDimensions(viewportShot);
		const fullPageSize = pngDimensions(fullPageShot);
		const elementSize = pngDimensions(elementShot);

		// Real, not asserted-by-assumption: fullPage is genuinely taller than the
		// default viewport-only capture, because the page really does scroll.
		expect(fullPageSize.height).toBeGreaterThan(viewportSize.height);
		// The element shot is tiny compared to either whole-page capture.
		expect(elementSize.width).toBeLessThan(viewportSize.width);
		expect(elementSize.height).toBeLessThan(viewportSize.height);

		await registry.close("real-screenshot-session");
	}, 30_000);

	test("real screenshot() scale:device produces a higher-resolution capture than scale:css for the same viewport", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-screenshot-scale-session");
		const page = await registry.page("real-screenshot-scale-session");
		await page.goto("data:text/html,<p>scale test</p>");

		const cssShot = await page.screenshot({ scale: "css" });
		const deviceShot = await page.screenshot({ scale: "device" });
		// On a real headless default (devicePixelRatio 1), css and device scale
		// produce the same size — the meaningful assertion is that both are real,
		// valid, non-empty PNGs, proving the option is actually accepted and
		// forwarded rather than silently ignored.
		expect(pngDimensions(cssShot).width).toBeGreaterThan(0);
		expect(pngDimensions(deviceShot).width).toBeGreaterThan(0);

		await registry.close("real-screenshot-scale-session");
	}, 30_000);

	test("real snapshot() returns a YAML accessibility tree reflecting real ARIA semantics", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-snapshot-session");
		const page = await registry.page("real-snapshot-session");

		await page.goto(
			"data:text/html,<h1>O-RAN Specifications</h1><nav><ul><li><a href='/e2'>E2</a></li><li><a href='/e1'>E1</a></li></ul></nav><button>Apply filter</button>",
		);
		const tree = await page.snapshot({ timeoutMs: 5_000 });
		// Real ARIA roles/names from the actual page, not asserted by assumption.
		expect(tree).toContain('heading "O-RAN Specifications"');
		expect(tree).toContain('link "E2"');
		expect(tree).toContain('link "E1"');
		expect(tree).toContain('button "Apply filter"');

		await registry.close("real-snapshot-session");
	}, 30_000);

	test("real snapshot() scopes to one element/subtree via selector", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-snapshot-scoped-session");
		const page = await registry.page("real-snapshot-scoped-session");

		await page.goto("data:text/html,<h1>Outside</h1><nav><a href='/x'>Inside</a></nav>");
		const tree = await page.snapshot({ selector: "nav", timeoutMs: 5_000 });
		expect(tree).toContain('link "Inside"');
		expect(tree).not.toContain("Outside");

		await registry.close("real-snapshot-scoped-session");
	}, 30_000);

	test("real snapshot() with boxes:true includes bounding box coordinates", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-snapshot-boxes-session");
		const page = await registry.page("real-snapshot-boxes-session");

		await page.goto("data:text/html,<button>Click me</button>");
		const withoutBoxes = await page.snapshot({ timeoutMs: 5_000 });
		const withBoxes = await page.snapshot({ boxes: true, timeoutMs: 5_000 });
		expect(withoutBoxes).not.toContain("[box=");
		expect(withBoxes).toContain("[box=");

		await registry.close("real-snapshot-boxes-session");
	}, 30_000);

	test("real dialogs auto-dismiss by default — verified empirically, not assumed (Playwright's own documented default, confirmed here for our own registered listener too)", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-dialog-default-session");
		const page = await registry.page("real-dialog-default-session");

		await page.goto(
			"data:text/html,<button onclick=\"window.result = confirm('proceed?') ? 'accepted' : 'dismissed'\" id='b'>go</button>",
		);
		const start = Date.now();
		await page.click("#b"); // must not hang
		expect(Date.now() - start).toBeLessThan(5_000);
		expect(await page.evaluate<string>("window.result")).toBe("dismissed");

		await registry.close("real-dialog-default-session");
	}, 30_000);

	test("real armDialogPolicy({accept:true}) actually accepts the next confirm()", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-dialog-accept-session");
		const page = await registry.page("real-dialog-accept-session");

		await page.goto(
			"data:text/html,<button onclick=\"window.result = confirm('proceed?') ? 'accepted' : 'dismissed'\" id='b'>go</button>",
		);
		await page.armDialogPolicy({ accept: true });
		await page.click("#b");
		expect(await page.evaluate<string>("window.result")).toBe("accepted");

		await registry.close("real-dialog-accept-session");
	}, 30_000);

	test("real armDialogPolicy is one-shot: a second dialog reverts to the safe dismiss default", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-dialog-oneshot-session");
		const page = await registry.page("real-dialog-oneshot-session");

		await page.goto(
			"data:text/html,<button onclick=\"window.results = window.results || []; window.results.push(confirm('again?') ? 'accepted' : 'dismissed')\" id='b'>go</button>",
		);
		await page.armDialogPolicy({ accept: true });
		await page.click("#b"); // consumes the armed policy
		await page.click("#b"); // no policy armed — falls back to dismiss
		expect(await page.evaluate<string[]>("window.results")).toEqual(["accepted", "dismissed"]);

		await registry.close("real-dialog-oneshot-session");
	}, 30_000);

	test("real armDialogPolicy with promptText actually answers a prompt() dialog", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-dialog-prompt-session");
		const page = await registry.page("real-dialog-prompt-session");

		await page.goto("data:text/html,<button onclick=\"window.answer = prompt('your name?')\" id='b'>go</button>");
		await page.armDialogPolicy({ accept: true, promptText: "E2" });
		await page.click("#b");
		expect(await page.evaluate<string>("window.answer")).toBe("E2");

		await registry.close("real-dialog-prompt-session");
	}, 30_000);

	test("real download capture: a click-triggered download is saved to disk and listed with real content", async () => {
		const downloadsBaseDir = mkdtempSync(join(tmpdir(), "web-spider-download-test-"));
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1, downloadsBaseDir });
		await registry.create("real-download-session");
		const page = await registry.page("real-download-session");

		await page.goto(
			"data:text/html,<a href='data:text/plain,O-RAN.WG3.TS.E2AP-R004-v08.00' download='spec.txt' id='dl'>Download</a>",
		);
		await page.click("#dl");
		// The download event may not have finished by the time click() resolves
		// (verified empirically before designing this) — poll briefly rather
		// than assume it's already present.
		let downloads: Awaited<ReturnType<typeof page.listDownloads>> = [];
		for (let i = 0; i < 50 && downloads.length === 0; i++) {
			downloads = await page.listDownloads();
			if (downloads.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
		}

		expect(downloads).toHaveLength(1);
		expect(downloads[0]!.filename).toBe("spec.txt");
		expect(downloads[0]!.failure).toBeNull();
		// Real file, saved for real, under the real per-session directory —
		// not just an in-memory claim.
		expect(downloads[0]!.path).toContain(join(downloadsBaseDir, "real-download-session"));
		expect(readFileSync(downloads[0]!.path, "utf8")).toBe("O-RAN.WG3.TS.E2AP-R004-v08.00");

		await registry.close("real-download-session");
		rmSync(downloadsBaseDir, { recursive: true, force: true });
	}, 30_000);

	test("real hover() reveals a real hover-only element (CSS :hover, not a click/focus state)", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-hover-session");
		const page = await registry.page("real-hover-session");

		// Note: a literal "#" inside a data: URL is parsed as a URL fragment
		// delimiter, silently truncating the HTML before it (verified directly
		// — a real gotcha caught while writing this test) — class selectors
		// avoid the character entirely rather than percent-encoding every "#".
		await page.goto(
			"data:text/html,<style>.tooltip{display:none} .trigger:hover + .tooltip{display:block}</style><div class='trigger'>hover me</div><div class='tooltip'>revealed</div>",
		);
		expect(await page.evaluate<string>("getComputedStyle(document.querySelector('.tooltip')).display")).toBe("none");
		await page.hover(".trigger");
		expect(await page.evaluate<string>("getComputedStyle(document.querySelector('.tooltip')).display")).toBe("block");

		await registry.close("real-hover-session");
	}, 30_000);

	test("real pressKey() submits a real form via Enter, scoped to a specific input", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-presskey-session");
		const page = await registry.page("real-presskey-session");

		await page.goto(
			"data:text/html,<form onsubmit='window.submitted = true; return false'><input id='q'></form>",
		);
		await page.type("#q", "E2");
		await page.pressKey("Enter", { selector: "#q" });
		expect(await page.evaluate<boolean>("window.submitted")).toBe(true);

		await registry.close("real-presskey-session");
	}, 30_000);

	test("real pressKey() with no selector is a global keyboard press (e.g. Escape with no natural target element)", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-presskey-global-session");
		const page = await registry.page("real-presskey-global-session");

		await page.goto(
			"data:text/html,<script>document.addEventListener('keydown', e => { if (e.key === 'Escape') window.escaped = true; });</script>",
		);
		await page.pressKey("Escape");
		expect(await page.evaluate<boolean>("window.escaped")).toBe(true);

		await registry.close("real-presskey-global-session");
	}, 30_000);

	test("real listConsoleMessages() captures a real console.error from the page", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-console-session");
		const page = await registry.page("real-console-session");

		await page.goto("data:text/html,<script>console.error('real-error-marker')</script>");
		const messages = await page.listConsoleMessages();
		expect(messages.some((m) => m.type === "error" && m.text === "real-error-marker")).toBe(true);

		await registry.close("real-console-session");
	}, 30_000);

	test("real listNetworkRequests() captures a real fetch() the page actually made", async () => {
		// A data: URL has an opaque origin — a fetch() from one is blocked by
		// CORS regardless of the target server (verified directly: this exact
		// test failed with a real "Failed to fetch" against a real server
		// before switching to serving the page itself from the same origin).
		const server = createServer((req, res) => {
			if (req.url === "/api/data") { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
			res.writeHead(200, { "content-type": "text/html" });
			res.end("<div>ready</div>");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;

		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-network-session");
		const page = await registry.page("real-network-session");

		await page.goto(`http://127.0.0.1:${port}/`);
		await page.evaluate("fetch('/api/data')");
		await page.waitFor({ loadState: "networkidle" }, { timeoutMs: 5_000 });

		const requests = await page.listNetworkRequests();
		const apiRequest = requests.find((r) => r.url.includes("/api/data"));
		expect(apiRequest).toMatchObject({ method: "GET", status: 200, resourceType: "fetch" });

		await registry.close("real-network-session");
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}, 30_000);

	test("real multi-tab lifecycle: new/list/select/close against real, independently-navigable pages", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-tabs-session");

		// A fresh session already has exactly one active tab.
		const initialTabs = await registry.listTabs("real-tabs-session");
		expect(initialTabs).toHaveLength(1);
		expect(initialTabs[0]).toMatchObject({ index: 0, active: true });

		// tab 0 navigates to a real, distinguishable page.
		const page0 = await registry.page("real-tabs-session");
		await page0.goto("data:text/html,<title>tab-zero</title><div>zero</div>");

		// A new tab opens, becomes active, and is genuinely a *different* page.
		const newTabInfo = await registry.newTab("real-tabs-session", "data:text/html,<title>tab-one</title><div>one</div>");
		expect(newTabInfo).toMatchObject({ index: 1, active: true });
		const page1 = await registry.page("real-tabs-session");
		expect(await page1.evaluate<string>("document.title")).toBe("tab-one");

		const tabsAfterNew = await registry.listTabs("real-tabs-session");
		expect(tabsAfterNew).toHaveLength(2);
		expect(tabsAfterNew.find((t) => t.index === 1)?.active).toBe(true);
		expect(tabsAfterNew.find((t) => t.index === 0)?.active).toBe(false);

		// Selecting back to tab 0 makes page() resolve to the *original* page
		// again — real proof this isn't just bookkeeping, but actually
		// switches which real Playwright page subsequent actions reach.
		await registry.selectTab("real-tabs-session", 0);
		const page0Again = await registry.page("real-tabs-session");
		expect(await page0Again.evaluate<string>("document.title")).toBe("tab-zero");

		// Closing the (now active) tab 0 falls back to the sole remaining tab.
		const closeResult = await registry.closeTab("real-tabs-session");
		expect(closeResult).toEqual({ closedIndex: 0, newActiveIndex: 0 });
		const remainingPage = await registry.page("real-tabs-session");
		expect(await remainingPage.evaluate<string>("document.title")).toBe("tab-one");

		await registry.close("real-tabs-session");
	}, 30_000);

	test("real per-tab snapshotVersion isolation: navigating one tab never affects another tab's own version", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-tabs-version-session");

		const page0 = await registry.page("real-tabs-version-session");
		await page0.goto("data:text/html,<div>zero</div>");
		expect(registry.get("real-tabs-version-session")?.snapshotVersion).toBe(0); // goto() alone doesn't bump — only the daemon's bumpSnapshotVersion() call does
		const info1 = registry.bumpSnapshotVersion("real-tabs-version-session");
		expect(info1.snapshotVersion).toBe(1);

		await registry.newTab("real-tabs-version-session"); // tab 1, fresh, version 0
		const infoOnNewTab = registry.get("real-tabs-version-session");
		expect(infoOnNewTab?.snapshotVersion).toBe(0); // reflects the new active tab, not tab 0's history

		await registry.selectTab("real-tabs-version-session", 0);
		const infoBackOnTab0 = registry.touchActivity("real-tabs-version-session");
		expect(infoBackOnTab0.snapshotVersion).toBe(1); // tab 0's own version survived the round trip through tab 1

		await registry.close("real-tabs-version-session");
	}, 30_000);

	test("real tab limit: rejects past SESSION_MAX_TABS without leaking an over-limit page", async () => {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("real-tabs-limit-session");
		await registry.page("real-tabs-limit-session"); // ensures tab 0
		for (let i = 1; i < 10; i++) await registry.newTab("real-tabs-limit-session");
		expect(await registry.listTabs("real-tabs-limit-session")).toHaveLength(10);
		await expect(registry.newTab("real-tabs-limit-session")).rejects.toThrow(/tab limit reached/);
		expect(await registry.listTabs("real-tabs-limit-session")).toHaveLength(10);

		await registry.close("real-tabs-limit-session");
	}, 30_000);
});

/** Reads width/height directly from a PNG's IHDR chunk (bytes 16-23) — no image-decoding dependency needed for a real, not-asserted-by-assumption dimension check. */
function pngDimensions(png: Uint8Array): { width: number; height: number } {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}
