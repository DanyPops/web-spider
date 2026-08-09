export interface WebSpiderPaths {
	database: string;
	token: string;
	handle: string;
	systemdUnit: string;
}

export interface DaemonHandle {
	host: "127.0.0.1";
	port: number;
	pid: number;
}

export interface PathEnvironment {
	env?: Record<string, string | undefined>;
	home?: string;
	uid?: number;
}

export declare function resolveWebSpiderPaths(options?: PathEnvironment): WebSpiderPaths;
export declare function ensureAuthToken(paths?: WebSpiderPaths): string;
export declare function writeDaemonHandle(paths: WebSpiderPaths, handle: DaemonHandle): void;
export declare function readDaemonHandle(paths?: WebSpiderPaths): DaemonHandle | null;
export declare function removeDaemonHandle(paths?: WebSpiderPaths): void;
export declare function resolveLegacyCachePath(options?: PathEnvironment): string;
