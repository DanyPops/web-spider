/**
 * `/web`: renders the daemon's own `search.usage` operation (recent
 * per-call credits/cost/rate-limit-header reports, newest first -- see
 * web-spider-daemon's domain/search-usage.ts) as a bucketed bar chart via
 * malevich-tui-components' HistoryChart -- the same generalized renderer
 * pi-jittor's own `/usage` panel uses -- with a TabMenu to switch which
 * metric the bars stack (calls / credits / cost), since not every engine
 * reports every metric.
 */
import type { ExtensionAPI, ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	type ChartBucket,
	type ChartSeries,
	HistoryChart,
	type HistoryChartTheme,
	TabMenu,
	type TabMenuNode,
	type TabMenuTheme,
} from "malevich-tui-components";
import { callWebSpider } from "./retrying-client.js";

export interface SearchEngineUsageEntry {
	engine: string;
	observedAt: number;
	credits?: number;
	costUsd?: number;
	rateLimitHeaders?: Record<string, string>;
}

export type UsageMetric = "calls" | "credits" | "cost";
export const USAGE_METRICS: readonly UsageMetric[] = ["calls", "credits", "cost"];

const USAGE_METRIC_LABELS: Record<UsageMetric, string> = { calls: "Calls", credits: "Credits", cost: "Cost ($)" };

