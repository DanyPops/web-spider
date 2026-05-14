/**
 * Package export smoke tests.
 *
 * Imports every public symbol from the package entrypoint and asserts it is
 * present and has the right shape. This catches "not a constructor" and
 * "undefined is not a function" errors before they reach users.
 *
 * Run after every build: these tests operate on the compiled src/, not dist/,
 * so they reflect what will be shipped.
 */

import { describe, expect, it } from "vitest";
import {
	DomainThrottle,
	PageGraph,
	RobotsCache,
	SpiderCache,
	batchSpider,
	braveSearch,
	buildTree,
	crawl,
	fuzzySearch,
	navigateTree,
	queryTree,
	spider,
	tavilySearch,
	toLean,
	webSearch,
} from "../src/index.js";

describe("class constructors", () => {
	it("SpiderCache is constructable", () => {
		expect(typeof SpiderCache).toBe("function");
		expect(new SpiderCache()).toBeInstanceOf(SpiderCache);
	});

	it("PageGraph is constructable", () => {
		expect(typeof PageGraph).toBe("function");
		expect(new PageGraph()).toBeInstanceOf(PageGraph);
	});

	it("DomainThrottle is constructable", () => {
		expect(typeof DomainThrottle).toBe("function");
		const t = new DomainThrottle();
		expect(t).toBeInstanceOf(DomainThrottle);
		expect(typeof t.wait).toBe("function");
		expect(typeof t.success).toBe("function");
		expect(typeof t.rateLimit).toBe("function");
	});

	it("RobotsCache is constructable", () => {
		expect(typeof RobotsCache).toBe("function");
		const r = new RobotsCache();
		expect(r).toBeInstanceOf(RobotsCache);
		expect(typeof r.check).toBe("function");
	});
});

describe("functions", () => {
	it.each([
		["spider", spider],
		["crawl", crawl],
		["fuzzySearch", fuzzySearch],
		["batchSpider", batchSpider],
		["buildTree", buildTree],
		["navigateTree", navigateTree],
		["queryTree", queryTree],
		["toLean", toLean],
		["webSearch", webSearch],
		["braveSearch", braveSearch],
		["tavilySearch", tavilySearch],
	])("%s is a function", (_name, fn) => {
		expect(typeof fn).toBe("function");
	});
});

describe("DomainThrottle defaults", () => {
	it("has expected default values", () => {
		const t = new DomainThrottle();
		expect(t.minDelayMs).toBe(500);
		expect(t.backoffBaseMs).toBe(1_000);
		expect(t.backoffCapMs).toBe(30_000);
		expect(t.maxRetries).toBe(3);
	});

	it("accepts custom options", () => {
		const t = new DomainThrottle({ minDelayMs: 100, maxRetries: 1 });
		expect(t.minDelayMs).toBe(100);
		expect(t.maxRetries).toBe(1);
	});
});
