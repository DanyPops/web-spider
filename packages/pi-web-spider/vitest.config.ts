import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // tool-shell-dual-channel.test.ts imports @danypops/vehicle-conformance, which is Bun-only
    // (imports directly from "bun:test") -- run separately via `bun test`, see this package's
    // own "test" script.
    exclude: ["**/node_modules/**", "test/tool-shell-dual-channel.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
})
