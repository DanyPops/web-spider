/**
 * ExtensionHarness — lightweight test host for Pi extensions.
 *
 * VENDORED from the pi-mono fork (src/testing/extension-harness.ts) so the
 * tests no longer depend on a locally-linked pi fork. Imports point at the
 * published @earendil-works/pi-coding-agent package types.
 *
 * Implements ExtensionAPI and ExtensionContext as minimal in-memory stubs so
 * extension authors can unit-test hooks and tools without booting AgentSession,
 * a real LLM, or any I/O. Analogous to ESLint's RuleTester: the host ships
 * the testing primitives so every extension author does not have to hand-roll
 * their own mock.
 *
 * Usage:
 *
 *   import { createExtensionHarness } from "./harness/index.ts";
 *
 *   const h = createExtensionHarness(myExtensionFactory, { cwd: "/tmp/workspace" });
 *   await h.boot();
 *
 *   // Fire a lifecycle event and inspect the result
 *   const result = await h.emit("before_agent_start", { prompt: "fix the bug" });
 *
 *   // Invoke a registered tool directly
 *   const out = await h.invokeTool("my_tool", { file: "src/foo.ts" });
 *
 *   // Inspect observable state
 *   expect(h.activeTools).toContain("my_tool");
 *   expect(h.notifications[0]).toEqual({ message: "connected", type: "info" });
 *
 *   await h.shutdown();
 */

import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { JITI_NATIVE_MODULES } from "./jiti-native-modules.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionHandler,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

// ── Jiti loader ───────────────────────────────────────────────────────────────

/**
 * Load a Pi extension the same way Pi's Bun binary loads it: via jiti with
 * tryNative:false + the production nativeModules list.
 *
 * Pass `nativeModules: JITI_NATIVE_MODULES` (the default) to exercise the
 * exact same resolver config as the production loader. This surfaces
 * Bun-native resolver failures — e.g. "Cannot find package X from jsdom" —
 * in unit tests before the extension ever reaches a real Pi session.
 *
 * Pass `nativeModules: []` for a lighter load that skips native resolution
 * (equivalent to the old behaviour, useful for extensions that don't use jsdom).
 *
 * @param extensionPath  Absolute path to the extension entry point (index.ts).
 * @param nativeModules  Packages to load natively. Defaults to JITI_NATIVE_MODULES
 *                       (the production list). Import and pass this from
 *                       "@earendil-works/pi-coding-agent" to stay in sync.
 */
export async function loadExtensionViaJiti(
	extensionPath: string,
	{ nativeModules = JITI_NATIVE_MODULES }: { nativeModules?: string[] } = {},
): Promise<ExtensionFactory> {
	const { createJiti } = (await import("jiti")) as typeof import("jiti");
	const jiti = createJiti(`file://${extensionPath}`, { moduleCache: false, tryNative: false, nativeModules });
	const factory = await jiti.import(extensionPath, { default: true });
	if (typeof factory !== "function") {
		throw new Error(
			`Extension at ${extensionPath} did not export a default function (got ${typeof factory}). ` +
				"This is the jiti/Bun CJS interop failure \u2014 check that the extension uses dynamic import() " +
				"for ESM-only packages instead of top-level import.",
		);
	}
	return factory as ExtensionFactory;
}

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
// ReadonlySessionManager is not exported publicly; the harness only needs a stub.
type ReadonlySessionManager = unknown;

// ── Public types ──────────────────────────────────────────────────────────────

/** A notification recorded by ui.notify(). */
export interface HarnessNotification {
	message: string;
	type: "info" | "warning" | "error";
}

/** A user message recorded by sendUserMessage(). */
export interface HarnessUserMessage {
	content: string;
	options?: { deliverAs?: "steer" | "followUp" };
}

/** A registered tool (the raw ToolDefinition + a convenience invocation helper). */
export interface HarnessTool {
	name: string;
	definition: ToolDefinition<any, any, any>;
}

