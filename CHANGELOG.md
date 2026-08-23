# Changelog

Consumer-visible changes since the last release. Released versions live in
[GitHub releases](https://github.com/block65/vite-plugin-vinext-payload/releases).

## Unreleased

- Payload collections with a `richText` field no longer crash the admin with
  `TypeError: createContext is not a function`. The plugin's CJS interop step
  runs before `@vitejs/plugin-rsc` and, on Vite 8, prepended its generated
  preamble above the `'use client'` directive of any module importing an
  interop dependency. That moved the directive out of the parser's prologue,
  so `@payloadcms/richtext-lexical`'s client entry was treated as server code
  and evaluated under the `react-server` condition. The interop step now keeps
  the directive at the top of the module.
- **Breaking:** the `vinext` peer dependency now requires exactly
  `1.0.0-beta.8`, up from `1.0.0-beta.2`. Upgrade vinext alongside this
  plugin — the pin is exact because every vinext pre-release moves internals
  the plugin patches. Validated against Payload `3.88.0` and Vite `8.2.2`.
- `init` now edits the generated `layout.tsx` in place — removing the inline
  `serverFunction` and importing it from `serverFunction.ts` — instead of
  replacing the file with a fixed template. Payload's current templates ship
  `custom.css` and a `generateViewport` export; the old template import of
  `./custom.scss` made every `/admin` request fail with "Failed to load url
  ./custom.scss" on a freshly generated project.
- Server actions that return data _and_ revalidate now re-render the page as
  they do on Next.js. The plugin no longer patches vinext's navigation
  controller: vinext itself skips the re-render for non-revalidating actions
  (the `getFormState` case the patch existed for), so the gate only ever
  suppressed the legitimate commit.
