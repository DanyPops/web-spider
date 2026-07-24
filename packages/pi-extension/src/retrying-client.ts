/**
 * Wraps connectOrStartWebSpiderClient() with a retry-once-on-stale-connection
 * policy, matching the pattern already proven in this house's
 * papyrusClient()/callService() (@danypops/papyrus) and lectorClient()
 * (@danypops/lector). The daemon binds a new random port on every restart;
 * a client resolved once and cached for the rest of a Pi session would
 * otherwise point at a dead port after any later restart until the whole
 * extension reloaded. callWebSpider() detects that on the failing call
 * itself (not just the first connection attempt), drops the stale cache
 * entry, and retries once against a freshly re-resolved client.
 */
import { connectOrStartWebSpiderClient, type WebSpiderClient } from "./daemon-client.js"

type ClientConnector = () => Promise<WebSpiderClient>

let connector: ClientConnector = () => connectOrStartWebSpiderClient()
let cachedClient: Promise<WebSpiderClient> | undefined

async function resolveClient(): Promise<WebSpiderClient> {
  if (!cachedClient) {
    cachedClient = connector().catch((error: unknown) => {
      cachedClient = undefined
      throw error
    })
  }
  return cachedClient
}

/**
 * True when `error` means the connection itself is bad (the daemon
 * restarted on a new port since this client was cached, or died outright)
 * -- worth invalidating the cache and retrying once. False for a genuine
 * operation-level rejection (e.g. a validation error), which a retry
 * cannot fix and would only mask.
 */
function isStaleConnectionError(error: unknown): boolean {
  if (error instanceof TypeError) return true // fetch()'s own connection-refused/DNS-failure shape
  if (!(error instanceof Error)) return false
  if (error.name === "AbortError" || error.name === "TimeoutError") return true
  return /fetch failed|unable to connect|network|socket|ECONNRESET|ECONNREFUSED|connection refused/i.test(error.message)
}

export async function callWebSpider<T = unknown>(operation: string, input: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const client = await resolveClient()
    try {
      return await client.call<T>(operation, input)
    } catch (error) {
      cachedClient = undefined
      if (attempt === 1 || !isStaleConnectionError(error)) throw error
    }
  }
  throw new Error("Web Spider daemon client retry exhausted")
}

export function setWebSpiderClientConnectorForTests(value: ClientConnector): void {
  cachedClient = undefined
  connector = value
}

export function resetWebSpiderClientConnectorForTests(): void {
  cachedClient = undefined
  connector = () => connectOrStartWebSpiderClient()
}
