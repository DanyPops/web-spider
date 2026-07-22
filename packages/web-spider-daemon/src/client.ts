/**
 * Typed authenticated loopback client. Delegates to @danypops/daemon-kit's
 * generic AuthenticatedRpcClient (this file used to duplicate jittor's own
 * client.ts byte-for-byte). The Pi extension and CLI both use this;
 * neither opens SQLite directly.
 *
 * Note: packages/pi-extension/src/daemon-client.ts intentionally
 * duplicates a small, Bun-independent subset of this instead of importing
 * it -- see that file's header comment (jiti/native-ESM loader fragility
 * with a dependency's raw, unbuilt TypeScript). This migration does not
 * change that; daemon-kit itself is raw TypeScript too and would hit the
 * same risk if pi-extension ever imported it directly.
 */
import { AuthenticatedRpcClient, type FetchTransport } from "@danypops/daemon-kit/rpc-client";
import type { OperationInputs, OperationName, OperationOutputs } from "./service.ts";
import { ensureAuthToken, readDaemonHandle, resolveWebSpiderPaths, type WebSpiderPaths } from "./state.ts";

export type { FetchTransport };

export class WebSpiderClient {
	private readonly rpc: AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>;

	constructor(baseUrl: string, token: string, transport: FetchTransport = fetch) {
		this.rpc = new AuthenticatedRpcClient(baseUrl, token, { label: "Web Spider", transport });
	}

	call<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]> {
		return this.rpc.call(operation, input);
	}

	operations(): Promise<OperationName[]> {
		return this.rpc.operations();
	}

	ready(): Promise<boolean> {
		return this.rpc.ready();
	}

	health(): Promise<{ ok: true; version: string }> {
		return this.rpc.health();
	}
}

export function connectWebSpiderClient(paths: WebSpiderPaths = resolveWebSpiderPaths()): WebSpiderClient {
	const handle = readDaemonHandle(paths);
	if (!handle) throw new Error("Web Spider daemon is not running; install or start web-spider.service");
	const token = ensureAuthToken(paths);
	return new WebSpiderClient(`http://${handle.host}:${handle.port}`, token);
}
