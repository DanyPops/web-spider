# PDF OCR fallback: design assessment

## Problem

Bounded PDF text-layer extraction (see `docs/pdf-extraction.md`) already
reports two honest failure signals:

- `contentWarning: "no-text-layer"` — the page has no extractable text
  (typically a scanned/image-only page).
- `contentWarning: "garbled-text"` — the page's text layer decodes to a
  high ratio of invalid/replacement glyphs (typically a CID-keyed font
  subset with no usable Unicode map).

Hound recovers real text for both cases by rendering the offending page(s)
to an image and running OCR. This document records the package comparison,
the adapter contract, and — critically — a real, empirically-discovered
limitation of the chosen rendering path that bounds what this fallback can
honestly promise.

## Candidates considered

| Package | Verdict |
|---|---|
| `tesseract.js` | **Selected.** Pure JS/WASM, no system Tesseract binary. Actively maintained, direct analog of Hound's `rapidocr`. |
| `tesseract-wasm` | Lower-level Tesseract WASM binding; no bundled offline language-data distribution channel comparable to `@tesseract.js-data/*`, more manual wiring for no material benefit here. |
| `ppu-paddle-ocr` | Claims first-class Bun support, but far less mature/adopted (PaddleOCR/ONNX-based); higher integration risk for a P3/low-ROI feature. |
| `@gutenye/ocr-node` | ONNX/PaddleOCR-based; heavier runtime (ONNX runtime) for no accuracy benefit on Latin-script academic PDFs, the dominant real-world case here. |

`tesseract.js` was empirically verified in this workspace, not just read
about:

- **Fully offline, no runtime network dependency.** The `@tesseract.js-data/eng`
  package bundles the English `traineddata` model directly (no CDN fetch at
  OCR time). Verified with `HTTP_PROXY`/`HTTPS_PROXY` pointed at an
  unreachable address — recognition still succeeds using the bundled
  `langPath`. This matters for a daemon that may run in a sandboxed/offline
  environment; the tesseract.js *default* behavior (download `eng.traineddata`
  from a CDN into `cwd`) is deliberately not used.
- **Works under both Node and Bun**, source-run (not bundled through a
  bundler like webpack/Next.js/Turbopack — the class of environment where
  GitHub issues report `worker-script` path-resolution failures). Verified
  directly: ~0.6–0.75s per recognition on both runtimes, 92–95% confidence
  against real text.
- **`cachePath` avoids `cwd` pollution** and lets a stable directory reuse
  the one-time `traineddata` gzip→raw decompression (~23 MB) across calls
  within a process instead of re-decompressing per request.

