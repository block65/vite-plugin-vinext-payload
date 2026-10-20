# Compatibility issues worked around by this plugin

Every issue listed here works fine on Next.js. They exist because
vinext reimplements Next.js's framework layer on top of Vite, and
these reimplementations have gaps. For each issue, we document what
Next.js does differently and why the gap exists.

---

## `getHTMLDiffComponents` missing export in RSC build

**Responsibility:** @vitejs/plugin-rsc / Rolldown (triggered by Payload UI module layout)
**Repo:** https://github.com/vitejs/vite-plugin-react (packages/plugin-rsc)
**Upstream:** not filed yet

**What breaks:** RSC build can fail with:
`"getHTMLDiffComponents" is not exported by @payloadcms/ui/dist/elements/HTMLDiff/index.js`.
The source module exports it, but the RSC build graph sees it as missing.
`@payloadcms/ui@3.88.0` still re-exports the symbol from
`../../elements/HTMLDiff/index.js`, so the patch still has a target.

**Why Next.js works:** Next.js uses its own RSC/bundling pipeline, not
`@vitejs/plugin-rsc` + Rolldown.

**Our workaround:** `payloadHtmlDiffExportFix` patches
`@payloadcms/ui/dist/exports/rsc/index.js` on disk at build start to
replace the re-export with a fallback export for
`getHTMLDiffComponents`.

---

## Non-serializable RSC values not silently dropped

**Responsibility:** vinext
**Repo:** https://github.com/cloudflare/vinext
**Upstream:** https://github.com/cloudflare/vinext/issues/237
**Status:** OPEN. PR #250 only makes the throw clearer; it does not drop the
value. `react-server-dom-webpack@19.2.8` still carries the "Client Component"
throws the patch rewrites.

**What breaks:** React's RSC serializer throws when functions, RegExps,
or class instances cross the server/client boundary. Payload field configs
contain `access` functions, `hooks`, `onInit`, validation RegExps, etc.
Every admin page fails.

**Why Next.js works:** Next.js catches these throws in its RSC integration
layer (`packages/next/src/server/app-render/`) and silently drops the
values — they become `undefined` on the client. This is intentional
production behavior, not a bug suppression.

**Our workaround:** `payloadRscRuntime` patches the throw statements in
`react-server-dom-webpack` to `return undefined`, so rendering never
aborts. (Note: unlike Next.js, which catches the throw in its integration
layer, we prevent it at the source — the observable behavior matches.)

---

## `console.createTask` throws "not implemented"

**Responsibility:** workerd (Cloudflare Workers runtime)
**Repo:** https://github.com/cloudflare/workerd
**Upstream:** https://github.com/cloudflare/workerd/issues/6408,
https://github.com/cloudflare/workerd/issues/6488
**Status:** both OPEN.

**What breaks:** workerd defines `console.createTask` but throws when
called. React 19 dev mode checks for the method's existence and calls it
for async stack traces, causing a crash.

**Why Next.js works:** Next.js runs RSC in Node.js (or Edge Runtime),
neither of which has a broken `console.createTask`. This is specific to
workerd's polyfill.

**Our workaround:** `payloadWorkerdCompat` prepends a try/catch polyfill
that replaces the broken implementation with a no-op. Injected via both
Vite `transform` hook (for non-pre-bundled modules) and
`optimizeDeps.rolldownOptions.plugins` (for pre-bundled deps like React), in
both `rsc` and `ssr`: the two share one Worker isolate, and whichever React
copy evaluates first meets the throwing method.

---

## `node:*` CJS requires bypass cloudflare plugin's resolveId filter

**Responsibility:** Rolldown / @cloudflare/vite-plugin
**Repo:** https://github.com/rolldown/rolldown (Rolldown), https://github.com/cloudflare/workers-sdk (cloudflare plugin)

**What breaks:** The @cloudflare/vite-plugin resolves `node:*` imports to
unenv polyfills via a resolveId hook with a Rolldown `filter` option. When
a CJS module uses `require('node:worker_threads')` (as undici does in
lazy-loaded feature detectors), Rolldown may not fire the filtered hook
for the CJS require call. The `node:*` import goes unresolved.

**Why Next.js works:** Next.js externalizes Node.js builtins during SSR
bundling. They resolve at runtime against the Node.js standard library.

