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

Source: <https://github.com/mozilla/pdf.js>
License: <https://github.com/mozilla/pdf.js/blob/master/LICENSE>
