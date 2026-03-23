/**
 * Curated package lists for Payload CMS on Vite/vinext.
 *
 * These exist because Vite handles module resolution differently from
 * webpack. Next.js maintains a similar curated list of ~90 packages:
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/server-external-packages.jsonc
 *
 * Each entry documents what breaks, why, and when it can be removed.
 */

// ---------------------------------------------------------------------------
// SSR EXTERNALS
//
// Packages excluded from server-side bundling via ssr.external.
// In webpack, everything is bundled by default. In Vite, nothing is — so
// packages that genuinely can't be bundled (native addons, build tools)
// must be explicitly externalized.
//
// NOTE: ssr.external applies to ALL server environments including RSC.
// In workerd, externalized packages can't be resolved at runtime — only
// packages that are truly never imported at runtime belong here.
// ---------------------------------------------------------------------------

export const SSR_EXTERNAL = [
	// Build tools — never imported at runtime, only during build/deploy.
	"esbuild", // Bundler binary. Remove: never (build tool).
	"wrangler", // Cloudflare CLI. Remove: never (deploy tool).
	"miniflare", // Cloudflare local emulator. Remove: never (dev tool).

	// Native addon — C++ bindings that can't be bundled.
	// Also in Next.js's server-external-packages.jsonc.
	"sharp", // Remove: never (native addon architecture).
];

// ---------------------------------------------------------------------------
// OPTIMIZE DEPS EXCLUDE (all environments)
//
// Packages excluded from Vite's pre-bundling (optimizeDeps) in all
// environments. These break during esbuild/Rolldown bundling for
// structural reasons that webpack handles natively.
// ---------------------------------------------------------------------------

export const OPTIMIZE_DEPS_EXCLUDE = [
	// Export condition mismatch: { "node": "./index.js", "default": "./core.js" }.
	// RSC resolves to core.js which lacks fileTypeFromFile.
	// Webpack resolves to index.js (Node condition) and works.
	// Remove: when Vite respects per-environment export conditions.
	"file-type",

	// References ./node.js expecting directory resolution (→ ./node/index.js).
	// esbuild/Rolldown treats it as a file path → resolution fails.
	// Webpack resolves ./node.js as a directory correctly.
	// Remove: when Rolldown supports Node.js directory resolution fallback.
	"blake3-wasm",

	// No root "." export — only subpath exports (./layouts, ./routes).
	// Vite's dedup wrapper generates `export * from "@payloadcms/next"` which
	// fails because there's no root export to re-export.
	// Webpack doesn't generate dedup wrappers.
	// Remove: when Vite handles packages without root exports gracefully.
	"@payloadcms/next",
];

// ---------------------------------------------------------------------------
// CLIENT OPTIMIZE DEPS EXCLUDE
//
// Packages excluded from client-side optimizeDeps only.
// Currently empty — RSC 'use client' barrel detection is handled
// automatically by payloadUseClientBarrel.
// ---------------------------------------------------------------------------

export const CLIENT_OPTIMIZE_DEPS_EXCLUDE: string[] = [];

// ---------------------------------------------------------------------------
// CLIENT OPTIMIZE DEPS INCLUDE
//
// CJS transitive deps force-included in client optimizeDeps.
// When a parent package is excluded from optimizeDeps, Vite can't
// auto-discover its CJS dependencies. These must be explicitly included
// so the browser gets pre-bundled ESM instead of raw CJS via /@fs/.
//
// Webpack bundles CJS natively — no explicit includes needed.
// ---------------------------------------------------------------------------

export const CLIENT_OPTIMIZE_DEPS_INCLUDE = [
	// CJS with require() calls, used by payload/fields/validations.
	// Remove: when payload ships ESM or Vite auto-discovers excluded deps.
	"payload > ajv",

	// CJS module.exports, used by payload/utilities/isValidID.
	// Remove: when payload ships ESM or Vite auto-discovers excluded deps.
	"payload > bson-objectid",

	// CJS stub with require(), used by @payloadcms/ui components compiled
	// with React Compiler. Without pre-bundling, the browser gets the raw
	// CJS file via /@fs/ and can't import named exports.
	// Remove: when React ships ESM for compiler-runtime.
	"react/compiler-runtime",

	// vinext shims next/* via resolve.alias. Additional next/* aliases
	// are auto-discovered and included by payloadOptimizeDeps from the
	// resolved alias config — no need to hardcode them here.
	// Remove: when vinext adds these to its own optimizeDeps.include.
	"@payloadcms/ui",
];

// ---------------------------------------------------------------------------
// RSC STUBS
//
// Packages stubbed in the RSC environment because they use Node.js APIs
// unavailable in workerd, or can't be resolved due to pnpm strict isolation.
// These are transitively imported but never invoked during RSC rendering.
//
// Next.js doesn't need stubs — it runs in Node.js where all APIs exist.
// These are workerd-specific workarounds.
// ---------------------------------------------------------------------------

export const RSC_STUBS: Record<string, "empty"> = {
	// Uses Node.js fs/streams. Transitively imported by @payloadcms/db-d1-sqlite
	// but file-type detection is never called during RSC rendering.
	// Also in OPTIMIZE_DEPS_EXCLUDE for the export condition mismatch.
	// Remove: when workerd supports Node.js fs APIs, or payload drops the dep.
	"file-type": "empty",

	// Migration utilities from drizzle-kit. Imported by @payloadcms/db-d1-sqlite
	// via dynamic require() but migrations only run during build/deploy, not
	// during RSC rendering. pnpm strict isolation also prevents resolution.
	// Remove: when payload lazy-loads migration deps, or workerd supports require().
	"drizzle-kit/api": "empty",
};
