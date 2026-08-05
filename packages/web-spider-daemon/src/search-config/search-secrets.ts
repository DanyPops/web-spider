/**
 * Local, file-backed fallback for search-provider API keys -- the tier
 * between a raw env var (ambient, and on a systemd --user unit inherited
 * far more broadly than intended: this daemon's own process environment
 * carries the whole desktop session's secrets, not just its own) and
 * Enigma (checked first when WEB_SPIDER_USE_ENIGMA is set). Reuses
 * vehicle-server's shared vault.ts file mechanics (atomic write, 0600) purely
 * for a bare API key with no OAuth refresh -- RefreshableAccessToken's
 * accessToken field holds the key; nothing else on that shape is used.
 */
import { existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createFileStore, type RefreshableAccessToken } from "@danypops/vehicle-server/vault";
import type { WebSpiderPaths } from "../state.ts";

export interface SearchKeyStore {
	load(): string | undefined;
	save(apiKey: string): void;
	remove(): void;
}

/** Sibling to the auth-token file, under this daemon's own state directory -- never Enigma's, never any other daemon's. */
export function resolveSearchKeysDir(paths: WebSpiderPaths): string {
	return join(dirname(paths.token), "search-keys");
}

export function createSearchKeyStore(dir: string, backend: string): SearchKeyStore {
	const fileStore = createFileStore<RefreshableAccessToken>(dir, backend);
	const path = join(dir, `${backend}.json`);
	return {
		load: () => fileStore.load()?.accessToken,
		save: (apiKey: string) => fileStore.save({ accessToken: apiKey }),
		remove: () => {
			if (existsSync(path)) unlinkSync(path);
		},
	};
}