/** Options for createExtensionHarness(). */
export interface ExtensionHarnessOptions {
	/** Working directory passed to ExtensionContext.cwd. Default: process.cwd(). */
	cwd?: string;
	/**
	 * Environment variables to inject into process.env during boot().
	 * Restored after boot() completes.
	 */
	env?: Record<string, string | undefined>;
	/**
	 * Stub for pi.exec(). When provided, replaces the real child-process spawn
	 * so extensions that shell out can be tested without a real filesystem or
	 * git repo. When omitted, pi.exec() returns { stdout: "", stderr: "", code: 0, killed: false }.
	 *
	 * @example
	 * exec: async (cmd, args) => {
	 *   if (cmd === "git" && args[0] === "status") {
	 *     return { stdout: " M src/foo.ts\n", stderr: "", code: 0, killed: false };
	 *   }
	 *   return { stdout: "", stderr: "", code: 0, killed: false };
	 * }
	 */
	exec?: (cmd: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;
}

/**
 * A raw write that an extension made directly to stdout or stderr.
 * Either is a TUI corruption — extensions must use ctx.ui.notify() instead.
 */
export interface HarnessLeak {
	/** Which stream was written to. */
	stream: "stdout" | "stderr";
	/** The raw string content that was written. */
	content: string;
}

/** The harness returned by createExtensionHarness(). */
export interface ExtensionHarness {
	// ── Observable state ────────────────────────────────────────────────────

	/** All notifications fired via ctx.ui.notify(). Appended in call order. */
	readonly notifications: HarnessNotification[];

	/** All messages sent via pi.sendUserMessage(). */
	readonly userMessages: HarnessUserMessage[];

	/** Tools registered via pi.registerTool(), keyed by name. */
	readonly tools: Map<string, HarnessTool>;

	/** Current active tool names (last value set by pi.setActiveTools()). */
	readonly activeTools: string[];

	/** Commands registered via pi.registerCommand(). */
	readonly commands: string[];

	/** Session name set via pi.setSessionName(). */
	readonly sessionName: string | undefined;

	/**
	 * Raw writes made directly to process.stdout during this session.
	 * Non-empty means the extension is leaking into the TUI stream.
	 * Extensions must use ctx.ui.notify() — never process.stdout.write or console.*.
	 */
	readonly stdoutLeaks: HarnessLeak[];

	/**
	 * Raw writes made directly to process.stderr during this session.
	 * Same contract as stdoutLeaks.
	 */
	readonly stderrLeaks: HarnessLeak[];

	/**
	 * All stdout + stderr leaks combined.
	 * Standard assertion: expect(h.leaks).toHaveLength(0)
	 */
	readonly leaks: HarnessLeak[];

	// ── Lifecycle ───────────────────────────────────────────────────────────

	/**
	 * Boot the extension: apply env overrides, fire "session_start", restore env.
	 * Must be called before emit() or invokeTool().
	 */
	boot(): Promise<void>;

	/** Fire "session_shutdown" and clear internal state. */
	shutdown(): Promise<void>;

	// ── Event simulation ────────────────────────────────────────────────────

	/**
	 * Fire an event to all registered handlers for that event type.
	 * Returns the last non-undefined result, mirroring Pi's own runner behaviour.
	 *
	 * Provide only the fields your extension actually reads — the harness fills
	 * the rest with safe defaults. Events do not need to be fully typed at the
	 * call site.
	 */
	emit<R = unknown>(event: string, payload?: Record<string, unknown>): Promise<R | undefined>;

	// ── Tool invocation ─────────────────────────────────────────────────────

	/**
	 * Invoke a registered tool by name, bypassing the LLM entirely.
	 * Throws if the tool is not registered.
	 */
	invokeTool(name: string, args: Record<string, unknown>): Promise<unknown>;

	/**
	 * Invoke a registered command handler by name.
	 * Throws if the command is not registered or has no handler.
	 */
	invokeCommand(name: string, args?: string): Promise<void>;

	// ── Context access ──────────────────────────────────────────────────────

