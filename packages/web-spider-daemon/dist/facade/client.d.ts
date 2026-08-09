import type { WebSpiderPaths } from "./state.d.ts";

export type FetchTransport = (request: Request) => Promise<Response>;

export declare class WebSpiderClient {
	constructor(baseUrl: string, token: string, transport?: FetchTransport);
	call<T = unknown>(operation: string, input: Record<string, unknown>): Promise<T>;
	operations(): Promise<string[]>;
	ready(): Promise<boolean>;
	health(): Promise<{ ok: true; version: string }>;
}

export declare function connectWebSpiderClient(paths?: WebSpiderPaths): WebSpiderClient;
