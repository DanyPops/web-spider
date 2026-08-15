/** Blocks outbound fetches whose DNS-resolved target is loopback/private/link-local/reserved space -- checked against the resolved address, not the hostname string, to survive DNS rebinding. */
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { SsrfBlockedError } from "../errors.js";
import type { ISsrfGuard } from "../ports.js";

const BLOCKED_IPV4_SUBNETS: readonly [address: string, prefix: number][] = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
];
const BLOCKED_IPV4_ADDRESSES: readonly string[] = ["255.255.255.255"];

const BLOCKED_IPV6_SUBNETS: readonly [address: string, prefix: number][] = [
	["fc00::", 7],
	["fe80::", 10],
];
const BLOCKED_IPV6_ADDRESSES: readonly string[] = ["::1"];

function buildBlockList(): BlockList {
	const list = new BlockList();
	for (const [address, prefix] of BLOCKED_IPV4_SUBNETS) list.addSubnet(address, prefix, "ipv4");
	for (const address of BLOCKED_IPV4_ADDRESSES) list.addAddress(address, "ipv4");
	for (const [address, prefix] of BLOCKED_IPV6_SUBNETS) list.addSubnet(address, prefix, "ipv6");
	for (const address of BLOCKED_IPV6_ADDRESSES) list.addAddress(address, "ipv6");
	return list;
}

const defaultBlockList = buildBlockList();

/** ::ffff:a.b.c.d embeds an IPv4 address the IPv6 subnet checks above would miss. */
function embeddedIPv4(address: string): string | undefined {
	const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
	return match?.[1];
}

export function isBlockedAddress(address: string, allowList?: BlockList): boolean {
	const family = isIP(address);
	if (family === 0) return false; // not a literal IP -- caller resolves first
	const familyName = family === 4 ? "ipv4" : "ipv6";

	const mapped = familyName === "ipv6" ? embeddedIPv4(address) : undefined;
	const blocked = defaultBlockList.check(address, familyName) || (mapped !== undefined && defaultBlockList.check(mapped, "ipv4"));
	if (!blocked) return false;

	if (allowList?.check(address, familyName)) return false;
	if (mapped !== undefined && allowList?.check(mapped, "ipv4")) return false;
	return true;
}

export interface SsrfGuardOptions {
	/** CIDR ranges (e.g. "10.0.0.0/8") allowed through despite matching a blocked range. Empty by default. */
	allowRanges?: readonly string[];
}

function parseAllowRanges(ranges: readonly string[] | undefined): BlockList | undefined {
	if (!ranges || ranges.length === 0) return undefined;
	const list = new BlockList();
	for (const range of ranges) {
		const [address, prefixRaw] = range.split("/");
		const family = isIP(address);
		if (family === 0) throw new Error(`Invalid allowRanges entry (not an IP/CIDR): "${range}"`);
		const prefix = prefixRaw === undefined ? (family === 4 ? 32 : 128) : Number.parseInt(prefixRaw, 10);
		list.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
	}
	return list;
}

/** Default-deny outbound-fetch guard -- DNS-resolves the target host (or reads it directly if already a literal IP) and blocks on any resolved address in blocked space. */
export class DefaultSsrfGuard implements ISsrfGuard {
	private readonly allowList: BlockList | undefined;

	constructor(options: SsrfGuardOptions = {}) {
		this.allowList = parseAllowRanges(options.allowRanges);
	}

	async assertAllowed(url: string): Promise<void> {
		// URL.hostname keeps [brackets] around an IPv6 literal; isIP()/dns.lookup() need them stripped.
		const hostname = new URL(url).hostname.replace(/^\[(.+)\]$/, "$1");

		if (isIP(hostname) !== 0) {
			if (isBlockedAddress(hostname, this.allowList)) throw new SsrfBlockedError(hostname, hostname);
			return;
		}

		const records = await dnsLookup(hostname, { all: true, verbatim: true });
		for (const { address } of records) {
			if (isBlockedAddress(address, this.allowList)) throw new SsrfBlockedError(hostname, address);
		}
	}
}

/** Factory -- avoids jiti/Bun CJS re-export interop where a class constructor can appear undefined at call site. */
export function createSsrfGuard(options?: SsrfGuardOptions): DefaultSsrfGuard {
	return new DefaultSsrfGuard(options);
}
