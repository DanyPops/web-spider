# PDF test fixtures

The binary fixtures are copied from Mozilla PDF.js commit
`022e9588728346cde58088a9925120293af1c8f4` and retain its Apache-2.0
license:

| Local fixture | Upstream path | Purpose |
|---|---|---|
| `text.pdf` | `examples/learning/helloworld.pdf` | one-page text layer |
| `multi-page.pdf` | `test/pdfs/three_pages_with_number.pdf` | three independently selectable pages |
| `scanned.pdf` | `test/pdfs/xobject-image.pdf` | image-only page with no text layer |
| `cid-garbled.pdf` | `test/pdfs/arial_unicode_ab_cidfont.pdf` | text layer that decodes to invalid U+FFFF code points |
| `outline.pdf` | `test/pdfs/nested_outline.pdf` | nested, page-addressable document outline |

`malformed.pdf` is a deliberately invalid local fixture and contains no
third-party content.

`recoverable-scanned.pdf` is a locally generated fixture (no third-party
content): a single page with no text layer at all, containing only a
rasterized image of the text "Recovered by OCR fallback / This page has no
text layer." It exists to prove the OCR fallback (see
`docs/pdf-ocr-fallback.md`) actually recovers real text end to end, as
opposed to `scanned.pdf`, whose embedded image has no text in it at all.

Source: <https://github.com/mozilla/pdf.js>
License: <https://github.com/mozilla/pdf.js/blob/master/LICENSE>
