import { describe, expect, it } from "vitest";
import { classifyOperationRisk } from "../src/operation-gateway.js";

describe("classifyOperationRisk", () => {
	it("routes robots bypasses to approval-gated operations", () => {
		for (const operation of ["fetch", "crawl", "quotes"]) {
			const classified = classifyOperationRisk(operation, { url: "https://example.test", ignoreRobots: true });
			expect(classified.operation).toBe(`${operation}.ignoreRobots`);
			expect(classified.input).not.toHaveProperty("ignoreRobots");
		}
		expect(classifyOperationRisk("fetch", { url: "https://example.test" }).operation).toBe("fetch");
	});

	it("separates inspection, interaction, and script execution", () => {
		for (const action of [
			"waitFor",
			"queryText",
			"readTable",
			"snapshot",
			"downloads",
			"consoleMessages",
			"networkRequests",
			"screenshot",
		]) {
			expect(classifyOperationRisk("session.act", { action }).operation, action).toBe("session.inspect");
		}
		for (const action of ["navigate", "click", "hover", "pressKey", "type", "select", "handleDialog"]) {
			expect(classifyOperationRisk("session.act", { action }).operation, action).toBe("session.interact");
		}
		expect(classifyOperationRisk("session.act", { action: "tabs", tabOperation: "list" }).operation).toBe("session.inspect");
		expect(classifyOperationRisk("session.act", { action: "tabs", tabOperation: "new" }).operation).toBe("session.interact");
		expect(classifyOperationRisk("session.act", { action: "eval" }).operation).toBe("session.eval");
	});
});
