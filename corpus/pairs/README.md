# Before/after pairs

Code as it was before a fix and after it, one directory per case: `<entry>/<rule>/<case>/before.<ext>` and
`after.<ext>`. The rule named by the path must find `before` and must not find `after`; a test walks this
directory and checks exactly that, so a pair added here is a test added.
