import { describe, expect, test } from "bun:test";
import { renderSystemdUnit, runCli, type CliDependencies } from "../src/cli.ts";

function fakeDeps(overrides: Partial<CliDependencies> = {}): { deps: CliDependencies; calls: string[] } {
	const calls: string[] = [];
	const deps: CliDependencies = {
		stdout: (line) => calls.push(`stdout:${line}`),
		stderr: (line) => calls.push(`stderr:${line}`),
		systemctl: (...args) => calls.push(`systemctl:${args.join(" ")}`),
		installService: () => calls.push("install"),
		serve: () => calls.push("serve"),
		...overrides,
	};
	return { deps, calls };
}

describe("renderSystemdUnit", () => {
	test("renders a restart-always, no-new-privileges unit invoking serve", () => {
		const unit = renderSystemdUnit({ bunBin: "/usr/bin/bun", cliPath: "/opt/web-spider/cli.ts" });
		expect(unit).toContain("ExecStart=/usr/bin/bun /opt/web-spider/cli.ts serve");
		expect(unit).toContain("Restart=always");
		expect(unit).toContain("NoNewPrivileges=true");
		expect(unit).toContain("PrivateTmp=true");
	});
});

describe("runCli", () => {
	test("serve invokes the serve dependency", () => {
		const { deps, calls } = fakeDeps();
		const code = runCli(["serve"], deps);
		expect(code).toBe(0);
		expect(calls).toContain("serve");
	});

	test("service install invokes installService", () => {
		const { deps, calls } = fakeDeps();
		expect(runCli(["service", "install"], deps)).toBe(0);
		expect(calls).toContain("install");
	});

	for (const action of ["start", "stop", "restart", "status"]) {
		test(`service ${action} calls systemctl --user ${action} web-spider.service`, () => {
			const { deps, calls } = fakeDeps();
			expect(runCli(["service", action], deps)).toBe(0);
			expect(calls).toContain(`systemctl:${action} web-spider.service`);
		});
	}

	test("unknown command prints usage and returns exit code 2", () => {
		const { deps, calls } = fakeDeps();
		expect(runCli(["bogus"], deps)).toBe(2);
		expect(calls.some((c) => c.startsWith("stderr:Usage:"))).toBe(true);
	});

	test("unknown service action prints usage and returns exit code 2", () => {
		const { deps, calls } = fakeDeps();
		expect(runCli(["service", "bogus"], deps)).toBe(2);
		expect(calls.some((c) => c.startsWith("stderr:Usage:"))).toBe(true);
	});
});
