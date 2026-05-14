import { spider } from "../dist/spider.js"
import { writeFileSync, mkdirSync } from "fs"

const url = "https://easyparser.com/blog/ai-agents-web-scraping-guide"
console.log(`Spidering ${url} ...`)

try {
  const page = await spider(url)
  console.log("title      :", page.title)
  console.log("domain     :", page.domain)
  console.log("wordCount  :", page.wordCount)
  console.log("chunks     :", page.chunks.length)
  console.log("links      :", page.links.length)
  console.log("headings   :", page.headings.map((h) => `H${h.level} ${h.text}`).join(" | "))
  console.log("\n--- First 3 chunks ---")
  for (const c of page.chunks.slice(0, 3)) {
    console.log(`\n[${c.index}] heading="${c.heading}" words=${c.wordCount}`)
    console.log(c.text.slice(0, 300) + "...")
  }
  mkdirSync("fixtures", { recursive: true })
  writeFileSync("fixtures/guide-ai-agents-web-scraping.json", JSON.stringify(page, null, 2))
  console.log("\nFixture written to fixtures/guide-ai-agents-web-scraping.json")
} catch (e) {
  console.error("Failed:", e.message)
}
