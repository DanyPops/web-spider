/**
 * WBS-TSK-12: TDD tests for HttpResponse.arrayBuffer()
 *
 * All tests use stub HTTP clients — no real network.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HttpResponse, IHttpClient } from "../src/ports.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubResponse(overrides: Partial<HttpResponse> = {}): HttpResponse {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		headers: { get: () => null },
		text: async () => "",
		arrayBuffer: async () => new ArrayBuffer(0),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Interface conformance (TypeScript structural check via satisfies)
// ---------------------------------------------------------------------------

describe("HttpResponse interface", () => {
	it("stub with arrayBuffer() satisfies HttpResponse", () => {
		const stub = {
			ok: true,
			status: 200,
			statusText: "OK",
			headers: { get: (_name: string) => null as string | null },
			text: async () => "",
			arrayBuffer: async () => new ArrayBuffer(4),
		} satisfies HttpResponse;

		expect(typeof stub.arrayBuffer).toBe("function");
	});

	it("IHttpClient stub with arrayBuffer-returning fetch satisfies the port", () => {
		const client: IHttpClient = {
			fetch: async (_req) => makeStubResponse({ arrayBuffer: async () => new ArrayBuffer(8) }),
		};
		expect(typeof client.fetch).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// arrayBuffer() returns correct bytes
// ---------------------------------------------------------------------------

describe("arrayBuffer() byte content", () => {
	it("resolves to an ArrayBuffer", async () => {
		const response = makeStubResponse({
			arrayBuffer: async () => new ArrayBuffer(4),
		});
		const buf = await response.arrayBuffer();
		expect(buf).toBeInstanceOf(ArrayBuffer);
	});

	it("returns the correct byte length", async () => {
		const response = makeStubResponse({
			arrayBuffer: async () => new ArrayBuffer(16),
		});
		const buf = await response.arrayBuffer();
		expect(buf.byteLength).toBe(16);
	});

	it("returns correct bytes from a known fixture", async () => {
		const tinyPng = readFileSync(
			join(import.meta.dirname, "../fixtures/images/tiny.png"),
		);
		const expected = tinyPng.buffer.slice(
			tinyPng.byteOffset,
			tinyPng.byteOffset + tinyPng.byteLength,
		) as ArrayBuffer;

		const response = makeStubResponse({
			arrayBuffer: async () => expected,
		});

		const buf = await response.arrayBuffer();
		expect(buf.byteLength).toBe(tinyPng.byteLength);

		const view = new Uint8Array(buf);
		// PNG magic bytes: 0x89 0x50 0x4E 0x47
		expect(view[0]).toBe(0x89);
		expect(view[1]).toBe(0x50); // P
		expect(view[2]).toBe(0x4e); // N
		expect(view[3]).toBe(0x47); // G
	});

	it("returns zero-length buffer when resource is empty", async () => {
		const response = makeStubResponse({
			arrayBuffer: async () => new ArrayBuffer(0),
		});
		const buf = await response.arrayBuffer();
		expect(buf.byteLength).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Default fetch adapter — arrayBuffer() on real tiny PNG bytes
// ---------------------------------------------------------------------------

describe("default fetch adapter arrayBuffer() via mock client", () => {
	it("mock client that returns tiny.png bytes produces correct ArrayBuffer", async () => {
		const tinyPng = readFileSync(
			join(import.meta.dirname, "../fixtures/images/tiny.png"),
		);

		const client: IHttpClient = {
			fetch: async (_req) =>
				makeStubResponse({
					arrayBuffer: async () =>
						tinyPng.buffer.slice(
							tinyPng.byteOffset,
							tinyPng.byteOffset + tinyPng.byteLength,
						) as ArrayBuffer,
				}),
		};

		const res = await client.fetch({ url: "https://example.com/tiny.png" });
		const buf = await res.arrayBuffer();

		expect(buf.byteLength).toBe(tinyPng.byteLength);
		const view = new Uint8Array(buf);
		expect(view[0]).toBe(0x89); // PNG magic
	});

	it("base64-encoding an ArrayBuffer from mock produces correct data URL prefix", async () => {
		const tinyPng = readFileSync(
			join(import.meta.dirname, "../fixtures/images/tiny.png"),
		);

		const client: IHttpClient = {
			fetch: async (_req) =>
				makeStubResponse({
					arrayBuffer: async () =>
						tinyPng.buffer.slice(
							tinyPng.byteOffset,
							tinyPng.byteOffset + tinyPng.byteLength,
						) as ArrayBuffer,
				}),
		};

		const res = await client.fetch({ url: "https://example.com/tiny.png" });
		const buf = await res.arrayBuffer();
		const b64 = Buffer.from(buf).toString("base64");
		const dataUrl = `data:image/png;base64,${b64}`;

		expect(dataUrl).toMatch(/^data:image\/png;base64,/);
		expect(b64.length).toBeGreaterThan(0);
	});
});
