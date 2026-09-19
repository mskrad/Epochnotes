# Before/after pairs

Code before a fix and after it, one directory per case: `<entry>/<rule>/<case>/before.<ext>` and `after.<ext>`.
The rule named by the path must find `before` and must not find `after`; a test walks this directory and checks
exactly that, so a pair added here is a test added.

A case is either taken from a repository in the field or written to reproduce a reported miss; the first comment
of its `before` file says which. The files are kept out of the formatter: some cases are about the very line
breaks a formatter would remove.
