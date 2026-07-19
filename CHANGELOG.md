# Changelog

Consumer-visible changes to `vite-plugin-vinext-payload`. Entries are added
in the same commit as the change they describe; a release moves the
Unreleased section under a version heading, and the GitHub release notes are
that section verbatim.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). On 0.x,
breaking changes bump the minor version.

## [Unreleased]

## [0.3.0] - 2026-07-19

### Added

- **Default export and conventional plugin names.** `import vinextPayload from "vite-plugin-vinext-payload"` now works, and the plugins are named for what they do: `vinextPayload()` (full admin UI + API under vinext) and `vinextPayloadWorker()` (headless Payload as a Cloudflare RPC worker). The old `payloadPlugin` / `payloadWorkerPlugin` names keep working as deprecated aliases, and `init` writes the new import into scaffolded configs.
- **Every build-time patch is now disclosed.** This plugin works by rewriting vinext and Payload internals at build time. The README now carries a [generated table](README.md#build-time-patches) of every rewrite — what it touches, why it exists, and the upstream condition under which it will be removed. The same data is exported as `PATCH_MANIFEST` if you want to inspect it programmatically.

### Improved

- **Dev-server cold starts settle in seconds, not minutes.** The first request after a cold start used to discover Payload's server dependencies one at a time, each discovery forcing an "optimized dependencies changed, reloading" cycle — up to eighteen reloads before the admin panel answered (114s measured on a cold cache). Those dependencies are now pre-declared, so the first admin load completes after the initial optimization pass (~15s on the same setup).

## [0.2.0] - 2026-07-18

### Breaking

- **`payloadNextNavigationFix` removed.** It was a no-op — the behaviour it patched no longer exists upstream. Remove it from your plugin list; there is no replacement.
- **`vinext` peer dependency now pinned to `1.0.0-beta.2`** (was `0.0.x`). vinext's config shape changed in 1.0, so older versions are incompatible.

### Fixed

- `init` now generates a valid config for the vinext 1.0 shape. Previously it emitted the pre-1.0 layout, which failed to boot.

### Added

- Drift detectors that fail loudly when vinext's internals move out from under the patch targets, instead of silently producing a broken build.

[Unreleased]: https://github.com/block65/vite-plugin-vinext-payload/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/block65/vite-plugin-vinext-payload/releases/tag/v0.3.0
[0.2.0]: https://github.com/block65/vite-plugin-vinext-payload/releases/tag/v0.2.0