**Our workaround:** `payloadWorkerdCompat` provides a filterless
resolveId fallback that catches any `node:*` specifier missed by the
cloudflare plugin and routes it to `unenv/node/${bare}`.

---

## undici `detectRuntimeFeatureByExportedProperty` crashes on void

**Responsibility:** Rolldown (CJS→ESM interop)

**What breaks:** undici's `runtime-features.js` uses lazy loaders like
`() => require('node:worker_threads')` to detect runtime features.
Rolldown's CJS→ESM interop converts this to `() => init_worker_threads()`
— an ESM namespace initializer that returns `void`, not the module object.
`detectRuntimeFeatureByExportedProperty` then tries to access a property
on `undefined`, throwing a TypeError (`markAsUncloneable is not a function`).

**Why Next.js works:** Next.js externalizes undici during SSR. The
`require()` calls execute against real Node.js modules that return proper
objects.

**Our workaround:** `payloadWorkerdCompat` wraps
`detectRuntimeFeatureByExportedProperty` in a try-catch so the detection
returns `false` and undici falls back to its no-op stubs.

---

## `import.meta.url` undefined in bundled workerd asset chunks

**Responsibility:** workerd (Cloudflare Workers runtime)
**Repo:** https://github.com/cloudflare/workerd
**Upstream:** https://github.com/cloudflare/workerd/issues/2963
**Status:** OPEN in workerd. vinext `1.0.0-beta.7` works around it itself:
https://github.com/cloudflare/vinext/pull/2942 (`vinext:import-meta-url`,
`enforce: "post"`) rewrites every `import.meta.url` read in a `node_modules`
module for non-client environments — to the source `file://` URL in dev and
to the emitted chunk's identity in builds — naming Payload's
`fileURLToPath(import.meta.url)` / `createRequire(import.meta.url)` shapes as
its motivating case. Under `vinextPayload()` our guard therefore runs first
and is then overwritten by vinext's rewrite (`X ?? "file:///"` where `X` is
vinext's string), so it is inert there. It stays for
`vinextPayloadWorker()`, which runs without vinext.

**What breaks:** Bundled asset modules deployed to workerd may have
`import.meta.url` as `undefined`. Packages like Payload use
`fileURLToPath(import.meta.url)` or `createRequire(import.meta.url)` at
module scope to derive `__dirname` or load native addons. These crash
during Cloudflare's upload validation step (which executes the module to
verify it has event handlers). `import.meta.dirname` is also `undefined`.

**Why Next.js works:** Next.js SSR runs in Node.js where `import.meta.url`
is always set to the module's `file://` URL. Even during production builds,
Next.js resolves `__dirname` at build time via webpack's `__dirname` shim.

**Our workaround:** `payloadWorkerdCompat` transforms both
`fileURLToPath(import.meta.url)` and `createRequire(import.meta.url)` to
use `import.meta.url ?? "file:///"`. The dummy URL produces `"/"` — any
filesystem operation using this path will fail, but those code paths
aren't reached in Workers.

**Remove when:** workerd provides `import.meta.url` for bundled modules, or
`@cloudflare/vite-plugin` rewrites it the way vinext now does — either
covers `vinextPayloadWorker()`, the composition that still needs this guard.

---

## `ssr.external` only applies to "ssr" environment, not RSC

**Responsibility:** Vite (Environment API)

**What breaks:** Vite's `ssr.external` configuration only applies to the
environment named `"ssr"`. When the @cloudflare/vite-plugin manages a
`"rsc"` environment (with `viteEnvironment: { name: "rsc" }`), packages
listed in `ssr.external` are not externalized from the RSC build. This
causes unresolvable imports (e.g., blake3-wasm's `./node.js` platform
file) in the RSC bundle.

`resolve.external` cannot be used either, because the cloudflare plugin
validates and rejects it on all environments it manages.

**Why Next.js works:** Next.js has a single SSR bundling pass that handles
both RSC and SSR. Its externals configuration applies uniformly to all
server-side modules.

**Our workaround:** `payloadServerExternals` uses `configEnvironment` to set
`build.rolldownOptions.external` on both the `"ssr"` and `"rsc"` environments.
This bypasses the `ssr.external` naming limitation and the cloudflare
plugin's `resolve.external` validation.

---

## Transitive deps unavailable in workerd

