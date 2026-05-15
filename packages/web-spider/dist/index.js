// ---------------------------------------------------------------------------
// Public API — what most consumers need
// ---------------------------------------------------------------------------
export { batchSpider } from "./batch.js";
export { SpiderCache } from "./cache.js";
export { crawl } from "./crawl.js";
export { PageGraph } from "./graph.js";
export { fuzzySearch } from "./search.js";
export { spider } from "./spider.js";
export { buildTree, navigateTree, queryTree } from "./tree.js";
export { toLean } from "./views.js";
export { braveSearch, exaSearch, tavilySearch, webSearch } from "./web-search.js";
export { DiskCache } from "./disk-cache.js";
export { PlaywrightHttpClient, createPlaywrightClient } from "./playwright.js";
export { RobotsCache, createRobotsCache } from "./robots.js";
export { fetchSitemapUrls } from "./sitemap.js";
export { DomainThrottle, createThrottle } from "./throttle.js";
export { BraveSearchEngine, ExaSearchEngine, TavilySearchEngine, defaultSearchEngine } from "./web-search.js";
// ---------------------------------------------------------------------------
// parse.ts, convert.ts, views.ts are internal implementation modules.
// They are NOT exported here — they are consumed only by spider.ts.
// If you need lower-level DOM or markdown utilities, import from the
// sub-modules directly (not covered by semver stability guarantees).
// ---------------------------------------------------------------------------
//# sourceMappingURL=index.js.map