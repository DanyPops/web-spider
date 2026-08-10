import { describe, expect, it } from "vitest";
import { expandHint, shouldShowExpandHint } from "../src/expand-hint.js";

describe("expand-hint: single source of truth for every card's ctrl+o affordance", () => {
	it("formats the real, possibly user-remapped app.tools.expand keybinding", () => {
		expect(expandHint()).toContain("expand for details");
	});

	it("shows the hint only while collapsed and only when something is genuinely hidden", () => {
		expect(shouldShowExpandHint(false, true)).toBe(true);
		expect(shouldShowExpandHint(true, true)).toBe(false);
		expect(shouldShowExpandHint(false, false)).toBe(false);
		expect(shouldShowExpandHint(true, false)).toBe(false);
	});
});
