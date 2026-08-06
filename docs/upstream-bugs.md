# Compatibility issues worked around by this plugin

Every issue listed here works fine on Next.js. They exist because
vinext reimplements Next.js's framework layer on top of Vite, and
these reimplementations have gaps. For each issue, we document what
Next.js does differently and why the gap exists.

**Last re-check: 2026-08-06**, against vinext `1.0.0-beta.4`, Payload
`3.87.0`, `@payloadcms/next`/`@payloadcms/ui`/`@payloadcms/drizzle` `3.87.0`,
`@vitejs/plugin-rsc` `0.5.33`, `react-server-dom-webpack` `19.2.8`, Vite
`8.2.0`. Two kinds of claim appear below and they are not
interchangeable:

- **Patch target present** — the upstream code the workaround matches still
  exists. Checked statically against the published packages; a "reconfirmed"
  note names the version and file.
- **Bug still reproduces** — removing the workaround still breaks something.
  Only an e2e run can establish this, and none has been run against
  `1.0.0-beta.4`. Where that distinction matters, the section says so.

No upstream issue tracked here changed state between 2026-07-18 and
2026-08-06. One _unfiled_ assumption did change: see the wrangler/blake3-wasm
section.

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

Patch target reconfirmed 2026-08-06: `@vitejs/plugin-rsc@0.5.33` still
relocates exports with `output.move(…)` in `dist/transforms/index.js`.

---

## `getHTMLDiffComponents` missing export in RSC build

**Responsibility:** @vitejs/plugin-rsc / Rolldown (triggered by Payload UI module layout)
**Repo:** https://github.com/vitejs/vite-plugin-react (packages/plugin-rsc)
**Upstream:** not filed yet

**What breaks:** On Payload templates at `payload@3.82.1` with
vinext `0.1.3` (the failure has not been reproduced in isolation on any later
stack; the suites pass with the workaround active), RSC build can fail with:
`"getHTMLDiffComponents" is not exported by @payloadcms/ui/dist/elements/HTMLDiff/index.js`.
The source module exports it, but the RSC build graph sees it as missing.

**Why Next.js works:** Next.js uses its own RSC/bundling pipeline, not
`@vitejs/plugin-rsc` + Rolldown.

**Our workaround:** `payloadHtmlDiffExportFix` patches
`@payloadcms/ui/dist/exports/rsc/index.js` on disk at build start to
replace the re-export with a fallback export for
`getHTMLDiffComponents`.

Patch target reconfirmed 2026-08-06: `@payloadcms/ui@3.87.0` still re-exports
`getHTMLDiffComponents` from `../../elements/HTMLDiff/index.js` in that file.

---

## Non-serializable RSC values not silently dropped