**Responsibility:** workerd / Payload packaging

**What breaks:** `file-type` is a direct dependency of `payload` itself, used
for upload type detection. Its `exports` map serves `index.js` under the `node`
condition and `core.js` otherwise; server environments resolve `core.js`, which
lacks the `fileTypeFromFile` that Payload imports. `drizzle-kit/api` is
loaded by `@payloadcms/drizzle` through `createRequire(import.meta.url)`, a
runtime `require()` workerd cannot execute, and `@payloadcms/drizzle` does not
declare it, so under pnpm it only resolves from the adapter packages
(`@payloadcms/db-d1-sqlite` and siblings).

**Why Next.js works:** webpack resolves `file-type` with the `node`
condition. It traverses the filesystem directly, bypassing pnpm's symlink
layout. And `drizzle-kit/api` is only used during migration, not at request
time — Next.js's tree-shaking removes it from the runtime bundle.

**Our workaround:** `payloadRscRuntime` resolves `file-type` to `file-type/node`
from the importing module, so Payload's upload checks run real detection. Its
Node APIs come from workerd's `nodejs_compat`, which Payload already requires
for `fs`. `strtok3`, which the Node entry imports, has the same condition split
and no Node subpath, so in workerd it resolves to `core.js` and
`fileTypeFromFile` throws. Payload calls that only for temp files and local
disk storage; buffer detection, the path uploads take, works. For `drizzle-kit/api`, a `transform` hook rewrites the
`require('drizzle-kit/api')` call: in dev to a static import (resolved through
the adapter packages when `@payloadcms/drizzle` cannot see it), so Payload's
dev schema push runs inside workerd; in builds to inline no-op stubs, because
production never pushes and drizzle-kit is 7 MB.

---

## CJS packages fail in App Router dev

**Responsibility:** vinext
**Repo:** https://github.com/cloudflare/vinext
**Upstream:** https://github.com/cloudflare/vinext/issues/666
**Status:** OPEN. PR #665 is also open and covers Pages Router only; App
Router CJS-through-plugin-rsc is unaddressed.

