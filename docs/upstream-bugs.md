# Upstream bugs worked around by this plugin

## @vitejs/plugin-rsc: `transformWrapExport` drops exports after sourcemap comments

**Status:** Not yet filed upstream.
**Responsibility:** @vitejs/plugin-rsc
**Repo:** https://github.com/vitejs/vite-plugin-react (packages/plugin-rsc)

**Bug:** `transformWrapExport` (in `server-action-*.js`) uses
`output.move(start, end, input.length)` to relocate `export { name }`
statements to the end of the file. When the original source ends with
`//# sourceMappingURL=…` (no trailing newline), the moved export is
concatenated directly onto the comment line, making it invisible to
Rolldown.

**Trigger conditions:**
1. Module imports CSS/SCSS (triggers `rsc:rsc-css-export-transform`)
2. Module file ends with `//# sourceMappingURL=…` without trailing newline
3. Module exports non-uppercase-starting names (filter doesn't wrap them,
   but the export keyword is already stripped and must be re-emitted)

**Example:** `@payloadcms/ui/dist/elements/HTMLDiff/index.js` exports
`getHTMLDiffComponents` (lowercase) and imports `./index.scss`.

**Fix:** Trivial — prepend `\n` to the moved content, or ensure a newline
before the move target. They already handle this correctly in their own
test utils (`packages/plugin-rsc/src/transforms/test-utils.ts` —
`inlineSourceMap` adds `\n` around sourcemap URLs) but missed it in the
`output.move()` path.

**Our workaround:** `payloadRscExportFix` plugin (`src/rsc-export-fix.ts`)
runs as a post-transform and inserts a newline before any `export` keyword
found after a `//` comment on the same line.

---

## vinext: non-serializable RSC values not silently dropped

**Status:** Not yet filed upstream.
**Responsibility:** vinext
**Repo:** https://github.com/cloudflare/vinext

**Issue:** React's RSC serializer throws when non-serializable values
(functions, RegExps, class instances) cross the server/client boundary.
This is correct behavior — Next.js handles it by catching these throws
in its own RSC integration layer and silently dropping the values
(they become `undefined` on the client). vinext doesn't replicate
this suppression.

**Error messages:**
- `"Functions cannot be passed directly to Client Components"`
- `"Functions are not valid as a child of Client Components"`
- `"Only plain objects, and a few built-ins, can be passed to Client Components"`
- `"Event handlers cannot be passed to Client Component props"`

**Why Payload hits this:** Field configs contain `access` functions, `hooks`,
`onInit`, validation RegExps, etc. Next.js silently drops them at the RSC
boundary. Without suppression, every Payload admin page fails.

**Our workaround:** Transform hook in `payloadRscStubs` patches the throw
statements in `react-server-dom-webpack_server__edge.js` to
`return undefined;` (matching Next.js prod behavior). Only applies to
modules with `react-server-dom-webpack` in the ID.

---

## Payload: barrel exports missing `'use client'` directive

**Status:** Payload packaging issue.
**Responsibility:** Payload CMS
**Repo:** https://github.com/payloadcms/payload

**Issue:** Some `@payloadcms/*` packages expose client components through
barrel files that don't carry `'use client'` themselves — only the
underlying component files have the directive. This works in Next.js
because its bundler propagates `'use client'` through re-export chains,
but that's a Next.js convenience, not part of the React spec. The
directive is per-file: if the barrel doesn't have it, it's a server
module.

When Vite's optimizer pre-bundles these packages, it merges the barrel
and component into one chunk. The `'use client'` directive is stripped,
the RSC transform can't detect the client boundary, and the component
runs on the server.

**Example:** `@payloadcms/storage-r2/client` is a barrel that re-exports
`R2ClientUploadHandler` from `dist/client/R2ClientUploadHandler.js`. Only
the component file has `'use client'`, not the barrel.

**Our workaround:** Exclude affected packages from RSC
optimizeDeps so files go through the transform pipeline individually,
where the RSC transform sees `'use client'` on the actual component file.
Additionally, `payloadUseClientBarrel` (`src/use-client-barrel.ts`)
propagates `'use client'` through barrel files for non-pre-bundled paths.

---

## @vitejs/plugin-rsc: client reference proxy throws on invocation

**Status:** By design in plugin-rsc (but overly strict for framework use).
**Responsibility:** @vitejs/plugin-rsc
**Repo:** https://github.com/nicolo-ribaudo/vite-plugin-rsc

