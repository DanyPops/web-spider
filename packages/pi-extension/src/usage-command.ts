/**
 * `/websearch-usage`: renders the daemon's own `search.usage` operation
 * (recent per-call credits/cost/rate-limit-header reports, newest first --
 * see web-spider-daemon's domain/search-usage.ts) through Malevich's Table
 * component, instead of cli-format.ts's plain-text formatter. Same data the
 * CLI's `web-spider usage` already exposes; this is a TUI-native view of it.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { Envelope, Table, type TableColumn } from "malevich-tui-components";
import { callWebSpider } from "./retrying-client.js";

export interface SearchEngineUsageEntry {
	engine: string;
	observedAt: number;
	credits?: number;
	costUsd?: number;
	rateLimitHeaders?: Record<string, string>;
}

export const USAGE_TABLE_COLUMNS: readonly TableColumn[] = [
	{ header: "Engine", key: "engine" },
	{ header: "Observed", key: "observedAt" },
	{ header: "Credits", key: "credits", align: "right" },
	{ header: "Cost (USD)", key: "costUsd", align: "right" },
	{ header: "Rate-limit headers", key: "rateLimitHeaders" },
];

export function buildUsageTableRows(entries: readonly SearchEngineUsageEntry[]): Record<string, string>[] {
	return entries.map((entry) => ({
		engine: entry.engine,
		observedAt: new Date(entry.observedAt).toISOString(),
		credits: entry.credits !== undefined ? String(entry.credits) : "",
		costUsd: entry.costUsd !== undefined ? entry.costUsd.toFixed(4) : "",
		rateLimitHeaders: entry.rateLimitHeaders ? JSON.stringify(entry.rateLimitHeaders) : "",
	}));
}

export interface ParsedUsageArgs {
	engine?: string;
	limit?: number;
}

/** Parses "[engine] [--limit N]" -- two optional inputs, not a full flag grammar. Returns undefined on a malformed --limit. */
export function parseUsageCommandArgs(raw: string): ParsedUsageArgs | undefined {
	const tokens = raw.trim().split(/\s+/).filter((token) => token.length > 0);
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

/** Opens a read-only overlay; resolves once the human presses Escape/closes it. */
async function showUsagePanel(ctx: ExtensionCommandContext, rows: Record<string, string>[], title: string): Promise<void> {
	return ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
		const envelope = new Envelope({ title, borderStyle: "rounded" });
		envelope.setContent(new Table({ columns: [...USAGE_TABLE_COLUMNS], rows }));
		const helpLine = theme.fg("dim", "esc close");
		return {
			render: (width: number) => [...envelope.render(width), helpLine],
			invalidate: () => envelope.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "escape")) done(undefined);
			},
		};
	});
}

export interface RunUsageCommandOptions {
	/** Overridden in tests instead of reaching the real daemon. */
	fetchUsage?: (input: ParsedUsageArgs) => Promise<{ entries: SearchEngineUsageEntry[] }>;
	/** Overridden in tests instead of opening a real ctx.ui.custom overlay. */
	showPanel?: (ctx: ExtensionCommandContext, rows: Record<string, string>[], title: string) => Promise<void>;
}

function usageTitle(count: number, engine: string | undefined): string {
	const noun = count === 1 ? "entry" : "entries";
	return `Search provider usage \u2014 ${count} ${noun}${engine ? ` (${engine})` : ""}`;
}

/** Fetches recent search-provider usage and shows it -- a table overlay in TUI mode, a plain notify() summary otherwise (ctx.mode !== "tui"), matching this package's other TUI-fallback commands. */
export async function runUsageCommand(ctx: ExtensionCommandContext, args: string, options: RunUsageCommandOptions = {}): Promise<void> {
	const fetchUsage =
		options.fetchUsage ?? ((input) => callWebSpider("search.usage", { engine: input.engine, limit: input.limit }));
	const showPanel = options.showPanel ?? showUsagePanel;

	const parsed = parseUsageCommandArgs(args);
	if (!parsed) {
		ctx.ui.notify("usage: /websearch-usage [engine] [--limit N]", "warning");
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

	await showPanel(ctx, buildUsageTableRows(result.entries), title);
}

export function registerWebSpiderUsageCommand(pi: ExtensionAPI, commandName = "websearch-usage"): void {
	pi.registerCommand(commandName, {
		description: "View recent web-search provider usage (credits/cost/rate-limit headers) as a table",
		handler: async (args, ctx) => runUsageCommand(ctx, args),
	});
}
