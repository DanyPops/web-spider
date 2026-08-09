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
export class FetchTransportError extends Error {
	readonly code = "fetch-transport-failed";
	readonly kind: FetchTransportFailureKind;
	readonly diagnostic: string;
	readonly retryable: boolean;

	constructor(options: FetchTransportErrorOptions) {
		super(`Fetch transport failed: ${options.diagnostic}`, { cause: options.cause });
		this.name = "FetchTransportError";
		this.kind = options.kind;
		this.diagnostic = options.diagnostic;
		this.retryable = options.retryable;
	}
}

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NODATA", "ENODATA"]);
const CONNECTION_CODES = new Set([
	"CONNECTIONREFUSED",
	"ECONNREFUSED",
	"ECONNRESET",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"EPIPE",
	"FAILEDTOOPENSOCKET",
	"UND_ERR_SOCKET",
]);
const TIMEOUT_CODES = new Set([
	"ETIMEDOUT",
	"ESOCKETTIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
]);
const ABORT_CODES = new Set(["ABORT_ERR", "UND_ERR_ABORTED"]);
const TLS_CODES = new Set([
	"CERT_HAS_EXPIRED",
	"CERT_NOT_YET_VALID",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_GET_ISSUER_CERT",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"ERR_TLS_CERT_ALTNAME_INVALID",
]);

function errorCode(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || !("code" in value)) return undefined;
	return typeof value.code === "string" ? value.code.toUpperCase() : undefined;
}

function errorName(value: unknown): string | undefined {
	return value instanceof Error && value.name ? value.name : undefined;
}

function errorMessage(value: unknown): string {
	return value instanceof Error ? value.message.toLowerCase() : "";
}

/** Returns a shallow, cycle-safe cause chain. Messages are inspected only for classification and are never returned. */
function causeChain(error: unknown): unknown[] {
	const chain: unknown[] = [];
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (current !== undefined && current !== null && chain.length < 4 && !seen.has(current)) {
		chain.push(current);
		seen.add(current);
		current = current instanceof Error ? current.cause : undefined;
	}
	return chain;
}

function classifyKnownFailure(error: unknown): FetchTransportFailureDescriptor | undefined {
	const chain = causeChain(error);
	const codes = chain.map(errorCode).filter((code): code is string => code !== undefined);
	const names = chain.map(errorName).filter((name): name is string => name !== undefined);
	const messages = chain.map(errorMessage);

	if (codes.some((code) => TIMEOUT_CODES.has(code)) || messages.some((message) => /\b(?:timed?\s*out|timeout)\b/.test(message))) {
		return { kind: "timeout", diagnostic: "Connection timed out", retryable: true };
	}
	if (codes.some((code) => ABORT_CODES.has(code)) || names.includes("AbortError")) {
		return { kind: "aborted", diagnostic: "Request was aborted", retryable: false };
	}
	if (codes.some((code) => DNS_CODES.has(code)) || messages.some((message) => /\b(?:enotfound|eai_again|getaddrinfo)\b/.test(message))) {
		return { kind: "dns", diagnostic: "DNS lookup failed", retryable: true };
	}
	if (
		codes.some((code) => CONNECTION_CODES.has(code)) ||
		messages.some((message) => /\b(?:econnrefused|connection refused|unable to connect)\b/.test(message))
	) {
		return { kind: "connection", diagnostic: "Remote endpoint unavailable", retryable: true };
	}
	if (
		codes.some((code) => TLS_CODES.has(code) || code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_")) ||
		messages.some((message) => /\b(?:certificate|tls|ssl)\b/.test(message))
	) {
		return { kind: "tls", diagnostic: "TLS certificate validation failed", retryable: false };
	}
	if (error instanceof TypeError && messages.some((message) => message === "fetch failed" || message.includes("network error"))) {
		return { kind: "network", diagnostic: "HTTP transport unavailable", retryable: true };
	}
	return undefined;
}

/** True only for reviewed native transport shapes; arbitrary adapter/programming failures remain distinct. */
export function isLikelyFetchTransportFailure(error: unknown): boolean {
	return classifyKnownFailure(error) !== undefined;
}

/**
 * Converts an arbitrary adapter throw to a bounded domain error. `timedOut`
 * is supplied by orchestration when its own deadline controller fired, which
 * distinguishes that case from an adapter-originated AbortError.
 */
export function toFetchTransportError(error: unknown, options: { timedOut?: boolean } = {}): FetchTransportError {
	if (error instanceof FetchTransportError) return error;
	const descriptor = options.timedOut
		? ({ kind: "timeout", diagnostic: "Request timed out", retryable: true } satisfies FetchTransportFailureDescriptor)
		: (classifyKnownFailure(error) ??
			(error instanceof Error
				? { kind: "network", diagnostic: "HTTP transport unavailable", retryable: true }
				: { kind: "unknown", diagnostic: "HTTP transport unavailable", retryable: false }));
	return new FetchTransportError({ ...descriptor, cause: error });
}
