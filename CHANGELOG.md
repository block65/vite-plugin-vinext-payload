# Changelog

Consumer-visible changes since the last release. Released versions live in
[GitHub releases](https://github.com/block65/vite-plugin-vinext-payload/releases).

## Unreleased

**Fixed**

- **Uploads to a collection that sets `upload.mimeTypes` are no longer rejected.** The plugin replaced `file-type` with a stub that detected nothing, so Payload fell back to the file extension, read images and PDFs as `text/plain` and answered 400. Payload now detects file types from their contents.
