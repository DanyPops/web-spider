import { describe, expect, it } from "vitest";
import { FetchTransportError, toFetchTransportError } from "../src/errors.js";
import { spider } from "../src/fetch/spider.js";
import type { IHttpClient } from "../src/ports.js";

function throwingClient(error: unknown): IHttpClient {
	return {
		fetch: async () => {
			throw error;
		},
	};
}

function codedError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

describe("fetch transport failure classification", () => {
	it.each([
		["dns", codedError("ENOTFOUND", "getaddrinfo ENOTFOUND secret.example?token=top-secret"), "DNS lookup failed", true],
		["connection", codedError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:1"), "Remote endpoint unavailable", true],
		["tls", codedError("CERT_HAS_EXPIRED", "certificate expired for secret.example"), "TLS certificate validation failed", false],
		["timeout", codedError("ETIMEDOUT", "connect ETIMEDOUT 203.0.113.1:443"), "Connection timed out", true],
		["aborted", Object.assign(new Error("request aborted"), { name: "AbortError" }), "Request was aborted", false],
	] as const)("maps %s failures to a bounded safe diagnostic", (kind, cause, diagnostic, retryable) => {
		const source = new TypeError("fetch failed", { cause });
		const failure = toFetchTransportError(source);

		expect(failure).toBeInstanceOf(FetchTransportError);
		expect(failure.code).toBe("fetch-transport-failed");
		expect(failure.kind).toBe(kind);
		expect(failure.diagnostic).toBe(diagnostic);
		expect(failure.retryable).toBe(retryable);
		expect(failure.cause).toBe(source);
		expect(failure.message.length).toBeLessThanOrEqual(120);
		expect(failure.message).not.toContain("secret.example");
		expect(failure.message).not.toContain("top-secret");
	});

	it("recognizes Bun's socket-open failure without exposing its raw URL hint", () => {
		const source = Object.assign(new Error("Was there a typo in the url or port?"), { code: "FailedToOpenSocket" });
		const failure = toFetchTransportError(source);

		expect(failure).toMatchObject({ kind: "connection", diagnostic: "Remote endpoint unavailable", retryable: true });
		expect(failure.cause).toBe(source);
	});

	it("does not expose arbitrary non-Error throws", () => {
		const failure = toFetchTransportError({ authorization: "Bearer top-secret", message: "private backend detail" });

		expect(failure.kind).toBe("unknown");
		expect(failure.diagnostic).toBe("HTTP transport unavailable");
		expect(failure.message).not.toContain("top-secret");
		expect(failure.message).not.toContain("private backend detail");
	});
});

describe("spider transport exception translation", () => {
	it("translates a nested native fetch cause into a typed domain error", async () => {
		const cause = codedError("ENOTFOUND", "getaddrinfo ENOTFOUND api.example.test?api_key=top-secret");
		const source = new TypeError("fetch failed", { cause });

		const failure = await spider("https://example.test/resource", { httpClient: throwingClient(source) }).catch((error) => error);

		expect(failure).toBeInstanceOf(FetchTransportError);
		expect(failure).toMatchObject({ code: "fetch-transport-failed", kind: "dns", diagnostic: "DNS lookup failed", retryable: true });
		expect(failure.cause).toBe(source);
	});

	it("does not misclassify an adapter programming failure as a network outage", async () => {
		const source = new TypeError("Map operation called on non-Map object");

		const failure = await spider("https://example.test/resource", { httpClient: throwingClient(source) }).catch((error) => error);

		expect(failure).toBe(source);
		expect(failure).not.toBeInstanceOf(FetchTransportError);
	});

	it("distinguishes spider's own timeout from an adapter abort", async () => {
		const timeoutClient: IHttpClient = {
			fetch: (request) =>
				new Promise((_resolve, reject) => {
					request.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), {
						once: true,
					});
				}),
		};

		const timedOut = await spider("https://example.test/slow", { httpClient: timeoutClient, timeoutMs: 5 }).catch((error) => error);
		const aborted = await spider("https://example.test/aborted", {
			httpClient: throwingClient(Object.assign(new Error("aborted by adapter"), { name: "AbortError" })),
		}).catch((error) => error);

		expect(timedOut).toMatchObject({ code: "fetch-transport-failed", kind: "timeout", diagnostic: "Request timed out", retryable: true });
		expect(aborted).toMatchObject({ code: "fetch-transport-failed", kind: "aborted", diagnostic: "Request was aborted", retryable: false });
	});
});
