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
	/** The primary (first-added) key. */
	load(): string | undefined;
	/** Replaces the whole stored list with exactly this one key -- unchanged historical behavior (overwrite, not append). Use {@link SearchKeyStore.add} to stack an additional key instead. */
	save(apiKey: string): void;
	/** Deletes every stored key for this provider (the whole backing file). */
	remove(): void;
	/** Every stored key for this provider, in the order added. Empty array if none stored. */
	loadAll(): string[];
	/** Appends one more key for BYOK stacking. Idempotent for an exact duplicate. Creates the first entry if none exists yet, same as {@link SearchKeyStore.save} would. */
	add(apiKey: string): void;
	/** Removes one specific key by exact value. No-op if it isn't stored. Deletes the backing file once the last key is removed. */
	removeKey(apiKey: string): void;
}

/** Persisted shape: `keys` is the authoritative full ordered list once more than one key is stacked; `accessToken` always mirrors keys[0] so a reader that only knows the legacy single-key shape (or a plain save()) keeps working unchanged. Absent `keys` (a legacy file, or one written by a plain save()) means exactly one key: accessToken itself. */
interface StoredKeyRecord extends RefreshableAccessToken {
	keys?: string[];
}

function storedKeys(record: StoredKeyRecord | undefined): string[] {
	if (!record) return [];
	if (record.keys && record.keys.length > 0) return record.keys;
	return record.accessToken ? [record.accessToken] : [];
}

/** Sibling to the auth-token file, under this daemon's own state directory -- never Enigma's, never any other daemon's. */
export function resolveSearchKeysDir(paths: WebSpiderPaths): string {
	return join(dirname(paths.token), "search-keys");
}

export function createSearchKeyStore(dir: string, backend: string): SearchKeyStore {
	const fileStore = createFileStore<StoredKeyRecord>(dir, backend);
	const path = join(dir, `${backend}.json`);
	return {
		load: () => storedKeys(fileStore.load())[0],
		save: (apiKey: string) => fileStore.save({ accessToken: apiKey }),
		remove: () => {
			if (existsSync(path)) unlinkSync(path);
		},
		loadAll: () => storedKeys(fileStore.load()),
		add: (apiKey: string) => {
			const keys = storedKeys(fileStore.load());
			if (keys.includes(apiKey)) return;
			const next = [...keys, apiKey];
			fileStore.save({ accessToken: next[0] as string, keys: next });
		},
		removeKey: (apiKey: string) => {
			const next = storedKeys(fileStore.load()).filter((key) => key !== apiKey);
			if (next.length === 0) {
				if (existsSync(path)) unlinkSync(path);
				return;
			}
			fileStore.save({ accessToken: next[0] as string, keys: next });
		},
	};
}
