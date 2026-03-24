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

## Non-serializable RSC values not silently dropped

**Responsibility:** vinext
**Repo:** https://github.com/cloudflare/vinext

**What breaks:** React's RSC serializer throws when functions, RegExps,
or class instances cross the server/client boundary. Payload field configs
contain `access` functions, `hooks`, `onInit`, validation RegExps, etc.
Every admin page fails.

**Why Next.js works:** Next.js catches these throws in its RSC integration
layer (`packages/next/src/server/app-render/`) and silently drops the
values — they become `undefined` on the client. This is intentional
production behavior, not a bug suppression.

**Our workaround:** `payloadRscStubs` patches the throw statements in
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

**Our workaround:** `payloadRscStubs` prepends a try/catch polyfill
that replaces the broken implementation with a no-op.

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

**Our workaround:** `payloadRscStubs` provides empty stub modules for
both packages. They're never invoked during RSC rendering — `file-type`
is for upload detection, `drizzle-kit/api` is for migrations.

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

**Our workaround:** `payloadNavigationHydrationFix` patches the shim on
disk so `getServerSnapshot` uses the client snapshot function. The
browser entry calls `setClientParams()` before `hydrateRoot()`, so
the client store has correct values at hydration time.

---

## Browser entry imports shims via relative paths

**Responsibility:** vinext
**Repo:** https://github.com/cloudflare/vinext

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

**Our workaround:** `payloadNavHydrationFix` uses ast-grep to force
consistent rendering: ternaries with `"link"` / `"div"` alternatives
become `"link"`, `pathname === href` becomes `false`, etc.

---

## `NEXT_REDIRECT` errors leak through RSC stream

**Responsibility:** vinext
**Repo:** https://github.com/cloudflare/vinext

**What breaks:** Payload uses `redirect()` for auth checks. When thrown
during async rendering inside `renderToReadableStream`, vinext doesn't
intercept it. The error enters the RSC stream and surfaces on the client.

**Why Next.js works:** Next.js catches `NEXT_REDIRECT` sentinel errors
at multiple levels: in `renderToReadableStream`'s error handler, in the
RSC flight response writer, and in the app router's request handler. All
are converted to proper HTTP 302 responses.

**Our workaround:** `payloadRedirectFix` injects a client-side script
that intercepts the leaked error and performs `location.replace()`.
