/**
 * View transformations — business logic that converts a SpideredPage into
 * one of the available view shapes. Separated from types.ts which is pure
 * data-shape definitions.
 */
import type { LeanPage, SpideredPage } from "./types.js";
/**
 * Downgrade a full SpideredPage to a LeanPage.
 * Use when you have already fetched full but only need the outline in context.
 */
export declare function toLean(page: SpideredPage): LeanPage;
//# sourceMappingURL=views.d.ts.map