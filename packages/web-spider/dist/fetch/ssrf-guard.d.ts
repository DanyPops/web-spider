import { BlockList } from "node:net";
import type { ISsrfGuard } from "../ports.js";
export declare function isBlockedAddress(address: string, allowList?: BlockList): boolean;
export interface SsrfGuardOptions {
    /** CIDR ranges (e.g. "10.0.0.0/8") allowed through despite matching a blocked range. Empty by default. */
    allowRanges?: readonly string[];
}
/** Default-deny outbound-fetch guard -- DNS-resolves the target host (or reads it directly if already a literal IP) and blocks on any resolved address in blocked space. */
export declare class DefaultSsrfGuard implements ISsrfGuard {
    private readonly allowList;
    constructor(options?: SsrfGuardOptions);
    assertAllowed(url: string): Promise<void>;
}
/** Factory -- avoids jiti/Bun CJS re-export interop where a class constructor can appear undefined at call site. */
export declare function createSsrfGuard(options?: SsrfGuardOptions): DefaultSsrfGuard;
//# sourceMappingURL=ssrf-guard.d.ts.map