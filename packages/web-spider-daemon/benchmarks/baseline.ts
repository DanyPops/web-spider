import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { cpus, homedir, platform, arch, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectWebSpiderClient } from "../src/client.ts";
import { readDaemonHandle, resolveWebSpiderPaths } from "../src/state.ts";

const MAX_COMMAND_OUTPUT_BYTES = 256_000;
const MAX_ARTIFACT_BYTES = 256_000;
const SERVICE_READY_DEADLINE_MS = 15_000;
const BENCHMARK_FILE = ".artifacts/benchmarks/web-spider-baseline.json";

type BenchmarkMode =
	| "static-cold"
	| "static-warm"
	| "rendered-cold"
	| "rendered-warm"
	| "crawl"
	| "session-startup"
	| "session-steady"
	| "session-concurrent";

export interface BenchmarkScenario {
	readonly name: BenchmarkMode;
	readonly warmup: number;
	readonly repetitions: number;
	readonly concurrency: number;
	readonly deadlineMs: number;
}

export const WEB_SPIDER_BENCHMARK_SCENARIOS: readonly BenchmarkScenario[] = Object.freeze([
	{ name: "static-cold", warmup: 0, repetitions: 1, concurrency: 1, deadlineMs: 30_000 },
	{ name: "static-warm", warmup: 1, repetitions: 5, concurrency: 1, deadlineMs: 30_000 },
	{ name: "rendered-cold", warmup: 0, repetitions: 1, concurrency: 1, deadlineMs: 60_000 },
	{ name: "rendered-warm", warmup: 1, repetitions: 3, concurrency: 1, deadlineMs: 60_000 },
	{ name: "crawl", warmup: 1, repetitions: 3, concurrency: 1, deadlineMs: 60_000 },
	{ name: "session-startup", warmup: 0, repetitions: 3, concurrency: 1, deadlineMs: 60_000 },
	{ name: "session-steady", warmup: 1, repetitions: 5, concurrency: 1, deadlineMs: 60_000 },
	{ name: "session-concurrent", warmup: 0, repetitions: 2, concurrency: 2, deadlineMs: 60_000 },
]);

function isBenchmarkMode(value: string | undefined): value is BenchmarkMode {
	return WEB_SPIDER_BENCHMARK_SCENARIOS.some((scenario) => scenario.name === value);
}

interface BenchmarkClient {
	call(operation: string, input: Record<string, unknown>): Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Runs one deterministic workload and returns only a correctness digest. */
export async function runBenchmarkWorkload(
	mode: BenchmarkMode,
	baseUrl: string,
	client: BenchmarkClient,
	sessionName = `benchmark-${process.pid}`,
	snapshotVersion = 0,
): Promise<string> {
	if (mode === "static-cold" || mode === "static-warm") {
		const url = mode === "static-cold" ? `${baseUrl}/static?invocation=${process.pid}` : `${baseUrl}/static`;
		const result = record(await client.call("fetch", { url, format: "lean", ...(mode === "static-cold" ? { maxCacheAgeMs: 0 } : {}) }));
		return digest({ title: result.title, cache: result.cache, headings: Array.isArray(result.headings) ? result.headings.length : 0 });
	}
	if (mode === "rendered-cold" || mode === "rendered-warm") {
		const result = record(
			await client.call("fetch", { url: `${baseUrl}/rendered`, format: "lean", enhanced: true, maxCacheAgeMs: 0, timeoutMs: 30_000 }),
		);
		return digest({ title: result.title, headings: Array.isArray(result.headings) ? result.headings.length : 0 });
	}
	if (mode === "crawl") {
		const result = record(
			await client.call("crawl", {
				url: `${baseUrl}/crawl`,
				format: "lean",
				depth: 2,
				maxPages: 5,
				maxTotalChars: 50_000,
				deadlineMs: 30_000,
			}),
		);
		return digest({ pagesFound: result.pagesFound, pages: Array.isArray(result.pages) ? result.pages.length : 0 });
	}
	if (mode === "session-steady") {
		const result = record(
			await client.call("session.act", {
				name: sessionName,
				snapshotVersion,
				action: "navigate",
				url: `${baseUrl}/rendered`,
				timeoutMs: 30_000,
			}),
		);
		return digest({ snapshotVersion: result.snapshotVersion });
	}
	const created = record(await client.call("session.create", { name: sessionName }));
	let acted: Record<string, unknown> = {};
	let closed: Record<string, unknown> = {};
	try {
		acted = record(
			await client.call("session.act", {
				name: sessionName,
				snapshotVersion: Number(created.snapshotVersion ?? 0),
				action: "navigate",
				url: `${baseUrl}/rendered`,
				timeoutMs: 30_000,
			}),
		);
	} finally {
		closed = record(await client.call("session.close", { name: sessionName }));
	}
	return digest({ createdVersion: created.snapshotVersion, actedVersion: acted.snapshotVersion, closed: closed.closed });
}

interface ArtifactInput {
	readonly generatedAt: string;
	readonly environment: { readonly platform: string; readonly architecture: string; readonly runtime: string; readonly logicalCpuCount: number };
	readonly results: readonly { readonly name: string; readonly benchmark: unknown }[];
}

export function benchmarkArtifact(input: ArtifactInput): {
	readonly schemaVersion: 1;
	readonly generatedAt: string;
	readonly environment: ArtifactInput["environment"];
	readonly networkBytes: "unavailable";
	readonly results: ArtifactInput["results"];
} {
	const artifact = { schemaVersion: 1 as const, generatedAt: input.generatedAt, environment: input.environment, networkBytes: "unavailable" as const, results: input.results };
	if (Buffer.byteLength(JSON.stringify(artifact)) > MAX_ARTIFACT_BYTES) throw new Error("benchmark artifact exceeds 256000 bytes");
	return artifact;
}

function isolatedEnvironment(root: string): Record<string, string> {
	return {
		...(process.env as Record<string, string>),
		HOME: root,
		XDG_DATA_HOME: join(root, "data"),
		XDG_STATE_HOME: join(root, "state"),
		XDG_RUNTIME_DIR: join(root, "run"),
		WEB_SPIDER_CACHE_PATH: join(root, "no-legacy-cache.json"),
		WEB_SPIDER_SSRF_ALLOW_RANGES: "127.0.0.1/32,::1/128",
		PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright"),
	};
}

function fixtureHtml(title: string, links: readonly string[] = []): string {
	return `<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>Deterministic benchmark content long enough for extraction and stable correctness checks.</p>${links.map((href) => `<a href="${href}">${href}</a>`).join("")}</article></body></html>`;
}

function startFixtureServer(): { readonly baseUrl: string; close(): void } {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
			if (path === "/crawl") return new Response(fixtureHtml("Crawl root", ["/crawl/a", "/crawl/b"]), { headers: { "content-type": "text/html" } });
			if (path === "/crawl/a") return new Response(fixtureHtml("Crawl A", ["/crawl/b"]), { headers: { "content-type": "text/html" } });
			if (path === "/crawl/b") return new Response(fixtureHtml("Crawl B"), { headers: { "content-type": "text/html" } });
			if (path === "/rendered") {
				return new Response(`${fixtureHtml("Rendered fixture")}<script>document.querySelector('h1').textContent='Rendered ready'</script>`, {
					headers: { "content-type": "text/html" },
				});
			}
			return new Response(fixtureHtml("Static fixture"), { headers: { "content-type": "text/html" } });
		},
	});
	return { baseUrl: `http://127.0.0.1:${server.port}`, close: () => server.stop(true) };
}

