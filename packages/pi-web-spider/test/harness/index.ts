/**
 * Re-exports @danypops/pi-extension-harness -- this project's own copy of
 * ExtensionHarness (vendored from the pi-mono fork before that shared
 * package existed) was deleted in favor of the real dependency, which
 * every other Pi-extension project in this house (lector, packed, tickets,
 * vehicle) already depends on directly. Kept as a local barrel purely so
 * this package's own test files don't all need a mechanical import-path
 * edit at the same time.
 */
export {
	createExtensionHarness,
	type ExtensionHarness,
	type ExtensionHarnessOptions,
	type HarnessLeak,
	type HarnessNotification,
	type HarnessTool,
	type HarnessUserMessage,
	loadExtensionViaJiti,
} from "@danypops/pi-extension-harness";