Rasterization uses `unpdf`'s `renderPageAsImage` (already a project
dependency — see `docs/pdf-extraction.md`), which requires the optional
peer `@napi-rs/canvas` (prebuilt native N-API bindings per platform, the
same "regular dependency, no build step" shape already accepted for
Playwright's browser binaries in this codebase).

## A real, load-bearing gotcha: PDF.js detaches its input buffer

Also discovered empirically, and load-bearing for the adapter's implementation: calling
`unpdf.getDocumentProxy`/`renderPageAsImage` (and the existing `UnpdfPdfExtractor`'s own
text extraction) **detaches the input `Uint8Array`'s underlying `ArrayBuffer`** as a side
effect. PDF.js's Node transport moves document data into its (simulated, in-process)
"worker" using structured-clone transfer semantics, which neuters the original buffer
once handed off -- exactly as `postMessage(data, [transferList])` would in a real
worker. A second document load or render sharing the same underlying buffer as an
earlier call sees a silently zero-length buffer (or, if already fully detached,
`%TypedArray%.prototype.slice` itself throws).

This directly affects `OcrFallbackPdfExtractor`: the inner text extractor and the OCR
rasterizer both need to read the *same* fetched PDF bytes. The fix is to `.slice()` a
fresh copy of the bytes before ever handing them to the inner extractor, and to have
`UnpdfPageRasterizer` itself always slice its own defensive copy too (since it may be
asked to render more than one page from the same preserved bytes within one bounded OCR
pass). This was verified by first reproducing the failure with a minimal repro (feeding
the same reference to two sequential `getDocumentProxy` calls, and separately to a real
text-extraction followed by a render), then confirming a plain `.slice()` per call fully
resolves it with no other change needed.

## A real, load-bearing limitation: CID-garbled pages often cannot be rasterized

This was discovered empirically, not assumed. Rendering the `cid-garbled.pdf`
fixture (`arial_unicode_ab_cidfont.pdf` — real academic-style CID font
subset producing invalid Unicode code points) through
`unpdf.renderPageAsImage` throws:

```
Error: Convert String to CString failed
    at CanvasGraphics.showText (.../pdfjs.mjs)
    code: 'InvalidArg'
```

Root cause: PDF.js's canvas rendering path (`CanvasGraphics.showText`)
paints text by calling the canvas 2D context's `fillText()` with the
*decoded Unicode string* for each run — the same code path Hound's
`pypdfium2` avoids, since pdfium renders directly from glyph indices/glyph
programs rather than shaping a Unicode string through the host text
stack. `@napi-rs/canvas`'s native `fillText()` cannot convert a string
containing unpaired/invalid code points (U+FFFF and friends) to a native
`CString` and throws.

**Consequence:** OCR recovery is only guaranteed useful for genuinely
image-only/scanned pages (case 1). For CID-corrupted text (case 2), the
fallback is *attempted*, but a rasterization failure is treated as "OCR
unavailable for this page" — the page keeps its original, already-honest
`garbled-text` signal rather than crashing the request or silently
pretending nothing happened. This is consistent with the project's
existing "no unconditional claims" stance on PDF quality (see
`docs/pdf-extraction.md`) and is proven by a real fixture-driven test, not
asserted from documentation.

This was confirmed to be a genuine, cleanly-*catchable* JS `Error` (not a
process crash) before relying on it in the adapter's per-page isolation.

## Adapter contract (Adapter + Decorator, narrow ports)

Two new narrow ports, alongside the existing `PdfExtractor` port
(`packages/web-spider/src/fetch/pdf-extractor.ts`):

```ts
interface PdfPageImage { readonly bytes: Uint8Array }

interface PdfPageRasterizer {
  renderPage(bytes: Uint8Array, pageNumber: number): Promise<PdfPageImage>;
}

interface OcrResult { readonly text: string; readonly confidence: number } // 0.0-1.0

interface OcrEngine {
  recognize(image: PdfPageImage): Promise<OcrResult>;
}
```

Production Adapters: `UnpdfPageRasterizer` (wraps `unpdf` + `@napi-rs/canvas`),
`TesseractOcrEngine` (wraps `tesseract.js` + `@tesseract.js-data/eng`).
Neither type leaks a third-party object across its own method boundary.

A `PdfExtractor` Decorator, `OcrFallbackPdfExtractor`, wraps any inner
`PdfExtractor` and composes with the two ports:

- Runs the inner extractor first (unchanged behavior/contract).
- For each returned page whose text is empty or garbled (reusing the same
  `pageNeedsOcr` predicate `qualityOf` already uses — one source of truth
  for the threshold), attempts rasterize→recognize, bounded to at most 5
  pages per request (OCR is slow; this is a fallback path, not the common
  case).
- A per-page rasterize or recognize failure is caught and treated as "no
  recovery" for that page only — it never fails the whole extraction.
- Successfully recovered pages report which page numbers were OCR'd
  (`PdfExtraction.ocrPages`); `PdfContentExtractor` surfaces this and a
  numeric `pdf.qualityScore` (0.0–1.0, derived from the same invalid-glyph
  ratio `contentWarning` already uses) without any change to its existing
  markdown/outline/cache flow, since OCR substitution happens entirely
  inside the extractor boundary before content-extraction sees the pages.

Wired as `PdfContentExtractor`'s new default parser
(`OcrFallbackPdfExtractor(UnpdfPdfExtractor, UnpdfPageRasterizer,
TesseractOcrEngine)`), so recovery is automatic — matching Hound's
behavior — with near-zero cost for the common good-text-layer case (OCR
packages are only ever dynamically imported inside the rare code path that
actually needs them, exactly like the existing `unpdf` import in
`UnpdfPdfExtractor`).

Unit tests inject fake `PdfPageRasterizer`/`OcrEngine` implementations;
adapter contract tests exercise the real `unpdf`/`tesseract.js` stack
against committed fixtures.

## Rejected alternatives

- **OCR every page unconditionally** — rejected. Contradicts the "no
  silent, unconditional claims" project stance and is far slower than
  necessary; OCR only helps a small minority of pages.
- **A hard OCR timeout inside `OcrFallbackPdfExtractor` itself** —
  considered, deferred. `tesseract.js`'s worker create+recognize+terminate
  cycle already completes in under a second against real fixtures; the
  bounded per-request page cap (5) already caps worst-case added latency.
  Revisit if production telemetry shows otherwise.
- **A long-lived, pooled Tesseract worker** (mirroring the Playwright
  browser-process lifecycle) — rejected for this iteration. OCR is a rare
  fallback path (most PDFs never trigger it), so the ~0.5–0.7s
  create/terminate overhead per invocation is an acceptable, much simpler
  tradeoff than adding another long-lived resource requiring the same
  hardened shutdown-ordering work already done for Playwright.
