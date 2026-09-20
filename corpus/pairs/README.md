# Before/after pairs

Code before a fix and after it, one directory per case: `<entry>/<case>/before.<ext>` and `after.<ext>`.
`corpus/manifest.yaml` says, for every case, which rule a correct check reports on `before`, whether today's
engine does, and where the case comes from; `after` must always be silent. `npm run corpus:check` holds the
manifest, the files and the engine against each other, and the same check runs as a test.

A `real-*` case is an unmodified excerpt of a public repository (see `NOTICE.md`); a `synthetic-*` case was
written here, and the manifest says why. The files are kept out of the formatter: some cases are about the
very line breaks a formatter would remove.
