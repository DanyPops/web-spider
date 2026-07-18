/**
 * Vendored from pi's extension loader (pi-mono fork, core/extensions/loader.ts).
 * Pure-CJS packages whose module-level Maps must live in the global V8 realm,
 * not jiti's transform scope. Kept in sync manually — small and stable.
 */
export const JITI_NATIVE_MODULES: string[] = [
	"jsdom",
	"lru-cache",
	"@asamuzakjp/css-color",
	"css-tree",
	"@asamuzakjp/dom-selector",
	"nwsapi",
];
