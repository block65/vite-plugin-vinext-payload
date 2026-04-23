# Compatibility issues worked around by this plugin

Every issue listed here works fine on Next.js. They exist because
vinext reimplements Next.js's framework layer on top of Vite, and
these reimplementations have gaps. For each issue, we document what
Next.js does differently and why the gap exists.

---

## RSC export transform drops exports after sourcemap comments

**Responsibility:** @vitejs/plugin-rsc
**Repo:** https://github.com/vitejs/vite-plugin-react (packages/plugin-rsc)

**What breaks:** `transformWrapExport` uses `output.move()` to relocate
`export { name }` statements to the end of the file. When the source ends
with `//# sourceMappingURL=…` (no trailing newline), the moved export is
concatenated onto the comment line, making it invisible to Rolldown.

**Why Next.js works:** Next.js uses its own RSC transform implementation
(in `packages/next/src/build/`), not plugin-rsc. The bug is specific to
plugin-rsc's `output.move()` path.

**Our workaround:** `payloadRscExportFix` inserts a newline before any
`export` keyword found after a `//` comment on the same line.

---

## `getHTMLDiffComponents` missing export in RSC build

**Responsibility:** @vitejs/plugin-rsc / Rolldown (triggered by Payload UI module layout)
**Repo:** https://github.com/vitejs/vite-plugin-react (packages/plugin-rsc)
**Upstream:** not filed yet

**What breaks:** On current Payload templates (`payload@3.82.1`) with
vinext `0.0.41`, RSC build can fail with:
`"getHTMLDiffComponents" is not exported by @payloadcms/ui/dist/elements/HTMLDiff/index.js`.
The source module exports it, but the RSC build graph sees it as missing.

**Why Next.js works:** Next.js uses its own RSC/bundling pipeline, not
`@vitejs/plugin-rsc` + Rolldown.

**Our workaround:** `payloadHtmlDiffExportFix` patches
`@payloadcms/ui/dist/exports/rsc/index.js` on disk at build start to
replace the brittle re-export with a stable fallback export for
`getHTMLDiffComponents`.

---

## Non-serializable RSC values not silently dropped

**Responsibility:** vinext
**Repo:** https://github.com/cloudflare/vinext
**Upstream:** https://github.com/cloudflare/vinext/issues/237
**Status:** OPEN (updated 2026-03-07)

**What breaks:** React's RSC serializer throws when functions, RegExps,
or class instances cross the server/client boundary. Payload field configs
contain `access` functions, `hooks`, `onInit`, validation RegExps, etc.
Every admin page fails.

**Why Next.js works:** Next.js catches these throws in its RSC integration
layer (`packages/next/src/server/app-render/`) and silently drops the
values — they become `undefined` on the client. This is intentional
production behavior, not a bug suppression.

**Our workaround:** `payloadRscRuntime` patches the throw statements in
`react-server-dom-webpack` to `return undefined`, matching Next.js prod
behavior. vinext's `rscOnError` only controls the error digest, not
whether rendering aborts — our transform prevents the throw entirely.

---

## Barrel exports missing `'use client'` directive

**Responsibility:** Payload CMS
**Repo:** https://github.com/payloadcms/payload

**What breaks:** Some `@payloadcms/*` packages expose client components
through barrel files that don't carry `'use client'` themselves. Vite's
optimizer merges the barrel and component into one chunk, stripping the
directive. The RSC transform can't detect the client boundary.

**Why Next.js works:** Next.js's bundler (webpack/Turbopack) propagates
`'use client'` semantics through re-export chains. This is a Next.js
convenience — the React spec says `'use client'` is per-file.

**Our workaround:** `payloadUseClientBarrel` auto-detects affected
packages and excludes them from RSC optimizeDeps so files go through
the transform pipeline individually.

---

## `console.createTask` throws "not implemented"

**Responsibility:** workerd (Cloudflare Workers runtime)
**Repo:** https://github.com/cloudflare/workerd

**What breaks:** workerd defines `console.createTask` but throws when
called. React 19 dev mode checks for the method's existence and calls it
for async stack traces, causing a crash.