**Responsibility:** vinext
**Repo:** https://github.com/cloudflare/vinext
**Upstream:** https://github.com/cloudflare/vinext/issues/237
**Status:** OPEN (re-checked 2026-08-06; still open. PR #250 only makes the
throw clearer, it doesn't drop the value — workaround still required). Patch
target reconfirmed 2026-08-06: `react-server-dom-webpack` `19.2.8` still
carries the "Client Component" `throw` statements the patch rewrites.

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
**Upstream:** https://github.com/cloudflare/workerd/issues/6408,
https://github.com/cloudflare/workerd/issues/6488
**Status:** both OPEN (re-checked 2026-08-06) — workaround still required.

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
**Upstream:** https://github.com/cloudflare/workerd/issues/2963
**Status:** OPEN (re-checked 2026-08-06) — workaround still required.

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

**What breaks:** `file-type` (a direct dependency of `payload` itself —
`dist/uploads/getFileByPath.js` — so every Payload project pulls it in)
and `drizzle-kit/api` (via `@payloadcms/db-d1-sqlite`) use Node.js
fs/streams APIs that don't exist in workerd. pnpm's strict isolation also prevents the
optimizer from finding them during pre-bundling.

**Why Next.js works:** Next.js runs in Node.js where fs/streams exist.
webpack traverses the filesystem directly, bypassing pnpm's symlink
layout. And these deps are only used during build/migration, not at
request time — Next.js's tree-shaking removes them from the runtime
bundle.

Both still present at `payload@3.87.0` (re-checked 2026-08-06): `file-type` is
a direct dependency (`21.3.4`) used by `dist/uploads/getFileByPath.js`, and
`@payloadcms/drizzle@3.87.0` still calls `require('drizzle-kit/api')` in
`dist/sqlite/requireDrizzleKit.js`.

**Our workaround:** `payloadRscRuntime` stubs both packages. `file-type`
is handled via `resolveId` → static stub file. `drizzle-kit/api` is
loaded via `createRequire(import.meta.url)` which bypasses all bundler
resolution hooks, so we use a `transform` hook to replace the
`require('drizzle-kit/api')` call with inline no-op stubs during
pre-bundling. They're never invoked during RSC rendering — `file-type`
is for upload detection, `drizzle-kit/api` is for migrations.

---

## payload.config's wrangler fallback drags `blake3-wasm` into every bundle

**Responsibility:** Payload cloudflare template pattern / Rolldown resolution
**Repo:** https://github.com/payloadcms/payload (templates/with-cloudflare-d1), https://github.com/rolldown/rolldown

**What breaks:** the cloudflare templates' `payload.config.ts` (and our
`init` rewrite of it) reads bindings via
`import('cloudflare:workers')` with a `catch` fallback to
`import('wrangler')` → `getPlatformProxy()`. The fallback only _executes_
under plain Node (payload CLI), but it must _resolve_ in every Vite
environment that processes the config. Anywhere it gets bundled or
optimizer-scanned, wrangler's entire CLI comes with it — including
`blake3-wasm`, whose `export * from './node.js'` Rolldown cannot resolve.
Dev failed during dependency optimization
(`[UNRESOLVED_IMPORT] Could not resolve './node.js'`) and `vinext build`
failed on the same chain
(`payload.config.ts → wrangler/wrangler-dist/cli.js → blake3-wasm`).
`wrangler` in `SSR_EXTERNAL` / `OPTIMIZE_DEPS_EXCLUDE` does not help: the
cloudflare worker build reads neither.

**Why Next.js works:** the equivalent template uses `@opennextjs/cloudflare`,
whose build pipeline never feeds `payload.config.ts` through a bundler
environment that tries to resolve the wrangler fallback.

**Our workaround:** `payloadCliStubs` stubs `wrangler` with a
`getPlatformProxy` that throws on _call_, not on import — inside workerd
`cloudflare:workers` always resolves so the stub is dead code, and a genuine
Node-side use fails loudly instead of silently.

Resolved 2026-07-18; see
[`d1-dev-boot-investigation.md`](d1-dev-boot-investigation.md) for the full
story (a second, stacked cause — the init matcher missing vinext 1.0's
config shape — masked this one).

**Where the wrangler import actually comes from (clarified 2026-08-06).** Not
from upstream. At `payload@3.87.0` the `with-cloudflare-d1` template reads
bindings via `getCloudflareContext()` from `@opennextjs/cloudflare`, and its
own wrangler fallback is a computed dynamic import no bundler can follow:

```ts
import(/* webpackIgnore: true */ `${"__wrangler".replaceAll("_", "")}`);
```

But that template is written for OpenNext, which vinext supersedes — a project
running under this plugin does not keep it. The config is rewritten to drop
`@opennextjs/cloudflare` and read bindings directly, and the replacement
`getCloudflareEnv()` reads `cloudflare:workers` with a plain
`await import("wrangler")` fallback so the Payload CLI can still resolve
bindings under Node. **That fallback is a static, resolvable specifier**, which
is what pulls `wrangler` — and therefore `blake3-wasm` — into the graph.

So this workaround is load-bearing for the shape _we_ prescribe, not for
upstream's. It cannot be retired by upstream changing the template; it retires
only if the CLI stops needing a Node-side binding path, or the fallback moves
to an unresolvable specifier the way upstream's did.

---

## CJS packages fail in App Router dev

**Responsibility:** vinext
**Repo:** https://github.com/cloudflare/vinext
**Upstream:** https://github.com/cloudflare/vinext/issues/666
**Status:** OPEN (re-checked 2026-08-06; still open. PR #665 is itself still
open and fixes Pages Router only; App Router CJS-through-plugin-rsc is
unaddressed — workaround still required). Whether it still reproduces at
runtime on `1.0.0-beta.4` is unverified: it needs an e2e run.

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

Patch target reconfirmed on `1.0.0-beta.4` (2026-08-06):
`dist/server/app-browser-entry.js` still imports `shims/navigation.js` by
relative path.

---

## Server action handler renders before checking returnValue

