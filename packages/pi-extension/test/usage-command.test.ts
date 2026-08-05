import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	buildUsageChartData,
	parseUsageCommandArgs,
	runUsageCommand,
	type SearchEngineUsageEntry,
	usageBucketSizeMs,
} from "../src/usage-command.js";

function fakeContext(overrides: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
	return {
		mode: "tui",
		hasUI: true,
		ui: { notify: () => {}, custom: async () => undefined },
		...overrides,
	} as unknown as ExtensionCommandContext;
}

describe("parseUsageCommandArgs", () => {
	it("returns an empty parse for no arguments", () => {
		expect(parseUsageCommandArgs("")).toEqual({ engine: undefined, limit: undefined });
	});

	it("takes a bare token as the engine filter", () => {
		expect(parseUsageCommandArgs("brave")).toEqual({ engine: "brave", limit: undefined });
	});

	it("parses --limit as a number", () => {
		expect(parseUsageCommandArgs("--limit 5")).toEqual({ engine: undefined, limit: 5 });
	});

	it("parses engine and --limit together, in either order", () => {
		expect(parseUsageCommandArgs("brave --limit 5")).toEqual({ engine: "brave", limit: 5 });
		expect(parseUsageCommandArgs("--limit 5 brave")).toEqual({ engine: "brave", limit: 5 });
	});

	it("returns undefined for a non-numeric --limit", () => {
		expect(parseUsageCommandArgs("--limit abc")).toBeUndefined();
	});

	it("returns undefined for a --limit with no value", () => {
		expect(parseUsageCommandArgs("--limit")).toBeUndefined();
	});
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ENTRIES: SearchEngineUsageEntry[] = [
	{ engine: "tavily", observedAt: Date.UTC(2026, 0, 1, 0), credits: 3 },
	{ engine: "exa", observedAt: Date.UTC(2026, 0, 1, 1), costUsd: 0.012 },
	{ engine: "brave", observedAt: Date.UTC(2026, 0, 1, 2), rateLimitHeaders: { "x-ratelimit-remaining": "10" } },
];

describe("usageBucketSizeMs", () => {
	it("buckets hourly for fewer than 2 entries", () => {
		expect(usageBucketSizeMs([])).toBe(HOUR);
		expect(usageBucketSizeMs([ENTRIES[0] as SearchEngineUsageEntry])).toBe(HOUR);
	});

	it("buckets hourly when the fetched entries span 48h or less", () => {
		expect(usageBucketSizeMs(ENTRIES)).toBe(HOUR);
	});

	it("buckets daily once the fetched entries span more than 48h", () => {
		const wide = [ENTRIES[0] as SearchEngineUsageEntry, { engine: "exa", observedAt: Date.UTC(2026, 0, 10), costUsd: 1 }];
		expect(usageBucketSizeMs(wide)).toBe(DAY);
	});
});

describe("buildUsageChartData", () => {
	it("returns no buckets/series for no entries", () => {
		expect(buildUsageChartData([], "calls")).toEqual({ buckets: [], series: [] });
	});

	it("one series per distinct engine, sorted", () => {
		const { series } = buildUsageChartData(ENTRIES, "calls");
		expect(series).toEqual([
			{ key: "brave", label: "brave" },
			{ key: "exa", label: "exa" },
			{ key: "tavily", label: "tavily" },
		]);
	});

	it("calls metric counts every entry regardless of what it reports", () => {
		const { buckets } = buildUsageChartData(ENTRIES, "calls");
		const totalCalls = buckets.reduce((sum, bucket) => sum + bucket.total, 0);
		expect(totalCalls).toBe(3);
	});

	it("credits/cost metrics only count entries that actually report that field", () => {
		const credits = buildUsageChartData(ENTRIES, "credits");
		expect(credits.buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(3);
		const cost = buildUsageChartData(ENTRIES, "cost");
		expect(cost.buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBeCloseTo(0.012);
	});

	it("stacks each bucket's per-engine values under that engine's series key", () => {
		const { buckets } = buildUsageChartData(ENTRIES, "calls");
		const nonEmpty = buckets.filter((bucket) => bucket.total > 0);
		const engines = new Set(nonEmpty.flatMap((bucket) => Object.keys(bucket.series)));
		expect(engines).toEqual(new Set(["tavily", "exa", "brave"]));
	});
});

describe("runUsageCommand", () => {
	it("notifies and returns without fetching on a malformed --limit", async () => {
		const notified: string[] = [];
		const ctx = fakeContext({ ui: { notify: (msg: string) => notified.push(msg) } as never });
		let fetched = false;

		await runUsageCommand(ctx, "--limit abc", {
			fetchUsage: async () => {
				fetched = true;
				return { entries: [] };
			},
		});

		expect(fetched).toBe(false);
		expect(notified[0]).toContain("usage: /web ");
	});

	it("notifies when there is no usage recorded yet, without opening a panel", async () => {
		const notified: string[] = [];
		const ctx = fakeContext({ ui: { notify: (msg: string) => notified.push(msg) } as never });
		let panelOpened = false;

		await runUsageCommand(ctx, "", {
			fetchUsage: async () => ({ entries: [] }),
			showPanel: async () => {
				panelOpened = true;
			},
		});

		expect(panelOpened).toBe(false);
		expect(notified[0]).toContain("No search usage recorded yet");
	});

	it("forwards the parsed engine/limit to fetchUsage", async () => {
		const seen: unknown[] = [];
		const ctx = fakeContext();

		await runUsageCommand(ctx, "tavily --limit 5", {
			fetchUsage: async (input) => {
				seen.push(input);
				return { entries: [] };
			},
		});

		expect(seen).toEqual([{ engine: "tavily", limit: 5 }]);
	});

	it("a non-tui mode gets a plain notify() summary instead of opening a panel", async () => {
		const notified: string[] = [];
		const ctx = fakeContext({ mode: "print", ui: { notify: (msg: string) => notified.push(msg) } as never });
		let panelOpened = false;

		await runUsageCommand(ctx, "", {
			fetchUsage: async () => ({ entries: ENTRIES }),
			showPanel: async () => {
				panelOpened = true;
			},
		});

		expect(panelOpened).toBe(false);
		expect(notified[0]).toContain("3 entries");
		expect(notified[0]).toContain("tavily@2026-01-01T00:00:00.000Z");
	});

	it("tui mode opens the panel with the raw entries and a count/engine-aware title", async () => {
		const ctx = fakeContext();
		let seenEntries: readonly SearchEngineUsageEntry[] | undefined;
		let seenTitle: string | undefined;

		await runUsageCommand(ctx, "tavily", {
			fetchUsage: async () => ({ entries: [ENTRIES[0] as SearchEngineUsageEntry] }),
			showPanel: async (_ctx, entries, title) => {
				seenEntries = entries;
				seenTitle = title;
			},
		});

		expect(seenEntries).toEqual([ENTRIES[0]]);
		expect(seenTitle).toBe("Search provider usage \u2014 1 entry (tavily)");
	});
});
