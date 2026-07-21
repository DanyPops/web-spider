import type { SpideredPage } from "./types.js";
export interface NDJSONRecord {
    type: "node" | "edge" | "meta";
    [key: string]: unknown;
}
export declare function pageToRecords(page: SpideredPage): NDJSONRecord[];
export declare function pagesToNDJSON(pages: SpideredPage[]): string;
export declare function ingestToScribe(pages: SpideredPage[], ingestURL: string): Promise<void>;
//# sourceMappingURL=scribe-bridge.d.ts.map