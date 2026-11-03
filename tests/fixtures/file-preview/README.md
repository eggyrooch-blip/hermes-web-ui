# File preview fixtures

Minimal, real documents for the four formats the files panel renders in place
(`pdf` / `docx` / `pptx` / `xlsx`). They exist so the preview path is exercised
against genuine OOXML packages and a genuine PDF rather than synthetic byte
buffers, and so a human can drag the same four files into the panel when
checking the UI.

| File | Contents |
|---|---|
| `sample.docx` | Heading, two paragraphs (one Chinese), a 2x2 table |
| `sample.pptx` | Two slides, title + body, one Chinese body |
| `sample.xlsx` | Two worksheets (`Summary`, `Detail`); `Summary` has a header row plus three data rows |
| `sample.pdf` | One A4 page, two lines of Helvetica text |

Provenance — regenerate only if the expectations in
`tests/client/file-preview-formats.test.ts` change:

- `sample.docx` — `python-docx`
- `sample.pptx` — `python-pptx`
- `sample.xlsx` — `openpyxl`
- `sample.pdf` — written byte by byte (catalog / pages / page / content stream /
  Helvetica font, then an xref table), no library involved

## Hostile samples

Two archives that are deliberately malformed. They exist so the ZIP pre-check
is tested against real attacker-shaped input rather than hand-built buffers.
Neither contains executable content; both are inert data that only ever reaches
`assertBoundedOoxmlArchive`.

| File | What is wrong with it |
|---|---|
| `hostile-appended-eocd.xlsx` | `sample.xlsx` with a second, zero-entry end-of-central-directory record appended. A guard that trusts the last record it finds walks no entries and clears every size limit, while JSZip parses the real directory underneath. |
| `hostile-ratio-bomb.docx` | A valid docx whose `word/document.xml` declares 34 MB uncompressed from 97 KB on disk (343:1). Every per-entry and total byte limit passes; only a compression-ratio check catches it. |

Provenance: both are generated from the honest fixtures above by
`tests/client/file-preview-formats.test.ts`'s sibling script in the commit that
introduced them — `hostile-appended-eocd.xlsx` is `sample.xlsx` plus a 22-byte
record packed as `<IHHHHIIH` zeros, `hostile-ratio-bomb.docx` is a `zipfile`
package whose document part is one `<w:p>` repeated a million times.

Nothing here is confidential; the content is invented for this repository.