**Why Next.js works:** Next.js runs RSC in Node.js (or Edge Runtime),
neither of which has a broken `console.createTask`. This is specific to
workerd's polyfill.

**Our workaround:** `payloadWorkerdCompat` prepends a try/catch polyfill
that replaces the broken implementation with a no-op. Injected via both
Vite `transform` hook (for non-pre-bundled modules) and
`optimizeDeps.rolldownOptions.plugins` (for pre-bundled deps like React).

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

---

## `ssr.external` only applies to "ssr" environment, not RSC

**Responsibility:** Vite (Environment API)

**What breaks:** Vite's `ssr.external` configuration only applies to the
environment named `"ssr"`. When the @cloudflare/vite-plugin manages a
`"rsc"` environment (with `viteEnvironment: { name: "rsc" }`), packages
listed in `ssr.external` are not externalized from the RSC build. This
causes unresolvable imports (e.g., blake3-wasm's `./node.js` platform
file) in the RSC bundle.

Additionally, `resolve.external` cannot be used because the cloudflare
plugin validates and rejects it on all environments it manages.

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

**What breaks:** `file-type` and `drizzle-kit/api` are transitive deps
of `@payloadcms/db-d1-sqlite`. They use Node.js fs/streams APIs that
don't exist in workerd. pnpm's strict isolation also prevents the
optimizer from finding them during pre-bundling.

**Why Next.js works:** Next.js runs in Node.js where fs/streams exist.
webpack traverses the filesystem directly, bypassing pnpm's symlink
layout. And these deps are only used during build/migration, not at
request time — Next.js's tree-shaking removes them from the runtime
bundle.

**Our workaround:** `payloadRscRuntime` stubs both packages. `file-type`
is handled via `resolveId` → static stub file. `drizzle-kit/api` is
loaded via `createRequire(import.meta.url)` which bypasses all bundler
resolution hooks, so we use a `transform` hook to replace the
`require('drizzle-kit/api')` call with inline no-op stubs during
pre-bundling. They're never invoked during RSC rendering — `file-type`
is for upload detection, `drizzle-kit/api` is for migrations.

---

## CJS packages fail in App Router dev

**Responsibility:** vinext
**Repo:** https://github.com/cloudflare/vinext
**Upstream:** https://github.com/cloudflare/vinext/issues/666
**Status:** OPEN (updated 2026-03-30)

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

## Navigation shim returns wrong values during hydration

**Responsibility:** vinext
**Repo:** https://github.com/cloudflare/vinext

**What breaks:** vinext's `next/navigation` shim implements
`usePathname`, `useParams`, and `useSearchParams` via
`useSyncExternalStore`. The `getServerSnapshot` reads from a server
context that is `null` on the client, so during hydration React gets
fallback values (`"/"`, `{}`, empty search) instead of the real URL.

**Why Next.js works:** Next.js uses React context (`PathnameContext`,
`SearchParamsContext`) for these hooks. The context provider wraps the
entire tree, so server and client values are always consistent during
hydration.

**Our workaround:** `payloadNextNavigationFix` patches the shim on
disk so `getServerSnapshot` uses the client snapshot function. The
browser entry calls `setClientParams()` before `hydrateRoot()`, so
the client store has correct values at hydration time.

---

## Browser entry imports shims via relative paths

**Responsibility:** vinext
**Repo:** https://github.com/cloudflare/vinext
**Upstream:** not filed (low priority; architectural choice in vinext)

**What breaks:** vinext's browser entry imports the navigation shim via
`from "../shims/navigation.js"` (relative path) instead of the aliased
`from "next/navigation"`. Vite serves the raw file alongside the
pre-bundled version — two module instances, two React copies, split
state. On cold cache, the optimizer discovers the new module and
triggers a full page reload.

**Why Next.js works:** Next.js bundles the browser entry as a single
webpack/Turbopack chunk. All `next/navigation` imports resolve to the
same module instance. There's no optimizer or alias indirection.

**Our workaround:** `payloadServerActionFix` rewrites the relative
import to the aliased specifier. `payloadOptimizeDeps` auto-discovers
all `next/*` alias specifiers and pre-includes them so the optimizer
doesn't discover them at runtime.

---

## Server action handler renders before checking returnValue