**Responsibility:** vinext
**Repo:** https://github.com/cloudflare/vinext
**Upstream:** not filed (related: https://github.com/cloudflare/vinext/pull/620)

**What breaks:** vinext applies the new RSC tree before checking
`result.returnValue`. Every server action — including data-returning ones
like `getFormState` — triggers a full re-render. For Payload, this resets
form state: array field rows flash and disappear.

The bug has moved across vinext versions:

- ≤0.0.46: `getReactRoot().render(result.root)` runs in `app-browser-entry`
  before the `returnValue` check.
- 0.0.47–0.0.49: refactored — `commitSameUrlNavigatePayload` in
  `app-browser-navigation-controller` unconditionally calls
  `dispatchApprovedVisibleCommit` before returning the action's data.
- 0.0.50–0.0.55: same site as 0.0.47–0.0.49, but the call was renamed to
  `dispatchSynchronousVisibleCommit` (a thinner sync wrapper), still a
  one-line `if ($COND) dispatch(…)`.
- ≥0.1.0: the dispatch moved into a block body
  (`if (latestApproval.approvedCommit) { dispatch(…); syncHistory(…); }`,
  with an `else` branch), so the one-line gate no longer matches.

**Why Next.js works:** Next.js's server action handler (`app-router.js`)
checks `returnValue` first and only re-renders for void mutations. Data-
returning actions pass the value back to the caller without touching
the React tree.

**Our workaround:** `payloadServerActionFix` uses ast-grep. On ≤0.0.46 it
moves the render call after the `returnValue` check. On 0.0.47–0.0.55 it ANDs
`!returnValue` onto the one-line dispatch's condition (matching either
dispatcher name). On ≥0.1.0, where the dispatch is a bare statement inside a
block, it wraps the call as `if (!returnValue) dispatch(…)` (gating the outer
`if` would wrongly trip the `else` branch). A drift detector unit test
transforms the real installed vinext file so a future shape change fails
loudly.

Patch target reconfirmed on `1.0.0-beta.4` (2026-08-06):
`dist/server/app-browser-navigation-controller.js` still contains
`commitSameUrlNavigatePayload` and `dispatchSynchronousVisibleCommit`, and the
transform still rewrites the real file. beta.3/beta.4 shipped app-router
changes in this area (prefetch protocol, client cache stale times, streamed
metadata), so the shape surviving is not proof the _behaviour_ is unchanged —
that needs the admin e2e journey.

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

Patch targets reconfirmed 2026-08-06 against `@payloadcms/next@3.87.0`:
`elements/Nav/index.client.js` still contains `pathname === href`, and
`elements/DocumentHeader/Tabs/Tab/TabLink.js` still renders
`el: !isActive || href !== pathname ? "link" : "div"`.

---

## `NEXT_REDIRECT` errors leak through RSC stream — RESOLVED in vinext 0.1.x

**Responsibility:** vinext
**Repo:** https://github.com/cloudflare/vinext
**Upstream:** fixed by https://github.com/cloudflare/vinext/pull/1742,
https://github.com/cloudflare/vinext/pull/1878 and
https://github.com/cloudflare/vinext/pull/2000 (all merged June 2026)
**Status:** RESOLVED — workaround removed at the vinext `0.1.3` bump; still
resolved on `1.0.0-beta.2` (verified by e2e 2026-07-18). All three PRs remain
merged (re-checked 2026-08-06); not re-verified by e2e on `1.0.0-beta.4`.

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
  **Status:** workers-sdk #10213 CLOSED, workers-sdk #10544 MERGED, rolldown #3500 CLOSED, rolldown #6449 CLOSED (re-checked 2026-08-06 — no change since 2026-06-15). Still needed: `preserveEntrySignatures: "strict"` governs _named_ exports (it stops extra exports being hoisted onto the entry — the #10213 case), not the _shape of the default-export value_, and no upstream issue covers default-export-object inlining. vinext still ships the `{ fetch }` object entry in `dist/server/app-router-entry.js` — reconfirmed on `1.0.0-beta.4` by the drift detector in `test/patch-targets.test.ts` — and Rolldown can still collapse that object on large bundles. On `1.0.0-beta.2` (verified against a real cloudflare-target build, 2026-07-18) the entry chunk's default export survived as a `{ fetch }` object, so the workaround's rewrite applied but its runtime wrapper passed the object through untouched: it had no effect on the emitted output and only guarded against the collapse recurring. Whether that still holds on a beta.4 cloudflare build is unverified.

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
