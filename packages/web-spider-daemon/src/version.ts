/**
 * Runtime package version; package.json is the single release source of
 * truth. This used to be a hand-hardcoded "0.1.0" that drifted silently
 * once the package moved past its first release -- /health kept reporting
 * 0.1.0 while the actual published package was already at 0.11.0. Matches
 * jittor/papyrus/pi-packed's version.ts, which read from package.json for
 * exactly this reason.
 */
import { readFileSync } from "node:fs";

function packageVersion(): string {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as unknown;
	if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
		throw new Error("Web Spider daemon package manifest must be an object");
	}
	const version = (manifest as Record<string, unknown>)["version"];
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
		throw new Error("Web Spider daemon package manifest has an invalid version");
	}
	return version;
}

export const VERSION = packageVersion();