function commandResult(
	command: string,
	arguments_: readonly string[],
	environment: Record<string, string> = process.env as Record<string, string>,
): Promise<{ readonly ok: boolean; readonly stdout: string }> {
	return new Promise((resolveCommand) => {
		execFile(command, [...arguments_], { env: environment, encoding: "utf8", maxBuffer: MAX_COMMAND_OUTPUT_BYTES, timeout: 180_000 }, (error, stdout) => {
			resolveCommand({ ok: !error, stdout });
		});
	});
}

async function command(commandName: string, arguments_: readonly string[], environment?: Record<string, string>): Promise<string> {
	const result = await commandResult(commandName, arguments_, environment);
	if (!result.ok) throw new Error(`benchmark command failed: ${basename(commandName)}`);
	return result.stdout;
}

async function waitForService(root: string, environment: Record<string, string>): Promise<void> {
	const paths = resolveWebSpiderPaths({ env: environment, home: root, uid: process.getuid?.() ?? 0 });
	const deadline = Date.now() + SERVICE_READY_DEADLINE_MS;
	while (Date.now() < deadline) {
		if (readDaemonHandle(paths)) return;
		await Bun.sleep(50);
	}
	throw new Error("benchmark service readiness deadline exceeded");
}

async function stopUnit(unit: string): Promise<void> {
	try {
		await command("systemctl", ["--user", "stop", unit]);
	} catch {
		// Cleanup remains best-effort after a failed or already-collected transient unit.
	}
}