**Responsibility:** vinext
**Repo:** https://github.com/cloudflare/vinext
**Upstream:** not filed (related: https://github.com/cloudflare/vinext/pull/620)

**What breaks:** vinext calls `getReactRoot().render(result.root)` before
checking `result.returnValue`. Every server action — including
data-returning ones like `getFormState` — triggers a full re-render.
For Payload, this resets form state: array field rows flash and disappear.

**Why Next.js works:** Next.js's server action handler (`app-router.js`)
checks `returnValue` first and only re-renders for void mutations. Data-
returning actions pass the value back to the caller without touching
the React tree.

**Our workaround:** `payloadServerActionFix` uses ast-grep to move the
render call after the `returnValue` check.

---

## Components switch element types based on pathname/params

**Responsibility:** vinext (navigation shim) / Payload (conditional rendering)

**What breaks:** Payload components (`DefaultNavClient`, `DocumentTabLink`)
conditionally render `<Link>` or `<div>` based on `usePathname()` /
`useParams()`. When vinext's navigation shim returns different values
during hydration (see "Navigation shim" above), React 19 detects an
element-type mismatch and discards the entire server-rendered subtree.

**Why Next.js works:** Next.js's navigation hooks return consistent values
during SSR and hydration (via React context), so the conditional rendering
always produces the same element type on both sides.

**Our workaround:** `payloadNavComponentFix` uses ast-grep to force
consistent rendering: ternaries with `"link"` / `"div"` alternatives
become `"link"`, `pathname === href` becomes `false`, etc.

---

## `NEXT_REDIRECT` errors leak through RSC stream

**Responsibility:** vinext
**Repo:** https://github.com/cloudflare/vinext
**Upstream:** https://github.com/cloudflare/vinext/issues/654
**Status:** OPEN (updated 2026-03-25)

**What breaks:** Payload uses `redirect()` for auth checks. When thrown
during async rendering inside `renderToReadableStream`, vinext doesn't
intercept it. The error enters the RSC stream and surfaces on the client.

**Why Next.js works:** Next.js catches `NEXT_REDIRECT` sentinel errors
at multiple levels: in `renderToReadableStream`'s error handler, in the
RSC flight response writer, and in the app router's request handler. All
are converted to proper HTTP 302 responses.

**Our workaround:** `payloadRedirectFix` injects a client-side script
that intercepts the leaked error and performs `location.replace()`.

**Remove when:** vinext fixes #654 to handle page-level redirects
(not just server action redirects).

---

## Rolldown inlines Workers entry wrapper into bare function

**Responsibility:** Rolldown / @cloudflare/vite-plugin
**Repo:** https://github.com/rolldown/rolldown, https://github.com/cloudflare/workers-sdk
**Upstream:**
- https://github.com/cloudflare/workers-sdk/issues/10213 (original report, closed)
- https://github.com/cloudflare/workers-sdk/pull/10544 (fix: `preserveEntrySignatures: "strict"`)
- https://github.com/rolldown/rolldown/issues/3500 (`preserveEntrySignatures` feature request)
- https://github.com/rolldown/rolldown/issues/6449 (strict mode validation)
**Status:** workers-sdk #10213 CLOSED, workers-sdk #10544 MERGED, rolldown #3500 CLOSED, rolldown #6449 CLOSED (checked 2026-04-10)

**What breaks:** vinext's `app-router-entry.js` exports
`{ async fetch(request, _env, ctx) { ... rscHandler(request, ctx) ... } }`
— the Workers module handler format. When Payload's large dependency
graph (500KB+ RSC bundle) is bundled with Rolldown on Vite 8, Rolldown
inlines the wrapper and exports the RSC handler as a bare
`async function handler(request, ctx)`. Cloudflare Workers expects the
default export to be an object with a `fetch` method; a bare function
produces error 10068: "no registered event handlers".

The @cloudflare/vite-plugin sets `preserveEntrySignatures: "strict"`
(PR #10544, fixing #10213) to prevent this. On Vite 8, this goes into
`rolldownOptions`, but Rolldown doesn't fully enforce it — the wrapper
object still gets inlined away on large bundles. Small apps aren't
affected because Rolldown doesn't need to inline their entry modules.

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
