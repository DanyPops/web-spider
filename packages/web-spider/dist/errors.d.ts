export type FetchTransportFailureKind = "dns" | "connection" | "tls" | "timeout" | "aborted" | "network" | "unknown";
interface FetchTransportFailureDescriptor {
    kind: FetchTransportFailureKind;
    diagnostic: string;
    retryable: boolean;
}
export interface FetchTransportErrorOptions extends FetchTransportFailureDescriptor {
    cause: unknown;
}
/**
 * A protocol-independent failure raised when an HTTP adapter cannot produce a
 * response. Public fields are deliberately selected from fixed values; the
 * original throw remains available as `cause` for in-process diagnostics but
 * must not be serialized without an explicit redaction policy.
 */
export declare class FetchTransportError extends Error {
    readonly code = "fetch-transport-failed";
    readonly kind: FetchTransportFailureKind;
    readonly diagnostic: string;
    readonly retryable: boolean;
    constructor(options: FetchTransportErrorOptions);
}
/** True only for reviewed native transport shapes; arbitrary adapter/programming failures remain distinct. */
export declare function isLikelyFetchTransportFailure(error: unknown): boolean;
/**
 * Converts an arbitrary adapter throw to a bounded domain error. `timedOut`
 * is supplied by orchestration when its own deadline controller fired, which
 * distinguishes that case from an adapter-originated AbortError.
 */
export declare function toFetchTransportError(error: unknown, options?: {
    timedOut?: boolean;
}): FetchTransportError;
export {};
//# sourceMappingURL=errors.d.ts.map