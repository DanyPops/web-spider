import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSearchKeyStore, resolveSearchKeysDir } from "../src/search-config/search-secrets.ts";

describe("resolveSearchKeysDir", () => {
	it("is a sibling directory of the auth token file, under this daemon's own state directory", () => {
		const dir = resolveSearchKeysDir({
			database: "/x/db",
			token: "/home/u/.local/state/web-spider/token",
			handle: "/x/h",
			systemdUnit: "/x/s",
		});
		expect(dir).toBe("/home/u/.local/state/web-spider/search-keys");
	});
});

describe("createSearchKeyStore", () => {
	it("returns undefined for a backend with nothing stored yet", () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-keys-"));
		try {
			expect(createSearchKeyStore(dir, "brave").load()).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("round-trips a key through save/load", () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-keys-"));
		try {
			const store = createSearchKeyStore(dir, "tavily");
			store.save("tvly-real-key");
			expect(store.load()).toBe("tvly-real-key");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps two engines in separate files, never colliding", () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-keys-"));
		try {
			createSearchKeyStore(dir, "brave").save("brave-key");
			createSearchKeyStore(dir, "exa").save("exa-key");
			expect(createSearchKeyStore(dir, "brave").load()).toBe("brave-key");
			expect(createSearchKeyStore(dir, "exa").load()).toBe("exa-key");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("writes the file at 0600, atomically, matching daemon-kit's own file-store guarantee", () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-keys-"));
		try {
			createSearchKeyStore(dir, "brave").save("brave-key");
			const path = join(dir, "brave.json");
			expect(existsSync(path)).toBe(true);
			const mode = statSync(path).mode & 0o777;
			expect(mode).toBe(0o600);
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ accessToken: "brave-key" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("remove() deletes the stored key's file", () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-keys-"));
		try {
			const store = createSearchKeyStore(dir, "brave");
			store.save("brave-key");
			expect(store.load()).toBe("brave-key");
			store.remove();
			expect(store.load()).toBeUndefined();
			expect(existsSync(join(dir, "brave.json"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("remove() on a backend with nothing stored is a harmless no-op", () => {
		const dir = mkdtempSync(join(tmpdir(), "web-spider-search-keys-"));
		try {
			expect(() => createSearchKeyStore(dir, "brave").remove()).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
