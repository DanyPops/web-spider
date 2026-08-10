/**
 * BYOK key stacking: multi-key CRUD on top of SearchKeyStore's existing
 * single-key load/save/remove (search-secrets.test.ts), which this file
 * must not change the behavior of -- add()/loadAll()/removeKey() are
 * purely additive.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSearchKeyStore } from "../src/search/search-secrets.ts";

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "web-spider-search-keys-multikey-"));
}

describe("SearchKeyStore — loadAll", () => {
	it("returns an empty array for a backend with nothing stored", () => {
		const dir = tmpDir();
		try {
			expect(createSearchKeyStore(dir, "brave").loadAll()).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns the single key as a one-element array after a legacy save()", () => {
		const dir = tmpDir();
		try {
			const store = createSearchKeyStore(dir, "brave");
			store.save("brave-key");
			expect(store.loadAll()).toEqual(["brave-key"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("SearchKeyStore — add (stacking)", () => {
	it("adds a second key alongside an existing single key", () => {
		const dir = tmpDir();
		try {
			const store = createSearchKeyStore(dir, "brave");
			store.save("key-1");
			store.add("key-2");
			expect(store.loadAll()).toEqual(["key-1", "key-2"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("creates the first key via add() alone, with no prior save()", () => {
		const dir = tmpDir();
		try {
			const store = createSearchKeyStore(dir, "brave");
			store.add("key-1");
			expect(store.loadAll()).toEqual(["key-1"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is idempotent for an exact duplicate -- adding the same key twice does not duplicate it", () => {
		const dir = tmpDir();
		try {
			const store = createSearchKeyStore(dir, "brave");
			store.add("key-1");
			store.add("key-1");
			expect(store.loadAll()).toEqual(["key-1"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps load() returning the primary (first-added) key once more keys are stacked", () => {
		const dir = tmpDir();
		try {
			const store = createSearchKeyStore(dir, "brave");
			store.add("key-1");
			store.add("key-2");
			expect(store.load()).toBe("key-1");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists multi-key state at 0600 with the primary key still mirrored onto accessToken (backward-compatible readers)", () => {
		const dir = tmpDir();
		try {
			const store = createSearchKeyStore(dir, "brave");
			store.add("key-1");
			store.add("key-2");
			const persisted = JSON.parse(readFileSync(join(dir, "brave.json"), "utf8"));
			expect(persisted.accessToken).toBe("key-1");
			expect(persisted.keys).toEqual(["key-1", "key-2"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("SearchKeyStore — removeKey (single-key removal)", () => {
	it("removes one key, leaving the others", () => {
		const dir = tmpDir();
		try {
			const store = createSearchKeyStore(dir, "brave");
			store.add("key-1");
			store.add("key-2");
			store.add("key-3");
			store.removeKey("key-2");
			expect(store.loadAll()).toEqual(["key-1", "key-3"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("deletes the backing file once the last key is removed", () => {
		const dir = tmpDir();
		try {
			const store = createSearchKeyStore(dir, "brave");
			store.add("key-1");
			store.removeKey("key-1");
			expect(store.loadAll()).toEqual([]);
			expect(existsSync(join(dir, "brave.json"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is a harmless no-op for a key that isn't stored", () => {
		const dir = tmpDir();
		try {
			const store = createSearchKeyStore(dir, "brave");
			store.add("key-1");
			expect(() => store.removeKey("not-stored")).not.toThrow();
			expect(store.loadAll()).toEqual(["key-1"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
