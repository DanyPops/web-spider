# PDF text-layer extraction design

Status: accepted before production implementation for Papyrus task
`1cf887b6-9330-4c0f-885c-5d86347b11ca`.

## Prerequisite and dependency direction

The response-content Strategy boundary from task
`de1de6b5-03fc-4870-94a4-97268f142b11` is complete. PDF support will extend
that boundary; it will not add parsing, cache, or format branches to daemon or
Pi code.

Dependency direction remains:

```text
spider transport -> ContentExtractor Strategy -> narrow PdfExtractor port
                                             <- unpdf adapter
```

The parser receives bytes that transport has already fetched. It receives no
HTTP client, URL fetch capability, cache, robots checker, throttle, SQLite,
Vehicle, daemon, or Pi object. No `unpdf` or PDF.js type appears in a public
core contract or wire format.

## Committed comparison corpus

`packages/web-spider/test/fixtures/pdf/` contains the exact benchmark corpus:

- one-page text layer (`text.pdf`),
- three selectable text pages (`multi-page.pdf`),
- malformed object graph (`malformed.pdf`),
- image-only/scanned page (`scanned.pdf`), and
- invalid CID mapping producing U+FFFF (`cid-garbled.pdf`).

The binary fixtures are small Apache-2.0 Mozilla PDF.js fixtures pinned and
attributed in the fixture README. The malformed fixture is local.

## Candidate benchmark

Compared on the committed corpus with Node 22.22.2 and Bun 1.3.14. Candidate
versions were `unpdf@1.8.0`, `pdf-parse@2.4.5`, and
`pdfjs-dist@6.2.108`. Every candidate uses PDF.js underneath and produced the
same semantic outcomes:

| Fixture | unpdf Node/Bun | pdf-parse Node/Bun | direct pdfjs Node/Bun |
|---|---|---|---|
| text | `Dummy PDF file`, 1 page, 96/82 ms | same, 75/143 ms | same, 86/77 ms |
| multi-page | `1`, `2`, `3`, 16/17 ms | same, 19/12 ms | same, 21/22 ms |
| malformed | explicit `InvalidPDFException`, 4/2 ms | same, 3/2 ms | same, 3/2 ms |
| scanned | one page, empty text, 3/2 ms | same, 2/2 ms | same, 2/2 ms |
| CID-garbled | four U+FFFF characters, 10/7 ms | same, 7/8 ms | same, 8/7 ms |

The timings are cold local fixture observations, not performance guarantees.
They establish Bun compatibility and equivalent quality/failure behavior.

### Selection: `unpdf`

Choose `unpdf` because it is current, explicitly supports Bun and serverless
runtimes, ships a serverless PDF.js build, exposes text extraction without a
renderer/canvas dependency, and has a much smaller unpacked package
(`~2.1 MB`) than the compared `pdf-parse` (`~21.3 MB`) and direct
`pdfjs-dist` (`~34.5 MB`) releases. Its untrusted-PDF guidance also explicitly
calls out page fan-out and image-size limits.

Rejected alternatives:

- **`pdf-parse`**: equal fixture output and a useful partial-page API, but a
  substantially larger package and a broader parser/render/table API than this
  MVP needs.
- **Direct `pdfjs-dist`**: equal output and maximum control, but leaks a much
  larger low-level API into the adapter implementation and requires more
  lifecycle/text-normalization code with no fixture-quality gain.
- **OCR/rendering packages**: outside this text-layer MVP and intentionally
  remain in the dependent OCR task.

## Narrow contracts

The parser-facing `PdfExtractor` port accepts only bounded bytes and a 1-based
inclusive page range, and returns normalized page text, total page count, and
an optional bounded outline. `PdfContentExtractor` adapts that result to the
existing `ContentExtractor` Strategy and normal page model. A fake
`PdfExtractor` therefore tests detection, page selection, output shaping,
quality signals, and parser failures without importing or running PDF.js.

The production `UnpdfPdfExtractor` owns all third-party calls and translates
third-party failures to stable core errors. It extracts selected pages only;
it does not call `unpdf.extractText`, which fans out over every page.

## Bounds and honest quality

- Detect PDF when the normalized content type is `application/pdf` **or** the
  first 1,024 bytes contain a `%PDF-` header (mislabelled resources still work).
- Reject a PDF body above 20 MiB before parser entry.
- Page numbers are 1-based and inclusive. Default to page 1 through at most 50;
  reject non-integers, reversed ranges, and any requested span over 50 pages.
- Pass PDF.js `maxImageSize: 16,777,216` (~16 megapixels).
- Emit `--- Page N ---` for every selected page. Apply the existing token budget
  after page normalization; never let a parser bypass output limits.
- Infer a table of contents only from the PDF's actual outline, cap it at 50
  entries and three levels, and do not invent one from text layout.
- Mark image-only/empty extraction `contentOk: false` with
  `contentWarning: "no-text-layer"`.
- Mark output dominated by invalid/replacement/private-use glyphs
  `contentOk: false` with `contentWarning: "garbled-text"`.
- Multi-column ordering and table reconstruction are benchmark targets, not MVP
  guarantees. OCR is not silently attempted.

Cache keys must include page-range inputs so a partial result cannot poison or
masquerade as the default cached document. Daemon Vehicle input, CLI forwarding,
and Pi public input use the same `pdfPageStart`/`pdfPageEnd` names and server
validation.
