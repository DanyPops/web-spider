import { describe, expect, it } from "bun:test";
import { benchmarkArtifact, runBenchmarkWorkload, WEB_SPIDER_BENCHMARK_SCENARIOS } from "../benchmarks/baseline.ts";

class FakeClient {
	readonly calls: Array<{ operation: string; input: Record<string, unknown> }> = [];

	async call(operation: string, input: Record<string, unknown>): Promise<unknown> {
		this.calls.push({ operation, input });
		if (operation === "fetch") return { title: "Fixture", cache: "hit", markdown: "fixture body" };
		if (operation === "crawl") return { pagesFound: 3, pages: [{ title: "Root" }, { title: "A" }, { title: "B" }] };
		if (operation === "session.create") return { name: input.name, snapshotVersion: 0 };
		if (operation === "session.act") return { name: input.name, snapshotVersion: Number(input.snapshotVersion) + 1 };
		if (operation === "session.close") return { name: input.name, closed: true };
		throw new Error(`unexpected operation ${operation}`);
	}
}

describe("Web Spider benchmark scenarios", () => {
	it("covers all bounded workload classes", () => {
		expect(WEB_SPIDER_BENCHMARK_SCENARIOS.map((scenario) => scenario.name)).toEqual([
			"static-cold",
			"static-warm",
			"rendered-cold",
			"rendered-warm",
			"crawl",
			"session-startup",
			"session-steady",
			"session-concurrent",
		]);
		for (const scenario of WEB_SPIDER_BENCHMARK_SCENARIOS) {
			expect(scenario.repetitions).toBeGreaterThan(0);
			expect(scenario.repetitions).toBeLessThanOrEqual(5);
			expect(scenario.concurrency).toBeLessThanOrEqual(2);
			expect(scenario.deadlineMs).toBeLessThanOrEqual(60_000);
		}
	});

	it("bounds fetch and crawl inputs", async () => {
		const client = new FakeClient();
		const staticDigest = await runBenchmarkWorkload("static-warm", "http://127.0.0.1:1234", client);
		const crawlDigest = await runBenchmarkWorkload("crawl", "http://127.0.0.1:1234", client);
		expect(staticDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(crawlDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(client.calls).toContainEqual({ operation: "fetch", input: expect.objectContaining({ format: "lean" }) });
		expect(client.calls).toContainEqual({
			operation: "crawl",
			input: expect.objectContaining({ depth: 2, maxPages: 5, maxTotalChars: 50_000, deadlineMs: 30_000 }),
		});
	});

	it("bounds browser sessions", async () => {
		const client = new FakeClient();
		const digest = await runBenchmarkWorkload("session-concurrent", "http://127.0.0.1:1234", client, "session-1", 0);
		expect(digest).toMatch(/^[a-f0-9]{64}$/);
		expect(client.calls.map((call) => call.operation)).toEqual(["session.create", "session.act", "session.close"]);
	});

	it("bounds artifacts to measurements and digests", () => {
		const artifact = benchmarkArtifact({
			generatedAt: "2026-01-01T00:00:00.000Z",
			environment: { platform: "linux", architecture: "x64", runtime: "bun", logicalCpuCount: 8 },
			results: [{ name: "static-cold", benchmark: { schemaVersion: 1, vehicle: "bench", workload: { outputDigest: "a".repeat(64) } } }],
		});
		const serialized = JSON.stringify(artifact);
		expect(serialized.length).toBeLessThan(256_000);
		expect(serialized).not.toContain("127.0.0.1");
		expect(serialized).not.toContain("/home/");
		expect(serialized).not.toContain("arguments");
		expect(artifact.schemaVersion).toBe(1);
		expect(artifact.networkBytes).toBe("unavailable");
	});
});
