import { describe, expect, it } from "vitest";
import { classifyContentType } from "../src/content-type.js";

describe("classifyContentType", () => {
	it("classifies text/html and application/xhtml+xml as html", () => {
		expect(classifyContentType("text/html")).toBe("html");
		expect(classifyContentType("text/html; charset=utf-8")).toBe("html");
		expect(classifyContentType("application/xhtml+xml")).toBe("html");
	});

	it("classifies application/json and the +json suffix convention as json", () => {
		expect(classifyContentType("application/json")).toBe("json");
		expect(classifyContentType("application/json; charset=utf-8")).toBe("json");
		expect(classifyContentType("application/ld+json")).toBe("json");
		expect(classifyContentType("application/geo+json")).toBe("json");
		expect(classifyContentType("application/vnd.api+json")).toBe("json");
	});

	it("classifies application/xml, text/xml, and the +xml suffix convention as xml", () => {
		expect(classifyContentType("application/xml")).toBe("xml");
		expect(classifyContentType("text/xml")).toBe("xml");
		expect(classifyContentType("application/atom+xml")).toBe("xml");
		expect(classifyContentType("application/rss+xml")).toBe("xml");
	});

	it("classifies other text/* subtypes as text", () => {
		expect(classifyContentType("text/plain")).toBe("text");
		expect(classifyContentType("text/plain; charset=utf-8")).toBe("text");
		expect(classifyContentType("text/markdown")).toBe("text");
		expect(classifyContentType("text/csv")).toBe("text");
		expect(classifyContentType("text/css")).toBe("text");
	});

	it("classifies binary/non-text top-level types as unsupported", () => {
		expect(classifyContentType("image/png")).toBe("unsupported");
		expect(classifyContentType("image/jpeg")).toBe("unsupported");
		expect(classifyContentType("audio/mpeg")).toBe("unsupported");
		expect(classifyContentType("video/mp4")).toBe("unsupported");
		expect(classifyContentType("font/woff2")).toBe("unsupported");
		expect(classifyContentType("application/pdf")).toBe("unsupported");
		expect(classifyContentType("application/octet-stream")).toBe("unsupported");
		expect(classifyContentType("application/zip")).toBe("unsupported");
		expect(classifyContentType("multipart/form-data")).toBe("unsupported");
	});

	it("defaults to html when the header is absent or empty — preserves historical behavior", () => {
		expect(classifyContentType(null)).toBe("html");
		expect(classifyContentType(undefined)).toBe("html");
		expect(classifyContentType("")).toBe("html");
		expect(classifyContentType("   ")).toBe("html");
	});

	it("is case-insensitive", () => {
		expect(classifyContentType("TEXT/HTML")).toBe("html");
		expect(classifyContentType("Application/JSON")).toBe("json");
		expect(classifyContentType("IMAGE/PNG")).toBe("unsupported");
	});
});