function metricValue(entry: SearchEngineUsageEntry, metric: UsageMetric): number | undefined {
	if (metric === "calls") return 1;
	if (metric === "credits") return entry.credits;
	return entry.costUsd;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Hourly buckets once the fetched entries span more than 48h would make hourly bars unreadably thin; daily otherwise -- purely a function of the data's own actual span, since search.usage has no time-range query parameter to request a fixed window. */
export function usageBucketSizeMs(entries: readonly SearchEngineUsageEntry[]): number {
	if (entries.length < 2) return HOUR_MS;
	let min = entries[0]?.observedAt ?? 0;
	let max = min;
	for (const entry of entries) {
		if (entry.observedAt < min) min = entry.observedAt;
		if (entry.observedAt > max) max = entry.observedAt;
	}
	return max - min > 2 * DAY_MS ? DAY_MS : HOUR_MS;
}

export interface UsageChartData {
	buckets: ChartBucket[];
	series: ChartSeries[];
}

/** Buckets entries by their own observed timespan (see usageBucketSizeMs), stacked per engine, for the given metric. Entries missing that metric (e.g. credits on a costUsd-only engine) don't contribute -- never coerced to 0, which would understate that engine's own real per-metric total. */
export function buildUsageChartData(entries: readonly SearchEngineUsageEntry[], metric: UsageMetric): UsageChartData {
	if (entries.length === 0) return { buckets: [], series: [] };

	const size = usageBucketSizeMs(entries);
	let min = entries[0]?.observedAt ?? 0;
	let max = min;
	const engines = new Set<string>();
	for (const entry of entries) {
		if (entry.observedAt < min) min = entry.observedAt;
		if (entry.observedAt > max) max = entry.observedAt;
		engines.add(entry.engine);
	}
	const series: ChartSeries[] = [...engines].sort().map((engine) => ({ key: engine, label: engine }));

	const start = Math.floor(min / size) * size;
	const bucketCount = Math.max(1, Math.floor((max - start) / size) + 1);
	const buckets: ChartBucket[] = Array.from({ length: bucketCount }, (_unused, index) => ({
		start: start + index * size,
		end: start + (index + 1) * size,
		total: 0,
		series: {},
	}));

	for (const entry of entries) {
		const value = metricValue(entry, metric);
		if (value === undefined) continue;
		const index = Math.min(bucketCount - 1, Math.floor((entry.observedAt - start) / size));
		const bucket = buckets[index];
		if (!bucket) continue;
		bucket.series[entry.engine] = (bucket.series[entry.engine] ?? 0) + value;
		bucket.total += value;
	}

	return { buckets, series };
}

function compact(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatUsd(value: number): string {
	if (value === 0) return "$0";
	return Math.abs(value) < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function metricFormatter(metric: UsageMetric): (value: number) => string {
	return metric === "cost" ? formatUsd : compact;
}

const SERIES_HUES: readonly ThemeColor[] = [
	"accent",
	"syntaxFunction",
	"syntaxString",
	"syntaxNumber",
	"syntaxKeyword",
	"syntaxType",
	"thinkingText",
	"syntaxVariable",
	"syntaxOperator",
];

function seriesStyle(index: number, theme: Theme): (text: string) => string {
	const hue = SERIES_HUES[index % SERIES_HUES.length] as ThemeColor;
	return (text) => theme.fg(hue, text);
}

function historyChartTheme(theme: Theme): HistoryChartTheme {
	return {
		title: (s) => theme.bold(s),
		subtitle: (s) => theme.fg("dim", s),
		axis: (s) => theme.fg("borderMuted", s),
		warningLine: (s) => theme.fg("warning", s),
		errorLine: (s) => theme.fg("error", s),
		muted: (s) => theme.fg("dim", s),
		series: (index) => seriesStyle(index, theme),
	};
}

function tabMenuTheme(theme: Theme): TabMenuTheme {
	return {
		tab: (s) => theme.fg("dim", s),
		activeTab: (s) => theme.inverse(s),
		breadcrumb: (s) => theme.fg("dim", s),
		description: (s) => theme.fg("dim", s),
		help: (s) => theme.fg("dim", s),
	};
}

export interface ParsedUsageArgs {
	engine?: string;
	limit?: number;
}

/** Parses "[engine] [--limit N]" -- two optional inputs, not a full flag grammar. Returns undefined on a malformed --limit. */
export function parseUsageCommandArgs(raw: string): ParsedUsageArgs | undefined {
	const tokens = raw
		.trim()
		.split(/\s+/)
		.filter((token) => token.length > 0);
	let engine: string | undefined;
	let limit: number | undefined;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--limit") {
			const value = tokens[index + 1];
			const parsed = value !== undefined ? Number(value) : Number.NaN;
			if (!Number.isFinite(parsed)) return undefined;
			limit = parsed;
			index += 1;
			continue;
		}
		engine = token;
	}
	return { engine, limit };
}

function usageTitle(count: number, engine: string | undefined): string {
	const noun = count === 1 ? "entry" : "entries";
	return `Search provider usage \u2014 ${count} ${noun}${engine ? ` (${engine})` : ""}`;
}

/** Opens a TabMenu (calls/credits/cost) over a HistoryChart of the given entries; resolves once the human cancels out of the menu. */
async function showUsagePanel(ctx: ExtensionCommandContext, entries: readonly SearchEngineUsageEntry[], title: string): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let metric: UsageMetric = "calls";
		const nodes: TabMenuNode<UsageMetric>[] = USAGE_METRICS.map((value) => ({
			label: USAGE_METRIC_LABELS[value],
			value,
			description: `Stack bars by ${USAGE_METRIC_LABELS[value].toLowerCase()}.`,
		}));
		const tabMenu = new TabMenu<UsageMetric>({
			nodes,
			theme: tabMenuTheme(theme),
			onSelect: (value) => {
				metric = value;
				tui.requestRender();
			},
			onCancel: () => done(undefined),
		});

		function chartLines(width: number): string[] {
			const { buckets, series } = buildUsageChartData(entries, metric);
			if (buckets.length === 0 || buckets.every((bucket) => bucket.total === 0)) {
				return [theme.fg("dim", `No ${USAGE_METRIC_LABELS[metric].toLowerCase()} reported by any fetched entry.`)];
			}
			return new HistoryChart({
				title,
				buckets,
				series,
				formatValue: metricFormatter(metric),
				unitSuffix: metric === "calls" ? " calls" : "",
				noDataText: "No data for this metric in the fetched window.",
				theme: historyChartTheme(theme),
			}).render(width);
		}

		return {
			render: (width: number) => [...tabMenu.render(width), "", ...chartLines(width)],
			invalidate: () => tabMenu.invalidate(),
			handleInput: (data: string) => {
				tabMenu.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

export interface RunUsageCommandOptions {
	/** Overridden in tests instead of reaching the real daemon. */
	fetchUsage?: (input: ParsedUsageArgs) => Promise<{ entries: SearchEngineUsageEntry[] }>;
	/** Overridden in tests instead of opening a real ctx.ui.custom overlay. */
	showPanel?: (ctx: ExtensionCommandContext, entries: readonly SearchEngineUsageEntry[], title: string) => Promise<void>;
}

/** Fetches recent search-provider usage and shows it -- a chart+TabMenu overlay in TUI mode, a plain notify() summary otherwise (ctx.mode !== "tui"), matching this package's other TUI-fallback commands. */
export async function runUsageCommand(ctx: ExtensionCommandContext, args: string, options: RunUsageCommandOptions = {}): Promise<void> {
	const fetchUsage = options.fetchUsage ?? ((input) => callWebSpider("search.usage", { engine: input.engine, limit: input.limit }));
	const showPanel = options.showPanel ?? showUsagePanel;

	const parsed = parseUsageCommandArgs(args);
	if (!parsed) {
		ctx.ui.notify("usage: /web [engine] [--limit N]", "warning");
		return;
	}

	const result = await fetchUsage(parsed);
	if (result.entries.length === 0) {
		ctx.ui.notify("No search usage recorded yet -- never a running account balance, only what each call itself reported.", "info");
		return;
	}

	const title = usageTitle(result.entries.length, parsed.engine);

	if (ctx.mode !== "tui") {
		const summary = result.entries.map((entry) => `${entry.engine}@${new Date(entry.observedAt).toISOString()}`).join(", ");
		ctx.ui.notify(`${title}: ${summary}`, "info");
		return;
	}

	await showPanel(ctx, result.entries, title);
}

export function registerWebSpiderUsageCommand(pi: ExtensionAPI, commandName = "web"): void {
	pi.registerCommand(commandName, {
		description: "View recent web-search provider usage (credits/cost/rate-limit headers) as a bar chart",
		handler: async (args, ctx) => runUsageCommand(ctx, args),
	});
}