**Bug:** When a `"use client"` export is called as a function on the server
(not rendered as a component), plugin-rsc's client reference proxy throws
`"Unexpectedly client reference export '...' is called on server"`. This
is correct for catching real bugs but breaks Payload CMS where server-side
initialization code touches client exports.

The proxy is generated in two places:
- `dist/core/rsc.js:21` — runtime proxy creation
- `dist/plugin.js:761` — transform-time injection into any `"use client"`
  module (this means the throw can appear in ANY module, not just
  plugin-rsc files)

**Our workaround:** Transform hook in `payloadRscStubs` patches throws
containing `"Unexpectedly client reference export"` to return a deep
no-op Proxy (handles arbitrary property access and function calls).
Applied to ALL RSC modules since plugin-rsc injects the code into
third-party packages.

---

## workerd: `console.createTask` throws "not implemented"

**Status:** Not yet filed upstream.
**Responsibility:** workerd (Cloudflare Workers runtime)
**Repo:** https://github.com/cloudflare/workerd

**Bug:** workerd's `node:console` polyfill defines `console.createTask` but
throws `"The Console.createTask method is not implemented"` when called.
React 19 dev mode checks for the method's existence (truthy — it exists)
and calls it for async stack traces, causing a crash.

**Expected behavior:** `console.createTask` should be a no-op returning
`{ run: fn => fn() }`, matching Chrome's Task API.

**Our workaround:** Transform hook in `payloadRscStubs` prepends a
try/catch polyfill to React modules that reference `console.createTask`.
The polyfill detects the broken implementation and replaces it.

---

## workerd: can't resolve externalized packages

**Status:** Architecture mismatch (not a bug per se).
**Responsibility:** This plugin (SSR_EXTERNAL list was too broad for workerd)

