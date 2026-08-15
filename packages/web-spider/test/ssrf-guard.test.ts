import { describe, expect, it, vi } from "vitest";
import { SsrfBlockedError } from "../src/errors.js";
import { DefaultSsrfGuard, isBlockedAddress } from "../src/fetch/ssrf-guard.js";

describe("isBlockedAddress", () => {
	it.each([
		["127.0.0.1", "loopback"],
		["10.1.2.3", "RFC1918 10/8"],
		["172.16.0.1", "RFC1918 172.16/12"],
		["192.168.1.1", "RFC1918 192.168/16"],
		["169.254.169.254", "link-local / cloud metadata"],
		["100.64.0.1", "carrier-grade NAT"],
		["0.0.0.0", "unspecified"],
		["255.255.255.255", "broadcast"],
		["224.0.0.1", "multicast"],
	])("blocks %s (%s)", (address) => {
		expect(isBlockedAddress(address)).toBe(true);
	});

	it.each([["8.8.8.8"], ["1.1.1.1"], ["93.184.216.34"]])("does not block public address %s", (address) => {
		expect(isBlockedAddress(address)).toBe(false);
	});

	it.each([
		["192.0.2.5", "TEST-NET-1"],
		["198.51.100.5", "TEST-NET-2"],
		["203.0.113.5", "TEST-NET-3"],
	])("blocks reserved documentation range %s (%s)", (address) => {
		expect(isBlockedAddress(address)).toBe(true);
	});

	it("blocks IPv6 loopback and unique-local/link-local ranges", () => {
		expect(isBlockedAddress("::1")).toBe(true);
		expect(isBlockedAddress("fc00::1")).toBe(true);
		expect(isBlockedAddress("fe80::1")).toBe(true);
	});

	it("does not block a public IPv6 address", () => {
		expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
	});

	it("blocks an IPv4-mapped IPv6 address whose embedded IPv4 is blocked", () => {
		expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
		expect(isBlockedAddress("::ffff:10.0.0.1")).toBe(true);
	});

	it("does not block an IPv4-mapped IPv6 address whose embedded IPv4 is public", () => {
		expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
	});
});

describe("DefaultSsrfGuard.assertAllowed", () => {
	it("throws SsrfBlockedError for a literal blocked IPv4 target", async () => {
		const guard = new DefaultSsrfGuard();
		await expect(guard.assertAllowed("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(SsrfBlockedError);
	});

	it("throws SsrfBlockedError for a literal blocked IPv6 target", async () => {
		const guard = new DefaultSsrfGuard();
		await expect(guard.assertAllowed("http://[::1]/")).rejects.toBeInstanceOf(SsrfBlockedError);
	});

	it("does not throw for a literal public IPv4 target", async () => {
		const guard = new DefaultSsrfGuard();
		await expect(guard.assertAllowed("http://93.184.216.34/")).resolves.toBeUndefined();
	});

	it("blocks a hostname that resolves (via the OS resolver, no network) to loopback", async () => {
		const guard = new DefaultSsrfGuard();
		await expect(guard.assertAllowed("http://localhost/")).rejects.toBeInstanceOf(SsrfBlockedError);
	});

	it("allowRanges lets an explicitly opted-in blocked address through", async () => {
		const guard = new DefaultSsrfGuard({ allowRanges: ["169.254.169.254/32"] });
		await expect(guard.assertAllowed("http://169.254.169.254/")).resolves.toBeUndefined();
		await expect(guard.assertAllowed("http://127.0.0.1/")).rejects.toBeInstanceOf(SsrfBlockedError);
	});

	it("rejects a malformed allowRanges entry eagerly, at construction", () => {
		expect(() => new DefaultSsrfGuard({ allowRanges: ["not-an-ip"] })).toThrow();
	});
});

describe("DefaultSsrfGuard.assertAllowed — DNS-resolved hostname, mocked resolver", () => {
	it("blocks when the resolved address is private, even though the hostname itself looks public", async () => {
		vi.resetModules();
		vi.doMock("node:dns/promises", () => ({
			lookup: vi.fn().mockResolvedValue([{ address: "10.0.0.5", family: 4 }]),
		}));
		const { DefaultSsrfGuard: MockedGuard } = await import("../src/fetch/ssrf-guard.js");
		const { SsrfBlockedError: MockedError } = await import("../src/errors.js");
		const guard = new MockedGuard();
		await expect(guard.assertAllowed("http://internal-rebind.example/")).rejects.toBeInstanceOf(MockedError);
		vi.doUnmock("node:dns/promises");
		vi.resetModules();
	});

	it("allows when every resolved address is public", async () => {
		vi.resetModules();
		vi.doMock("node:dns/promises", () => ({
			lookup: vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]),
		}));
		const { DefaultSsrfGuard: MockedGuard } = await import("../src/fetch/ssrf-guard.js");
		const guard = new MockedGuard();
		await expect(guard.assertAllowed("http://looks-public.example/")).resolves.toBeUndefined();
		vi.doUnmock("node:dns/promises");
		vi.resetModules();
	});
});
