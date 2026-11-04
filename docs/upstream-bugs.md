# Upstream bugs this plugin works around

Each entry gives what breaks, the patch (its `PATCH_MANIFEST` id, tabulated in
[`internals.md`](internals.md)), and when the patch can go.

---

## Non-serializable RSC values throw

**Patch:** `rsc-serializer-throws` (`payloadRscRuntime`)
**Upstream:** https://github.com/cloudflare/vinext/issues/237 (open). PR #250,
merged, improves the error message only.

**What breaks:** React's RSC serializer throws when functions, RegExps or
class instances cross the server/client boundary. Payload field configs carry
`access` functions, `hooks`, `onInit` and validation RegExps, so every admin
page fails. `react-server-dom-webpack@19.3.1`, the version vinext 1.4.3
requires, still has the "Client Component" throws.

**Patch:** rewrites those throw statements to `return undefined`, so the
values arrive on the client as `undefined`.

**Remove when:** vinext's RSC pipeline tolerates non-serializable config
values.

---

## `console.createTask` throws "not implemented"

**Patch:** `workerd-console-createtask` (`payloadWorkerdCompat`)
**Upstream:** https://github.com/cloudflare/workerd/issues/6408,
https://github.com/cloudflare/workerd/issues/6488 (both open)

**What breaks:** workerd defines `console.createTask` but throws when it is
called. React 19 dev mode calls it for async stack traces.

**Patch:** prepends a polyfill that replaces the throwing method with a no-op,
through both a `transform` hook and an `optimizeDeps.rolldownOptions` plugin
(for pre-bundled React), in `rsc` and `ssr`. The two share one Worker isolate,
so whichever React copy evaluates first meets the throwing method.

**Remove when:** workerd makes `console.createTask` a no-op instead of
throwing.

---

## Node builtins in workerd

**Patch:** `workerd-node-builtin-shims` (`payloadWorkerdCompat`)

**What breaks:** workerd does not provide every Node builtin that Payload's
dependency graph imports.

**Patch:** a `resolveId` hook without a filter resolves every `node:*`
specifier in workerd environments to `unenv/node/*`, falling back to Vite's
own resolution when unenv has no shim.
`@cloudflare/vite-plugin`'s own `node:*` resolution runs through a filtered
hook.

**Remove when:** workerd's Node compatibility covers the builtins Payload
pulls in.

---

## undici's runtime feature probe reads a property off `undefined`

**Patch:** `workerd-undici-feature-detect` (`payloadWorkerdCompat`)

**What breaks:** undici's `runtime-features.js` probes for features with lazy
loaders such as `() => require('node:worker_threads')`. Rolldown converts
these to ESM initializers that return `undefined`, so
`detectRuntimeFeatureByExportedProperty` throws a `TypeError` reading a
property of `undefined`.

**Patch:** wraps the function body in `try … catch { return false }`, so
undici falls back to its no-op implementations.

**Remove when:** Rolldown preserves `require()` semantics for externalized
Node builtins, or undici guards its probe.

---

## `import.meta.url` undefined in bundled workerd modules

**Patch:** `workerd-import-meta-url-guard` (`payloadWorkerdCompat`)
**Upstream:** https://github.com/cloudflare/workerd/issues/2963 (open)

**What breaks:** bundled modules in workerd can see `import.meta.url` as
`undefined`. Payload calls `fileURLToPath(import.meta.url)` and
`createRequire(import.meta.url)` at module scope, which crashes module
initialisation, including during Cloudflare's upload validation.

**Patch:** rewrites both calls to use `import.meta.url ?? "file:///"`.

vinext ≥ 1.0.0-beta.7 rewrites dependency `import.meta.url` reads itself
([#2942](https://github.com/cloudflare/vinext/pull/2942)), so under
`vinextPayload()` the guard is inert. `vinextPayloadWorker()` runs without
vinext and needs it.

**Remove when:** workerd provides `import.meta.url` for bundled modules, or
`@cloudflare/vite-plugin` rewrites it the way vinext does.

---

## `file-type` resolves to `core.js`

**Patch:** `file-type-node-entry` (`payloadRscRuntime`)

**What breaks:** `file-type` is a direct dependency of `payload`. Its
`exports` map serves `index.js` under the `node` condition and `core.js`
otherwise. Server environments resolve `core.js`, which lacks the
`fileTypeFromFile` that Payload imports.

**Patch:** resolves `file-type` to `file-type/node` from the importing module.
`strtok3`, which the Node entry imports, has the same condition split and no
Node subpath, so in workerd `fileTypeFromFile` still throws. Payload calls it
only for temp files and local disk storage; buffer detection, which uploads
use, works.

**Remove when:** server environments resolve `file-type` with the `node`
condition.

---

## `drizzle-kit/api` loaded through `createRequire`

**Patch:** `rsc-runtime-stubs` (`payloadRscRuntime`)

**What breaks:** `@payloadcms/drizzle` loads `drizzle-kit/api` with
`createRequire(import.meta.url)`, a runtime `require()` workerd cannot run.
`@payloadcms/drizzle` does not declare `drizzle-kit`, so under pnpm it
resolves only from the adapter packages (`@payloadcms/db-d1-sqlite` and
siblings).

**Patch:** rewrites the `require('drizzle-kit/api')` call. In dev it becomes
a static import, resolved through the adapter packages when needed, so
Payload's dev schema push runs in workerd. In builds it becomes inline no-op
stubs: production never pushes, and `drizzle-kit/api` is 7 MB.

**Remove when:** workerd supports `require()`, or Payload lazy-loads
drizzle-kit.

---

## CommonJS in `node_modules` outside pre-bundling

**Patch:** `cjs-transform` (`payloadCjsTransform`)
**Upstream:** https://github.com/cloudflare/vinext/issues/666 (open). PR #665,
open, covers Pages Router only.

**What breaks:** vinext's App Router sets `noExternal: true` for the RSC and
SSR environments, so CommonJS from `node_modules` goes through Vite's
transforms. Module-scope `this` is `undefined` there, which breaks UMD
wrappers and TypeScript CJS helpers. In the browser, CJS files served through
`/@fs/` without pre-bundling fail on `module.exports`.

**Patch:** replaces module-scope `this` with `globalThis` in every
environment, and in `client` wraps `module.exports` with ESM scaffolding.
Skips `react`, `react-dom`, `react-server-dom-webpack` and `scheduler`.

**Remove when:** Vite converts CJS to ESM for files served outside optimizeDeps
pre-bundling.
