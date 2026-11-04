# Changelog

Consumer-visible changes since the last release. Released versions live in
[GitHub releases](https://github.com/block65/vite-plugin-vinext-payload/releases).

## Unreleased

**Breaking**

- **Tested on vinext `1.4.3`**, with Payload `3.92.1` and Vite `8.3.5`.
- **Cloudflare setup follows what `vinext init --platform=cloudflare` writes**: `@cloudflare/vite-plugin` v2 with a `cloudflare.config.ts`. Declare `PAYLOAD_SECRET` there with `bindings.secret()`; see the [Cloudflare D1 guide](docs/cloudflare-d1.md).
- **The `ssrExternal` option is removed** from `vinextPayload()` and `vinextPayloadWorker()`. Built servers and Workers start without the plugin externalizing `esbuild`, `wrangler`, `miniflare`, `sharp` or `cloudflare:workers`. To externalize a package yourself, set `build.rolldownOptions.external` on the server environment in `vite.config.ts`.
- **The `vite-plugin-vinext-payload init` command is removed**, and with it the package's `vite-plugin-vinext-payload` binary. Run `vinext init`, then add `vinextPayload()` after `vinext()` in `vite.config.ts`.
- **The `cjsInteropDeps` option is removed** from `vinextPayload()` and `vinextPayloadWorker()`. Payload no longer needs the extra CommonJS default-export interop on vinext 1.4, so the plugin no longer depends on `vite-plugin-cjs-interop`. Delete the option from `vite.config.ts`.

**Fixed**

- **The admin UI no longer crashes on Payload 3.91** with `ReferenceError: require is not defined` from `sanitize-filename`. Payload 3.91 began loading it in the browser, and it is now pre-bundled for the client.
- **Payload pushes its dev schema to D1** in `vite dev`, as it does under Next.js. Previously `drizzle-kit` was stubbed in every mode, so a fresh local D1 had no tables and every request failed with `no such table`. Production builds still stub it.
