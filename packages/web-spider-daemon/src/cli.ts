#!/usr/bin/env bun
/**
 * CLI entry point — mirrors jittor/src/cli.ts's service-install shape.
 * Full operation parity (fetch/crawl/search/cache subcommands) lands in the
 * CLI-parity task; the walking skeleton only proves serve + service install.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEMD_UNIT_NAME } from "./constants.ts";
import { serveMain } from "./daemon.ts";
import { resolveWebSpiderPaths } from "./state.ts";

export interface SystemdUnitOptions {
	bunBin: string;
	cliPath: string;
}

export function renderSystemdUnit(options: SystemdUnitOptions): string {
	return `[Unit]
Description=Web Spider search, query, and scraping daemon
After=default.target network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${options.bunBin} ${options.cliPath} serve
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;
}

function systemctl(...args: string[]): void {
	execFileSync("systemctl", ["--user", ...args], { stdio: "inherit" });
}

function installService(): void {
	const unitPath = resolveWebSpiderPaths().systemdUnit;
	mkdirSync(dirname(unitPath), { recursive: true });
	writeFileSync(unitPath, renderSystemdUnit({
		bunBin: process.execPath,
		cliPath: fileURLToPath(import.meta.url),
	}));
	systemctl("daemon-reload");
	systemctl("enable", SYSTEMD_UNIT_NAME);
	systemctl("restart", SYSTEMD_UNIT_NAME);
}

export interface CliDependencies {
	stdout(line: string): void;
	stderr(line: string): void;
	systemctl(...args: string[]): void;
	installService(): void;
	serve(): void;
}

const DEFAULT_DEPENDENCIES: CliDependencies = {
	stdout: console.log,
	stderr: console.error,
	systemctl,
	installService,
	serve: serveMain,
};

function usage(stderr: (line: string) => void): number {
	stderr("Usage: web-spider serve | service <install|start|stop|restart|status>");
	return 2;
}

export function runCli(args: string[], deps: CliDependencies = DEFAULT_DEPENDENCIES): number {
	const [command, action] = args;
	if (command === "serve") { deps.serve(); return 0; }
	if (command !== "service") return usage(deps.stderr);
	switch (action) {
		case "install": deps.installService(); return 0;
		case "start": deps.systemctl("start", SYSTEMD_UNIT_NAME); return 0;
		case "stop": deps.systemctl("stop", SYSTEMD_UNIT_NAME); return 0;
		case "restart": deps.systemctl("restart", SYSTEMD_UNIT_NAME); return 0;
		case "status": deps.systemctl("status", SYSTEMD_UNIT_NAME); return 0;
		default: return usage(deps.stderr);
	}
}

export function main(args: string[] = process.argv.slice(2)): void {
	process.exitCode = runCli(args);
}

if (import.meta.main) main();
