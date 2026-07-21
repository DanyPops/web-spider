import { describe, expect, test } from "bun:test";
import { defaultBrowserLauncher, PlaywrightSessionRegistry } from "../src/adapters/playwright-session-registry.ts";
import {
	checkLayout,
	checkLayoutConsistency,
	measureElements,
	SelectorNotFoundError,
	type ElementMeasurement,
} from "../src/layout-check.ts";

function measurement(selector: string, overrides: Partial<ElementMeasurement> = {}): ElementMeasurement {
	return {
		selector,
		box: { top: 0, left: 0, width: 100, height: 50 },
		padding: { top: 8, right: 8, bottom: 8, left: 16 },
		...overrides,
	};
}

describe("checkLayoutConsistency — pure, no browser", () => {
	test("reports consistent:true when every measurement agrees within tolerance", () => {
		const measurements = [measurement("#a"), measurement("#b"), measurement("#c")];
		const result = checkLayoutConsistency(measurements, ["paddingLeft", "paddingTop"]);
		expect(result).toEqual({ consistent: true, mismatches: [] });
	});

	test("reports the actual disagreeing pixel values for a mismatched property, reproducing the message-bubble vs tool-call-card bug shape", () => {
		const messageBubble = measurement(".message-bubble", { padding: { top: 16, right: 16, bottom: 16, left: 16 } });
		const toolCallCard = measurement(".tool-call-card", { padding: { top: 8, right: 8, bottom: 8, left: 8 } });
		const result = checkLayoutConsistency([messageBubble, toolCallCard], ["paddingLeft"]);
		expect(result.consistent).toBe(false);
		expect(result.mismatches).toEqual([{
			property: "paddingLeft",
			values: [{ selector: ".message-bubble", value: 16 }, { selector: ".tool-call-card", value: 8 }],
			deltaPx: 8,
		}]);
	});

	test("only reports mismatches for the properties actually requested, not every property", () => {
		const a = measurement("#a", { box: { top: 0, left: 0, width: 100, height: 50 } });
		const b = measurement("#b", { box: { top: 0, left: 0, width: 999, height: 50 } }); // width disagrees, top/left don't
		const result = checkLayoutConsistency([a, b], ["top", "left"]);
		expect(result.consistent).toBe(true);
	});

	test("respects a wider tolerance for small, likely-insignificant differences", () => {
		const a = measurement("#a", { box: { top: 0, left: 10, width: 100, height: 50 } });
		const b = measurement("#b", { box: { top: 0, left: 11, width: 100, height: 50 } }); // 1px off — sub-pixel rendering noise
		expect(checkLayoutConsistency([a, b], ["left"], 1).consistent).toBe(true);
		expect(checkLayoutConsistency([a, b], ["left"], 0).consistent).toBe(false);
	});
});

describe("measureElements / checkLayout — real browser, real rendered geometry", () => {
	async function withPage<T>(html: string, run: (page: Awaited<ReturnType<PlaywrightSessionRegistry["page"]>>) => Promise<T>): Promise<T> {
		const registry = new PlaywrightSessionRegistry({ launcher: defaultBrowserLauncher(), maxConcurrent: 1 });
		await registry.create("layout-check-e2e");
		try {
			const page = await registry.page("layout-check-e2e");
			await page.goto(`data:text/html,${encodeURIComponent(html)}`);
			return await run(page);
		} finally {
			await registry.close("layout-check-e2e");
		}
	}

	test("passing case: two sibling cards with identical padding measure as consistent", async () => {
		const html = `<!DOCTYPE html><html><body>
			<div class="card" id="a" style="padding: 16px; width: 200px;">A</div>
			<div class="card" id="b" style="padding: 16px; width: 200px;">B</div>
		</body></html>`;
		await withPage(html, async (page) => {
			const result = await checkLayout(page, { selectors: ["#a", "#b"], properties: ["paddingLeft", "paddingTop", "left"] });
			expect(result.consistent).toBe(true);
			expect(result.mismatches).toEqual([]);
		});
	}, 30_000);

	test("failing case: reproduces the real agent-deck bug — message bubble (16px padding) vs tool-call card (8px padding)", async () => {
		const html = `<!DOCTYPE html><html><body>
			<div class="message-bubble" id="bubble" style="padding: 16px; width: 200px;">Hello</div>
			<div class="tool-call-card" id="tool" style="padding: 8px; width: 200px;">web_fetch(...)</div>
		</body></html>`;
		await withPage(html, async (page) => {
			const result = await checkLayout(page, {
				selectors: ["#bubble", "#tool"],
				properties: ["paddingLeft", "paddingTop", "paddingRight", "paddingBottom"],
			});
			expect(result.consistent).toBe(false);
			// All four padding sides disagree by exactly 8px — the real, actionable
			// pixel values a human/agent needs to fix the bug, not just "it failed".
			for (const mismatch of result.mismatches) {
				expect(mismatch.deltaPx).toBe(8);
				expect(mismatch.values).toEqual([
					{ selector: "#bubble", value: 16 },
					{ selector: "#tool", value: 8 },
				]);
			}
			expect(result.mismatches.map((m) => m.property).sort()).toEqual(["paddingBottom", "paddingLeft", "paddingRight", "paddingTop"]);
		});
	}, 30_000);

	test("measureElements throws SelectorNotFoundError listing every selector that matched nothing, rather than silently comparing partial data", async () => {
		const html = `<!DOCTYPE html><html><body><div id="real">x</div></body></html>`;
		await withPage(html, async (page) => {
			await expect(measureElements(page, ["#real", "#ghost-1", "#ghost-2"])).rejects.toThrow(SelectorNotFoundError);
			await expect(measureElements(page, ["#ghost-1", "#ghost-2"])).rejects.toThrow(/#ghost-1, #ghost-2/);
		});
	}, 30_000);

	test("box geometry reflects real layout — a right-shifted sibling measures a different left, not zero/undefined", async () => {
		const html = `<!DOCTYPE html><html><body>
			<div id="left-card" style="position: absolute; left: 0px; top: 0px; width: 100px; padding: 4px;">L</div>
			<div id="right-card" style="position: absolute; left: 300px; top: 0px; width: 100px; padding: 4px;">R</div>
		</body></html>`;
		await withPage(html, async (page) => {
			const measurements = await measureElements(page, ["#left-card", "#right-card"]);
			expect(measurements[0]!.box.left).toBeCloseTo(0, 0);
			expect(measurements[1]!.box.left).toBeCloseTo(300, 0);
			const result = checkLayoutConsistency(measurements, ["left"]);
			expect(result.consistent).toBe(false);
			expect(result.mismatches[0]!.deltaPx).toBeCloseTo(300, 0);
		});
	}, 30_000);
});
