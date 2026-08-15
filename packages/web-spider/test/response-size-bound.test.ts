/**
 * Bounds the default HTTP client's response body while streaming, not just
 * via Content-Length -- a real local server streaming chunked data with no
 * declared length, so a header-only check would miss it.
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ResponseTooLargeError } from "../src/errors.js";
import { createDefaultHttpClient, spider } from "../src/fetch/spider.js";
import { DefaultSsrfGuard } from "../src/fetch/ssrf-guard.js";

function startChunkedServer(totalBytes: number, chunkSize = 1024): Promise<{ url: string; close: () => Promise<void> }> {
	return new Promise((resolve) => {
		const server: Server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "application/octet-stream" }); // no content-length -- forces chunked transfer
			let sent = 0;
			const chunk = Buffer.alloc(chunkSize, "a");
			const pump = (): void => {
				if (sent >= totalBytes) {
					res.end();
					return;
				}
				const remaining = totalBytes - sent;
				const piece = remaining < chunkSize ? chunk.subarray(0, remaining) : chunk;
				sent += piece.byteLength;
				res.write(piece, () => pump());
			};
			pump();
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(() => r())) });
		});
	});
}

const localhostGuard = () => new DefaultSsrfGuard({ allowRanges: ["127.0.0.1/32"] });

describe("default HTTP client -- streamed response-size bound", () => {
	let fixture: { url: string; close: () => Promise<void> } | undefined;

	afterEach(async () => {
		await fixture?.close();
		fixture = undefined;
	});

	it("succeeds for a body under the bound", async () => {
		fixture = await startChunkedServer(1024);
		const client = createDefaultHttpClient(localhostGuard(), 4096);
		const res = await client.fetch({ url: fixture.url });
		const buf = await res.arrayBuffer();
		expect(buf.byteLength).toBe(1024);
	});

	it("throws ResponseTooLargeError via arrayBuffer() for a chunked body over the bound", async () => {
		fixture = await startChunkedServer(10_000);
		const client = createDefaultHttpClient(localhostGuard(), 4096);
		const res = await client.fetch({ url: fixture.url });
		await expect(res.arrayBuffer()).rejects.toBeInstanceOf(ResponseTooLargeError);
	});

	it("throws ResponseTooLargeError via text() for a chunked body over the bound", async () => {
		fixture = await startChunkedServer(10_000);
		const client = createDefaultHttpClient(localhostGuard(), 4096);
		const res = await client.fetch({ url: fixture.url });
		await expect(res.text()).rejects.toBeInstanceOf(ResponseTooLargeError);
	});

	it("enforces the bound with no Content-Length header present at all", async () => {
		fixture = await startChunkedServer(10_000);
		const client = createDefaultHttpClient(localhostGuard(), 4096);
		const res = await client.fetch({ url: fixture.url });
		expect(res.headers.get("content-length")).toBeNull();
		await expect(res.arrayBuffer()).rejects.toBeInstanceOf(ResponseTooLargeError);
	});

	it("defaults to DEFAULT_MAX_RESPONSE_BYTES when no bound is given", async () => {
		fixture = await startChunkedServer(1024);
		const client = createDefaultHttpClient(localhostGuard());
		const res = await client.fetch({ url: fixture.url });
		await expect(res.arrayBuffer()).resolves.toBeInstanceOf(ArrayBuffer);
	});
});

describe("spider() -- maxResponseBytes option wired through to the default client", () => {
	let fixture: { url: string; close: () => Promise<void> } | undefined;

	afterEach(async () => {
		await fixture?.close();
		fixture = undefined;
	});

	it("rejects with ResponseTooLargeError when the real page exceeds maxResponseBytes", async () => {
		fixture = await startChunkedServer(10_000);
		await expect(spider(fixture.url, { ssrfGuard: localhostGuard(), maxResponseBytes: 4096 })).rejects.toBeInstanceOf(
			ResponseTooLargeError,
		);
	});
});
