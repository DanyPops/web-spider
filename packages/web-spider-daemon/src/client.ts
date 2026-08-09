/**
 * Typed authenticated loopback client. Delegates to @danypops/vehicle-client's
 * generic AuthenticatedRpcClient (this file used to duplicate jittor's own
 * client.ts byte-for-byte). The Pi extension and CLI both use this;
 * neither opens SQLite directly.
 *
 * The package's ./client facade bundles this module and its state dependency
 * into Node/Jiti-safe JavaScript, so Pi and other consumers share this exact
 * authentication/discovery implementation without importing Bun-only code.
 */
import { AuthenticatedRpcClient, type FetchTransport } from "@danypops/vehicle-client/rpc-client";
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
	if (!handle) throw new Error("Web Spider daemon is not running; install or start armada-web-spider.service");
	const token = ensureAuthToken(paths);
	return new WebSpiderClient(`http://${handle.host}:${handle.port}`, token);
}