**Bug:** `ssr.external` applies to ALL server environments including RSC.
In Node.js SSR, externalized packages are resolved via Node's native module
resolution. In workerd (Cloudflare's module runner), there's no native
module resolution — externalized packages can't be found.

**Affected packages:** `graphql`, `graphql-http`, `drizzle-kit`,
`drizzle-kit/api`, `pino`, `pluralize` — all were in `SSR_EXTERNAL`.

**Our fix:** Removed runtime packages from `SSR_EXTERNAL`. Only build-time
tools (`esbuild`, `wrangler`, `miniflare`) and native addons (`sharp`)
remain externalized. Runtime CJS packages are now handled by optimizeDeps.

---

## pnpm strict isolation: transitive deps unresolvable during pre-bundling

**Status:** pnpm design / Vite limitation.
**Responsibility:** Vite / pnpm interaction

**Bug:** `file-type` and `drizzle-kit/api` are transitive dependencies of
`@payloadcms/db-d1-sqlite`. pnpm's strict `node_modules` layout prevents
esbuild/Rolldown from finding them during pre-bundling. The pre-bundled
chunk ends up with bare external imports that the workerd module runner
can't resolve.

**Our workaround:** Stub modules (`src/stubs/file-type.ts`,
`src/stubs/drizzle-kit-api.ts`) resolved via esbuild/Rolldown plugins
during pre-bundling and via `resolveId` hook at runtime. `file-type` uses
Node.js fs APIs unavailable in workerd. `drizzle-kit/api` provides
migration utilities not needed during RSC rendering.

**Note:** `drizzle-kit/api` is loaded via dynamic `require()` in the
pre-bundled chunk, so the Rolldown/esbuild plugins don't intercept it.
The error is non-fatal — the page renders despite it.

---

## vinext: `rscOnError` doesn't suppress function-passing RSC errors

**Status:** Not yet filed upstream.
**Responsibility:** vinext
**Repo:** https://github.com/cloudflare/vinext

**Bug:** Next.js silently drops functions passed across the RSC boundary
(e.g. `label`, `access`, `hooks` in Payload CMS field configs). The
function prop becomes `undefined` on the client. vinext's `rscOnError`
handler in `dist/entries/app-rsc-entry.js` does not suppress these
errors, causing the RSC stream to fail.

**Note:** The `rscOnError` patch in vinext is necessary but insufficient —
it only controls the error digest sent to the client, not whether the
error aborts rendering. Our transform-based approach in `payloadRscStubs`
replaces the throws entirely, preventing the errors from occurring.

**Our workaround:** `node_modules` patch on vinext's `app-rsc-entry.js`
(see norfolk project's `patches/vinext.patch`) PLUS the transform-based
suppression in this plugin's `payloadRscStubs`.

---

## vinext: navigation shim `getServerSnapshot` returns wrong values during hydration

**Status:** Not yet filed upstream.
**Responsibility:** vinext
**Repo:** https://github.com/cloudflare/vinext

**Bug:** vinext's `next/navigation` shim implements `usePathname`,
`useParams`, and `useSearchParams` via `useSyncExternalStore`. The
`getServerSnapshot` callback reads from a module-level server context
that is `null` on the client, so during hydration React gets fallback
values (`"/"` for pathname, `{}` for params, empty search params)
instead of the real URL values.

Next.js uses React context (`PathnameContext`, `SearchParamsContext`)
instead of `useSyncExternalStore`, so server and client snapshots
always agree during hydration.

**Impact:** Every component that renders differently based on the
current route produces hydration mismatches. For Payload, this means
`DefaultNavClient` (pathname-dependent element types) and
`DocumentTabLink` (params-dependent URLs).

**Our workaround:** `payloadNavigationHydrationFix` patches the shim
on disk in `configResolved` (before the optimizer runs), replacing
`getServerSnapshot` with the client snapshot function. The browser
entry calls `setClientParams()` before `hydrateRoot()`, so the client
store has correct values at hydration time.

---

## vinext: browser entry imports shims via relative paths

**Status:** Not yet filed upstream.
**Responsibility:** vinext
**Repo:** https://github.com/cloudflare/vinext

**Bug:** vinext's browser entry (`dist/server/app-browser-entry.js`)
imports the navigation shim via a relative path
(`from "../shims/navigation.js"`) instead of the aliased specifier
(`from "next/navigation"`). Vite serves the raw file alongside the
pre-bundled version, creating two separate module instances.

**Impact:**
1. **Duplicate React** — the raw shim imports React separately from the
   pre-bundled copy → "Invalid hook call" errors on first load.
2. **Optimizer reload** — Vite discovers the raw module as a new
   dependency → re-optimizes → full page reload → console clears.
3. **Split state** — `setClientParams()` (called from the browser
   entry's raw module) doesn't reach `getClientParamsSnapshot()` (read
   from the pre-bundled module) → `useParams()` returns `{}` during
   hydration.

Additionally, vinext defines aliases for both `next/link` and
`next/link.js` (with `.js` suffix), but only the bare specifiers get
included in `optimizeDeps` by consumers. The optimizer treats each
specifier independently, so the `.js` variants are discovered at
runtime.

**Our workaround:** `payloadServerActionFix` rewrites the browser
entry's relative import to `from "next/navigation"` (the aliased
specifier). `payloadOptimizeDeps` auto-discovers all `next/*` alias
specifiers from the resolved config in `configResolved` and adds them
to `optimizeDeps.include`.

---

## vinext: `render()` called before `returnValue` check in server action handler

**Status:** Not yet filed upstream.
**Responsibility:** vinext
**Repo:** https://github.com/cloudflare/vinext

**Bug:** In the browser entry's server action callback, vinext calls
`getReactRoot().render(result.root)` before checking
`result.returnValue`. This means every server action — including
data-returning ones like Payload's `getFormState` — triggers a full
re-render of the React tree.

For Payload, this causes: `render()` → Form receives new
`initialState` ref → `useEffect` fires → `REPLACE_STATE` resets
form → `onChange` fires another server action → form state lost.
The user sees array field rows flash and disappear.

**Our workaround:** `payloadServerActionFix` uses ast-grep to find
the render call followed by the `result.returnValue` if-statement
and moves the render after the if-block. Data-returning actions
return their value without re-rendering; void mutations still render.

---

## Payload: components render different element types based on pathname/params

**Status:** By design in Payload (optimized for Next.js).
**Responsibility:** Payload CMS
**Repo:** https://github.com/payloadcms/payload

**Bug:** Several Payload admin components conditionally render different
HTML element types based on `usePathname()` or `useParams()`:

- `DefaultNavClient` renders `<Link>` or `<div>` based on
  `pathname === href`
- `DocumentTabLink` renders `el: "link"` or `el: "div"` based on
  `isActive` (derived from params)

In Next.js, these hooks return consistent values during SSR and
hydration (via React context). In vinext, the values diverge →
React 19 detects an element-type mismatch → discards the entire
server-rendered subtree → form state lost.

**Our workaround:** `payloadNavHydrationFix` uses ast-grep transforms
to force consistent rendering: `pathname === href` → `false` (always
render `<Link>`), `$_ ? "link" : "div"` → `"link"`, etc. All transforms
are AST-based for resilience across Payload versions. The visual
difference is negligible (active nav items don't get a special indicator).
