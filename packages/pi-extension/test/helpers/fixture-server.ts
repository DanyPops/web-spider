/**
 * Real local HTTP server serving fixture HTML — replaces mocking
 * globalThis.fetch, which no longer works for these tests: the daemon that
 * actually performs fetches runs in a separate process and never sees this
 * test process's mocked fetch. Serving fixtures over real localhost HTTP is
 * simple, fast, and exercises the real network path end to end.
 */
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

export interface FixtureServer {
  baseUrl: string
  /** Register or replace the response body for an exact path (e.g. "/article"). 404 for anything unregistered. */
  set(path: string, body: string, contentType?: string): void
  close(): Promise<void>
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const routes = new Map<string, { body: string; contentType: string }>()
  // robots.txt/sitemap.xml are fetched by the daemon's RobotsCache/fetchSitemapUrls
  // directly; both fail open on a 404, so no explicit route is needed for them.
  const server: Server = createServer((req, res) => {
    const path = req.url ?? "/"
    const route = routes.get(path)
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("not found")
      return
    }
    res.writeHead(200, { "content-type": route.contentType })
    res.end(route.body)
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    set(path, body, contentType = "text/html") {
      routes.set(path, { body, contentType })
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}
