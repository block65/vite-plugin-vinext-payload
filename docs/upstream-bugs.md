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

## React 19: RSC serializer throws for non-serializable values in dev mode

**Status:** By design in React. Next.js silently handles this.
**Responsibility:** vinext / React / Next.js compat gap
**Repo:** https://github.com/facebook/react

**Bug:** React 19's RSC serializer (`renderModelDestructive`) throws when
non-serializable values cross the server/client boundary: functions, event
handlers, RegExps, class instances. Next.js production mode silently drops
these (they become `undefined` on the client). vinext doesn't replicate
this behavior.

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

## @vitejs/plugin-rsc: client reference proxy throws on invocation

**Status:** By design in plugin-rsc.
**Responsibility:** @vitejs/plugin-rsc
**Repo:** https://github.com/nicolo-ribaudo/vite-plugin-rsc

**Bug:** When a `"use client"` export is called as a function on the server
(not rendered as a component), plugin-rsc's client reference proxy throws
`"Unexpectedly client reference export '...' is called on server"`. This
is correct for real bugs but breaks Payload CMS where `@payloadcms/storage-r2`
exports `useUploadHandlers` (a client hook) that gets invoked during server-side
initialization.

**Our workaround:** Transform hook in `payloadRscStubs` patches the throw
in `@vitejs/plugin-rsc/dist/core/rsc.js` to `return undefined;`. Only
applies to modules with `plugin-rsc` in the ID.

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
