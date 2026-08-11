/**
 * web_category — curated, agent/user-assignable relevance categories for
 * cached pages. Distinct from `domain` (URL hostname) and `tags` (publisher-
 * provided, auto-extracted from a page's own HTML): a category is a judgment
 * about what a page is *for*, made by whoever's curating, growing organically
 * as new topics come up rather than a closed enum. A page can and often will
 * belong to more than one category at once -- overlap is the expected case.
 * Kept as its own tool rather than folded into web_fetch, matching this
 * project's own precedent (web_session exists separately for the same
 * reason): a genuinely new capability gets its own contract instead of
 * growing web_fetch's.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";
import { DETAILS_MAX_ITEMS, DETAILS_VERSION } from "./constants.js";
import type { CallMeta, VehicleGateway } from "./vehicle-gateway.js";

const categoryParamsSchema = Type.Object({
	operation: Type.Union([Type.Literal("assign"), Type.Literal("remove"), Type.Literal("rename"), Type.Literal("list")], {
		description: "assign/remove a category on a page, rename (or merge) one everywhere it's used, or list every category",
	}),
	url: Type.Optional(Type.String({ description: "assign/remove: the cached page's URL (must already be cached)" })),
	category: Type.Optional(Type.String({ description: "assign/remove: category name. rename: its current name." })),
	newName: Type.Optional(Type.String({ description: "rename: new name; merges into an existing category of that name instead of erroring" })),
});

type CategoryParams = Static<typeof categoryParamsSchema>;

interface CategoryPresentationDetails {
	version: typeof DETAILS_VERSION;
	kind: "web-category";
	operation: CategoryParams["operation"];
	summary: string;
	items: string[];
	total: number;
	truncated: boolean;
}

function createCategoryDetails(operation: CategoryParams["operation"], summary: string, rows: string[] = []): CategoryPresentationDetails {
	const total = rows.length;
	const items = rows.slice(0, DETAILS_MAX_ITEMS);
	return { version: DETAILS_VERSION, kind: "web-category", operation, summary, items, total, truncated: total > items.length };
}

type CategoryToolResult = { content: Array<{ type: "text"; text: string }>; details: CategoryPresentationDetails };

// ---------------------------------------------------------------------------
// operation=... dispatch (Strategy pattern, OCP): a new operation is one new
// entry here, not a new branch in a growing if/else chain. Each handler goes
// through `gateway.invoke()` (DIP) instead of a locally reimplemented
// Vehicle-invocation facade -- category.* has migrated onto the real Vehicle
// protocol (see web-spider-daemon's category-vehicle.ts), and gateway.invoke()
// runs each sub-action through the same cross-cutting policy layer
// (activity broadcasting, the /safety ask gate, the approval-required retry
// dance) a registerVehicleTools()-registered tool gets automatically, while
// keeping this tool's own consolidated operation=assign/remove/rename/list
// shape unchanged.
// ---------------------------------------------------------------------------
type CategoryOperationHandler = (params: CategoryParams, callMeta: CallMeta, gateway: VehicleGateway) => Promise<CategoryToolResult>;

const CATEGORY_OPERATION_HANDLERS: Record<CategoryParams["operation"], CategoryOperationHandler> = {
	async list(_params, callMeta, gateway) {
		const result = await gateway.invoke<{ categories: Array<{ id: number; name: string; pageCount: number }> }>(
			"category.list",
			{},
			callMeta,
		);
		const rows = result.categories.map((c) => `${c.name}  (${c.pageCount} page(s))`);
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: createCategoryDetails("list", `${result.categories.length} categor${result.categories.length === 1 ? "y" : "ies"}`, rows),
		};
	},

	async assign(params, callMeta, gateway) {
		if (!params.url) throw new Error("url is required for operation=assign");
		if (!params.category) throw new Error("category is required for operation=assign");
		const result = await gateway.invoke<{ url: string; category: string; categoryId: number }>(
			"category.assign",
			{ url: params.url, category: params.category },
			callMeta,
		);
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: createCategoryDetails("assign", `"${result.category}" → ${result.url}`),
		};
	},

	async remove(params, callMeta, gateway) {
		if (!params.url) throw new Error("url is required for operation=remove");
		if (!params.category) throw new Error("category is required for operation=remove");
		const result = await gateway.invoke<{ url: string; category: string; removed: true }>(
			"category.remove",
			{ url: params.url, category: params.category },
			callMeta,
		);
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: createCategoryDetails("remove", `removed "${result.category}" from ${result.url}`),
		};
	},

	async rename(params, callMeta, gateway) {
		if (!params.category) throw new Error("category is required for operation=rename");
		if (!params.newName) throw new Error("newName is required for operation=rename");
		const result = await gateway.invoke<{ categoryId: number; name: string; merged: boolean }>(
			"category.rename",
			{ category: params.category, newName: params.newName },
			callMeta,
		);
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details: createCategoryDetails("rename", result.merged ? `merged into "${result.name}"` : `renamed to "${result.name}"`),
		};
	},
};

/** Registers web_category. `gateway` is the one seam this module depends on instead of importing a concrete daemon client (DIP) -- see vehicle-gateway.ts. */
export function registerCategoryTool(pi: ExtensionAPI, gateway: VehicleGateway): void {
	pi.registerTool({
		name: "web_category",
		label: "Web Category",
		description: [
			'Curated, agent/user-assignable relevance categories for cached pages -- e.g. "Code", "PTP Protocol". Distinct from a page\'s domain and its publisher-supplied tags: a category is your own judgment about what a page is *for*.',
			"Free-form -- invent a name the first time you need it. A page can belong to more than one category; overlap is expected. Use web_fetch(category=X) with no url to list pages in a category.",
		].join("\n"),
		promptSnippet:
			"Curated relevance categories for cached pages: assign/remove/rename/list, with overlap (a page can belong to more than one)",
		parameters: categoryParamsSchema,
		async execute(toolCallId, params: CategoryParams, signal, _onUpdate, context) {
			const callMeta: CallMeta = { toolName: "web_category", toolCallId, signal, context };
			try {
				return await CATEGORY_OPERATION_HANDLERS[params.operation](params, callMeta, gateway);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`web_category failed: ${message}`);
			}
		},
	});
}
