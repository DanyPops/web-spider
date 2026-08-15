import { defineConfig } from "vitest/config"

// lightpanda.test.ts launches several real headless Chromium processes.
// Running it in vitest's default parallel-file worker pool alongside every
// other file lets those real-browser launches overlap with each other (and,
// worse, with any other file that also launches one) on a CI runner's few
// vCPUs -- a well-documented cause of "Target page, context or browser has
// been closed" from /dev/shm or process-spawn contention. Isolating it into
// its own project with maxWorkers: 1 keeps its launches strictly sequential
// without slowing down the other ~50 files, which stay fully parallel.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          exclude: ["node_modules/**", "test/lightpanda.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["test/lightpanda.test.ts"],
          maxWorkers: 1,
        },
      },
    ],
  },
})
