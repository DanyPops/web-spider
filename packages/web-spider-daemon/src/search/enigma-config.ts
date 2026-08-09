import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WebSpiderPaths } from "../state.ts";

export interface EnigmaConfig {
	useEnigma: boolean;
}

export function resolveEnigmaConfigPath(paths: WebSpiderPaths): string {
	return join(dirname(paths.token), "enigma.json");
}

export function loadEnigmaConfig(path: string): EnigmaConfig {
	if (!existsSync(path)) return { useEnigma: false };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<EnigmaConfig>;
		return { useEnigma: parsed.useEnigma === true };
	} catch {
		return { useEnigma: false };
	}
}

/** Persists only the non-secret opt-in. Enigma's client token remains in Enigma's shared token file. */
export function saveEnigmaConfig(path: string, config: EnigmaConfig): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(config)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
		chmodSync(path, 0o600);
	} finally {
		rmSync(temporary, { force: true });
	}
}
