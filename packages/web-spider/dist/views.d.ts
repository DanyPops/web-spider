/**
 * View transformations — business logic that converts a SpideredPage into
 * one of the available view shapes. Separated from types.ts which is pure
 * data-shape definitions.
 */
import type { PageGraph } from "./graph.js";
import type { LeanPage, SpideredPage } from "./types.js";
/**
 * Downgrade a full SpideredPage to a LeanPage.
 *
 * Pass a PageGraph as the second argument to populate `inboundCount` —
 * the number of other spidered pages that link to this one. Agents can
 * use this as a lightweight authority signal when ranking results from
 * a crawl without running a full PageRank pass.
 */
export declare function toLean(page: SpideredPage, graph?: PageGraph): LeanPage;
//# sourceMappingURL=views.d.ts.map