import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	buildUsageTableRows,
	parseUsageCommandArgs,
	runUsageCommand,
	type SearchEngineUsageEntry,
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

const ENTRIES: SearchEngineUsageEntry[] = [
	{ engine: "tavily", observedAt: Date.UTC(2026, 0, 1), credits: 3 },
	{ engine: "exa", observedAt: Date.UTC(2026, 0, 2), costUsd: 0.012 },
	{ engine: "brave", observedAt: Date.UTC(2026, 0, 3), rateLimitHeaders: { "x-ratelimit-remaining": "10" } },
];

describe("buildUsageTableRows", () => {
	it("formats every field as a table-ready string, blank when absent", () => {
		expect(buildUsageTableRows(ENTRIES)).toEqual([
			{ engine: "tavily", observedAt: "2026-01-01T00:00:00.000Z", credits: "3", costUsd: "", rateLimitHeaders: "" },
			{ engine: "exa", observedAt: "2026-01-02T00:00:00.000Z", credits: "", costUsd: "0.0120", rateLimitHeaders: "" },
			{
				engine: "brave",
				observedAt: "2026-01-03T00:00:00.000Z",
				credits: "",
				costUsd: "",
				rateLimitHeaders: '{"x-ratelimit-remaining":"10"}',
			},
		]);
	});

	it("returns an empty array for no entries", () => {
		expect(buildUsageTableRows([])).toEqual([]);
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
		expect(notified[0]).toContain("usage: /websearch-usage");
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

	it("tui mode opens the panel with table-ready rows and a count/engine-aware title", async () => {
		const ctx = fakeContext();
		let seenRows: Record<string, string>[] | undefined;
		let seenTitle: string | undefined;

		await runUsageCommand(ctx, "tavily", {
			fetchUsage: async () => ({ entries: [ENTRIES[0] as SearchEngineUsageEntry] }),
			showPanel: async (_ctx, rows, title) => {
				seenRows = rows;
				seenTitle = title;
			},
		});

		expect(seenRows).toEqual(buildUsageTableRows([ENTRIES[0] as SearchEngineUsageEntry]));
		expect(seenTitle).toBe("Search provider usage \u2014 1 entry (tavily)");
	});
});