	/**
	 * The ExtensionContext stub passed to all event handlers.
	 * Useful for inspecting or overriding stub behaviour in advanced scenarios.
	 */
	readonly ctx: ExtensionContext;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Create a lightweight test harness for a Pi extension factory.
 *
 * The factory is called immediately (synchronously) with a stub ExtensionAPI,
 * registering hooks and tools. boot() then fires "session_start".
 */
export function createExtensionHarness(
	factory: ExtensionFactory,
	options: ExtensionHarnessOptions = {},
): ExtensionHarness {
	const cwd = options.cwd ?? process.cwd();

	// ── Mutable state ────────────────────────────────────────────────────────

	const notifications: HarnessNotification[] = [];
	const userMessages: HarnessUserMessage[] = [];
	const tools = new Map<string, HarnessTool>();
	const commands: string[] = [];
	const commandHandlers = new Map<string, (...args: any[]) => any>();
	const handlers = new Map<string, Array<ExtensionHandler<any, any>>>();
	let activeTools: string[] = [];
	let sessionName: string | undefined;

	// ── ExtensionContext stub ────────────────────────────────────────────────

	const sessionManagerStub = {
		getCwd: () => cwd,
		getSessionDir: () => "",
		getSessionId: () => "harness-session",
		getSessionFile: () => undefined,
		getLeafId: () => null,
		getLeafEntry: () => undefined,
		getEntry: () => undefined,
		getLabel: () => undefined,
		getBranch: () => [],
		getHeader: () => null,
		getEntries: () => [],
		getTree: () => [],
		getSessionName: () => sessionName,
	} as unknown as ReadonlySessionManager;

	const modelRegistryStub = {} as ModelRegistry;

	const ui = {
		notify(message: string, type: "info" | "warning" | "error" = "info") {
			notifications.push({ message, type });
		},
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as any,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme: {} as any,
	} as unknown as ExtensionContext["ui"];

	const ctx: ExtensionContext = {
		cwd,
		hasUI: false,
		sessionManager: sessionManagerStub,
		modelRegistry: modelRegistryStub,
		model: undefined,
		signal: undefined,
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		ui,
	};

	// ── ExtensionAPI stub ────────────────────────────────────────────────────

	function addHandler(event: string, handler: ExtensionHandler<any, any>) {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	}

	const api: ExtensionAPI = {
		on(event: string, handler: ExtensionHandler<any, any>) {
			addHandler(event, handler);
		},

		registerTool(tool: ToolDefinition<any, any, any>) {
			tools.set(tool.name, { name: tool.name, definition: tool });
		},

		registerCommand(name: string, definition?: { handler?: (...args: any[]) => any }) {
			commands.push(name);
			if (definition?.handler) {
				commandHandlers.set(name, definition.handler);
			}
		},

		registerShortcut: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		registerMessageRenderer: () => {},

		sendMessage: () => {},

		sendUserMessage(content: string | unknown[], opts?: { deliverAs?: "steer" | "followUp" }) {
			const text = typeof content === "string" ? content : JSON.stringify(content);
			userMessages.push({ content: text, options: opts });
		},

		appendEntry: () => {},

		setSessionName(name: string) {
			sessionName = name;
		},

		getSessionName: () => sessionName,
		setLabel: () => {},
		exec: options.exec ?? (async () => ({ stdout: "", stderr: "", code: 0, killed: false })),

		getActiveTools: () => [...activeTools],
		getAllTools: () => [],

		setActiveTools(names: string[]) {
			activeTools = [...names];
		},

		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "off" as any,
		setThinkingLevel: () => {},
		registerProvider: () => {},
		refreshTools: () => {},
	} as unknown as ExtensionAPI;

	// Call the factory now so sync extensions register tools immediately.
	// The returned promise (if any) is awaited in boot() so async extensions
	// (which use dynamic import inside the factory) are also fully initialised
	// before session_start fires.
	const factoryResult = factory(api);

	// ── Harness implementation ───────────────────────────────────────────────

	async function emit<R>(event: string, payload: Record<string, unknown> = {}): Promise<R | undefined> {
		const list = handlers.get(event) ?? [];
		let result: R | undefined;
		for (const h of list) {
			const r = await h({ type: event, ...payload } as any, ctx);
			if (r !== undefined) result = r as R;
		}
		return result;
	}

	// ── Stdout / stderr leak detection ────────────────────────────────────
	//
	// During the session (boot → shutdown), process.stdout.write and
	// process.stderr.write are wrapped. Any write from extension code is
	// recorded as a leak and swallowed — it must not corrupt the TUI stream.
	// The original write functions are restored in shutdown().

	const stdoutLeaks: HarnessLeak[] = [];
	const stderrLeaks: HarnessLeak[] = [];

	let _originalStdoutWrite: typeof process.stdout.write | null = null;
	let _originalStderrWrite: typeof process.stderr.write | null = null;
	const _originalConsoleMethods: Partial<Record<string, (...args: unknown[]) => void>> = {};

	function makeStreamInterceptor(leaks: HarnessLeak[], stream: "stdout" | "stderr") {
		return (raw: string | Uint8Array, _encodingOrCb?: unknown, _cb?: unknown): boolean => {
			const content = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8");
			leaks.push({ stream, content });
			return true; // swallow — do not forward to the real TUI stream
		};
	}

	function makeConsoleInterceptor(leaks: HarnessLeak[], stream: "stdout" | "stderr", methodName: string) {
		return (...args: unknown[]): void => {
			const content = `[console.${methodName}] ${args.map(String).join(" ")}`;
			leaks.push({ stream, content });
		};
	}

	function installLeakDetectors(): void {
		// Intercept process.stdout/stderr.write (direct writes).
		_originalStdoutWrite = process.stdout.write.bind(process.stdout);
		_originalStderrWrite = process.stderr.write.bind(process.stderr);
		process.stdout.write = makeStreamInterceptor(stdoutLeaks, "stdout") as unknown as typeof process.stdout.write;
		process.stderr.write = makeStreamInterceptor(stderrLeaks, "stderr") as unknown as typeof process.stderr.write;

		// Also intercept console.* — test runners (vitest, jest) replace the
		// console object before process.stdout.write, so console.log does NOT
		// reach our stream interceptor above in test environments.
		const stdoutMethods = ["log", "info", "debug", "dir", "table", "time", "timeEnd", "count"] as const;
		const stderrMethods = ["error", "warn", "trace"] as const;
		for (const m of stdoutMethods) {
			if (typeof (console as any)[m] === "function") {
				_originalConsoleMethods[m] = (console as any)[m].bind(console);
				(console as any)[m] = makeConsoleInterceptor(stdoutLeaks, "stdout", m);
			}
		}
		for (const m of stderrMethods) {
			if (typeof (console as any)[m] === "function") {
				_originalConsoleMethods[m] = (console as any)[m].bind(console);
				(console as any)[m] = makeConsoleInterceptor(stderrLeaks, "stderr", m);
			}
		}
	}

	function removeLeakDetectors(): void {
		if (_originalStdoutWrite) {
			process.stdout.write = _originalStdoutWrite;
			_originalStdoutWrite = null;
		}
		if (_originalStderrWrite) {
			process.stderr.write = _originalStderrWrite;
			_originalStderrWrite = null;
		}
		for (const [m, fn] of Object.entries(_originalConsoleMethods)) {
			if (fn) (console as any)[m] = fn;
		}
		for (const k of Object.keys(_originalConsoleMethods)) {
			delete _originalConsoleMethods[k];
		}
	}

	// Saved env values — restored in shutdown()
	const savedEnv: Record<string, string | undefined> = {};

	async function boot(): Promise<void> {
		// Install stdout/stderr interceptors before the factory and session_start
		// fire so any leak during initialisation is also captured.
		installLeakDetectors();
		// Apply env overrides for the duration of the session (restored in shutdown).
		for (const [k, v] of Object.entries(options.env ?? {})) {
			savedEnv[k] = process.env[k];
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		// Await any pending async factory work (e.g. dynamic imports) before
		// firing session_start. For sync factories factoryResult is undefined.
		await factoryResult;
		await emit("session_start", { reason: "startup" });
	}

	async function shutdown(): Promise<void> {
		await emit("session_shutdown", {});
		// Restore stdout/stderr before env so shutdown handlers see the real streams.
		removeLeakDetectors();
		// Restore env after session_shutdown so handlers can still read it.
		for (const [k, v] of Object.entries(savedEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		// Clear observable state so the harness is ready for re-use or GC.
		notifications.length = 0;
		userMessages.length = 0;
		tools.clear();
		commands.length = 0;
		activeTools = [];
		sessionName = undefined;
		stdoutLeaks.length = 0;
		stderrLeaks.length = 0;
	}

	async function invokeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Tool "${name}" is not registered`);
		return tool.definition.execute("harness-call-id", args, new AbortController().signal, () => {}, ctx as any);
	}

	async function invokeCommand(name: string, args?: string): Promise<void> {
		const handler = commandHandlers.get(name);
		if (!handler) throw new Error(`Command "${name}" is not registered or has no handler`);
		await handler(args ?? "", ctx);
	}

	return {
		get notifications() {
			return notifications;
		},
		get userMessages() {
			return userMessages;
		},
		get tools() {
			return tools;
		},
		get activeTools() {
			return [...activeTools];
		},
		get commands() {
			return commands;
		},
		get sessionName() {
			return sessionName;
		},
		get stdoutLeaks() {
			return stdoutLeaks;
		},
		get stderrLeaks() {
			return stderrLeaks;
		},
		get leaks() {
			return [...stdoutLeaks, ...stderrLeaks];
		},
		boot,
		shutdown,
		emit,
		invokeTool,
		invokeCommand,
		ctx,
	};
}