async function runScenario(scenario: BenchmarkScenario, baseUrl: string, index: number): Promise<{ readonly name: string; readonly benchmark: unknown }> {
	const root = await mkdtemp(join(tmpdir(), "web-spider-benchmark-"));
	const environment = isolatedEnvironment(root);
	const vehicle = `web-spider-bench-${index}`;
	const unit = `armada-${vehicle}.service`;
	const daemonCli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
	const workloadFile = fileURLToPath(import.meta.url);
	const manifestPath = join(root, "armada.json");
	const paths = resolveWebSpiderPaths({ env: environment, home: root, uid: process.getuid?.() ?? 0 });
	await mkdir(environment.XDG_RUNTIME_DIR ?? join(root, "run"), { recursive: true });
	await writeFile(
		manifestPath,
		JSON.stringify({
			schemaVersion: 1,
			vehicles: [
				{
					name: vehicle,
					version: "0.0.0",
					executable: process.execPath,
					arguments: [daemonCli, "serve"],
					handlePath: paths.handle,
					restart: { policy: "never" },
					readiness: { timeoutMs: SERVICE_READY_DEADLINE_MS, pollIntervalMs: 50 },
				},
			],
		}),
	);
	try {
		const envArguments = ["HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "WEB_SPIDER_CACHE_PATH", "WEB_SPIDER_SSRF_ALLOW_RANGES", "PLAYWRIGHT_BROWSERS_PATH"].map(
			(name) => `--setenv=${name}=${environment[name] ?? ""}`,
		);
		await command("systemd-run", [
			"--user",
			`--unit=${unit}`,
			"--collect",
			"--property=Type=exec",
			"--property=Restart=no",
			...envArguments,
			process.execPath,
			daemonCli,
			"serve",
		]);
		await waitForService(root, environment);
		const sessionName = `steady-${index}`;
		if (scenario.name === "session-steady") {
			const client = connectWebSpiderClient(paths);
			await client.call("session.create", { name: sessionName });
			await writeFile(join(root, "snapshot-version"), "0");
		}
		const armada = process.env.ARMADA_BIN ?? "armada";
		const armadaArguments = [
			"benchmark",
			vehicle,
			"--manifest",
			manifestPath,
			"--exec",
			process.execPath,
			"--arg",
			workloadFile,
			"--arg",
			"workload",
			"--arg",
			scenario.name,
			"--arg",
			root,
			"--arg",
			baseUrl,
			"--arg",
			sessionName,
			"--warmup",
			String(scenario.warmup),
			"--repetitions",
			String(scenario.repetitions),
			"--concurrency",
			String(scenario.concurrency),
			"--deadline-ms",
			String(scenario.deadlineMs),
			"--sample-ms",
			"25",
			"--max-output-bytes",
			"1024",
			"--json",
		];
		const armadaResult = await commandResult(armada, armadaArguments);
		const output = JSON.parse(armadaResult.stdout) as {
			benchmark?: { workload?: { failureCodes?: Record<string, number> } };
			diagnostics?: Array<{ code?: string }>;
		};
		if (!armadaResult.ok) {
			const failureCode = Object.keys(output.benchmark?.workload?.failureCodes ?? {})[0] ?? output.diagnostics?.[0]?.code ?? "unknown";
			throw new Error(`${scenario.name} benchmark failed: ${failureCode}`);
		}
		if (output.benchmark === undefined) throw new Error("benchmark result missing");
		if (scenario.name === "session-steady") {
			const client = connectWebSpiderClient(paths);
			await client.call("session.close", { name: sessionName });
		}
		return { name: scenario.name, benchmark: output.benchmark };
	} finally {
		await stopUnit(unit);
		await rm(root, { recursive: true, force: true });
	}
}

async function workloadMain(args: readonly string[]): Promise<void> {
	const [mode, root, baseUrl, sessionName] = args;
	if (!isBenchmarkMode(mode) || !root || !baseUrl || !sessionName)
		throw new Error("invalid benchmark workload input");
	const environment = isolatedEnvironment(root);
	const paths = resolveWebSpiderPaths({ env: environment, home: root, uid: process.getuid?.() ?? 0 });
	const client = connectWebSpiderClient(paths);
	let snapshotVersion = 0;
	if (mode === "session-steady") snapshotVersion = Number(await readFile(join(root, "snapshot-version"), "utf8"));
	const workloadSessionName = mode === "session-steady" ? sessionName : `${sessionName}-${process.pid}`;
	const correctnessDigest = await runBenchmarkWorkload(mode, baseUrl, client, workloadSessionName, snapshotVersion);
	if (mode === "session-steady") await writeFile(join(root, "snapshot-version"), String(snapshotVersion + 1));
	process.stdout.write(`${correctnessDigest}\n`);
}

async function baselineMain(): Promise<void> {
	if (platform() !== "linux") throw new Error("Web Spider cgroup benchmarks require Linux");
	const fixture = startFixtureServer();
	try {
		const results = [];
		for (let index = 0; index < WEB_SPIDER_BENCHMARK_SCENARIOS.length; index++) {
			const scenario = WEB_SPIDER_BENCHMARK_SCENARIOS[index];
			if (scenario) results.push(await runScenario(scenario, fixture.baseUrl, index));
		}
		const artifact = benchmarkArtifact({
			generatedAt: new Date().toISOString(),
			environment: { platform: platform(), architecture: arch(), runtime: basename(process.execPath), logicalCpuCount: cpus().length },
			results,
		});
		const destination = join(fileURLToPath(new URL("../../../", import.meta.url)), BENCHMARK_FILE);
		await mkdir(dirname(destination), { recursive: true });
		const temporary = `${destination}.tmp`;
		await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`);
		await rename(temporary, destination);
		process.stdout.write(`Web Spider benchmark: ${results.length} workloads; artifact ${BENCHMARK_FILE}\n`);
	} finally {
		fixture.close();
	}
}

if (import.meta.main) {
	try {
		if (process.argv[2] === "workload") await workloadMain(process.argv.slice(3));
		else await baselineMain();
	} catch (error) {
		process.stderr.write(`Web Spider benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