**What breaks:** App Router forces `noExternal: true` for RSC/SSR
environments, so raw CommonJS packages from `node_modules` are pushed
through Vite/plugin-rsc transforms. CJS patterns like `module.exports`
and `this`-as-global cause parse errors ("A module cannot have multiple
default exports") or runtime failures.

**Why Next.js works:** Next.js externalizes most `node_modules` during
SSR and uses webpack's CJS interop layer for the rest. The bundler
natively understands `module.exports` and `this`-as-global.

**Our workaround:** `payloadCjsTransform` rewrites `this` → `globalThis`
in UMD/CJS wrappers and wraps `module.exports` with ESM scaffolding.
Skips React/ReactDOM to avoid double-wrapping.

**Remove when:** vinext fixes #666 natively. PR #665 fixes Pages Router
only; App Router needs separate work.

---

## ~~Navigation shim returns wrong values during hydration~~ (retracted 2026-07-18)

We previously claimed vinext's `next/navigation` shim served fallback
values (`"/"`, `{}`, empty search) during hydration because its
`getServerSnapshot` reads a server context that is `null` on the
client, and shipped `payloadNextNavigationFix` to patch the shim on
disk.

Retracted: the patch had **never applied**. vinext deliberately keeps
`next/navigation` out of `resolve.alias` (shims marked
`reactServer: true` resolve through a `resolveId` hook instead), so
the plugin's alias lookup found nothing and it was a silent no-op —
on 0.1.3 as well as 1.0.0-beta.2. With the patch inert, the admin e2e
suite passes including an explicit no-hydration-errors assertion:
the browser entry calls `setClientParams()` before `hydrateRoot()`,
so the client store is already correct at hydration time. The plugin
was removed; no workaround is needed.

---

## `NEXT_REDIRECT` errors leak through RSC stream — RESOLVED in vinext 0.1.x

**Responsibility:** vinext
**Repo:** https://github.com/cloudflare/vinext
**Upstream:** fixed by https://github.com/cloudflare/vinext/pull/1742,
https://github.com/cloudflare/vinext/pull/1878 and
https://github.com/cloudflare/vinext/pull/2000 (all merged June 2026)
**Status:** RESOLVED upstream; the workaround is removed.

> Earlier revisions of this section cited vinext #654 as the tracking
> issue. That was wrong: #654 is "RSC parity gap: action redirects use
> hard navigation instead of soft RSC navigation", a _separate_ concern
> that is **still open**. It never tracked the `NEXT_REDIRECT` leak
> described here.

**What used to break:** Payload uses `redirect()` for auth checks. On
vinext `0.0.x`, a `redirect()` thrown during async rendering inside
`renderToReadableStream` wasn't intercepted — the error entered the RSC
stream and surfaced as an uncaught `NEXT_REDIRECT` on the client. The
former `payloadRedirectFix` injected a client-side script that caught the
leaked error and performed `location.replace()`.

**What fixed it:** vinext `0.1.x` handles page-level redirects natively.
`dist/server/app-page-execution.js` (verified in `0.1.3`) converts a
thrown `redirect()` into a proper response — `new Response(null, { Location,
status })` (HTTP 302/307) for document requests, a meta-refresh HTML
fallback, and an RSC-encoded redirect (`buildRscRedirectFlightStream` +
client `RedirectErrorBoundary`) for flight navigations. Release note #1742
("hard navigate streamed redirects", `0.1.0`) covers the streaming case the
workaround targeted; #2000 and #1878 round out fallback/console handling.

Verified empirically: the admin e2e auth redirect (`/admin` →
`create-first-user`) passes with the plugin removed and no leaked
`NEXT_REDIRECT` / hydration errors.

---

## Rolldown inlines Workers entry wrapper into bare function

**Responsibility:** Rolldown / @cloudflare/vite-plugin
**Repo:** https://github.com/rolldown/rolldown, https://github.com/cloudflare/workers-sdk
**Upstream:**

- https://github.com/cloudflare/workers-sdk/issues/10213 (original report, closed)
- https://github.com/cloudflare/workers-sdk/pull/10544 (fix: `preserveEntrySignatures: "strict"`)
- https://github.com/rolldown/rolldown/issues/3500 (`preserveEntrySignatures` feature request)
- https://github.com/rolldown/rolldown/issues/6449 (strict mode validation)
  **Status:** workers-sdk #10213 CLOSED, workers-sdk #10544 MERGED, rolldown #3500 CLOSED, rolldown #6449 CLOSED. None of them cover this case: `preserveEntrySignatures: "strict"` governs _named_ exports (it stops extra exports being hoisted onto the entry — the #10213 case), not the _shape of the default-export value_, and no upstream issue covers default-export-object inlining. vinext ships the `{ fetch }` object entry in `dist/server/app-router-entry.js`, and Rolldown can still collapse that object on large bundles. Where it does not collapse, the rewrite applies but passes the already-correct object through untouched, so the patch is defensive.

**What breaks:** vinext's `app-router-entry.js` exports
`{ async fetch(request, env, ctx) { return handleRequest(request, env, ctx) } }`
— the Workers module handler format. When Payload's large dependency
graph (500KB+ RSC bundle) is bundled with Rolldown on Vite 8, Rolldown
inlines the wrapper and exports the RSC handler as a bare
`async function handler(request, ctx)`. Cloudflare Workers expects the
default export to be an object with a `fetch` method; a bare function
produces error 10068: "no registered event handlers".

The @cloudflare/vite-plugin sets `preserveEntrySignatures: "strict"`
(PR #10544, fixing #10213). On Vite 8 this goes into `rolldownOptions`, but
`strict` only preserves the entry's _named exports_ — it does not pin the
_shape_ of the default-export value, so the `{ fetch }` wrapper object still
gets inlined away on large bundles. Small apps aren't affected because
Rolldown doesn't need to inline their entry modules.

**Why Next.js works:** Next.js doesn't target Cloudflare Workers
directly. Its server entry runs in Node.js or Edge Runtime, neither of
which validates the shape of the default export.

**Our workaround:** `payloadWorkerdEntry` adds a `generateBundle`
hook that inspects the RSC entry chunk. If the default export is a
function declaration (not already a `{ fetch }` object), it rewrites
the export to wrap it:
`{ fetch: (request, env, ctx) => handler(request, ctx) }`.

**Remove when:** Rolldown fully enforces `preserveEntrySignatures: "strict"`
for entry module inlining, preventing the wrapper from being optimized away.
