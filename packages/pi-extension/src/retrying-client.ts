/**
 * Wraps connectOrStartWebSpiderClient() with the retry-once-on-stale-
 * connection policy generalized into @danypops/vehicle-client's daemon-client
 * module (this file, papyrus's callService(), and lector's lectorClient()
 * were three of the four independent reimplementations that motivated it).
 * The daemon binds a new random port on every restart; a client resolved
 * once and cached for the rest of a Pi session would otherwise point at a
 * dead port after any later restart until the whole extension reloaded.
 * createRetryingClient() detects that on the failing call itself (not just
 * the first connection attempt), drops the stale cache entry, and retries
 * once against a freshly re-resolved client.
 */
import { createRetryingClient } from "@danypops/vehicle-client/daemon-client"
import { connectOrStartWebSpiderClient, type WebSpiderClient } from "./daemon-client.js"

type ClientConnector = () => Promise<WebSpiderClient>

let connector: ClientConnector = () => connectOrStartWebSpiderClient()
const retryingClient = createRetryingClient<WebSpiderClient>(() => connector(), { label: "Web Spider" })

export async function callWebSpider<T = unknown>(operation: string, input: Record<string, unknown>): Promise<T> {
  return retryingClient.call((client) => client.call<T>(operation, input))
}

export function setWebSpiderClientConnectorForTests(value: ClientConnector): void {
  connector = value
  retryingClient.reset()
}

export function resetWebSpiderClientConnectorForTests(): void {
  connector = () => connectOrStartWebSpiderClient()
  retryingClient.reset()
}
