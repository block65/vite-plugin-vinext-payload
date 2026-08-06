# Changelog

Consumer-visible changes since the last release. Released versions live in
[GitHub releases](https://github.com/block65/vite-plugin-vinext-payload/releases).

## Unreleased

- **Breaking:** the `vinext` peer dependency now requires exactly
  `1.0.0-beta.4`, up from `1.0.0-beta.2`. Upgrade vinext alongside this
  plugin — the pin is exact because every vinext pre-release moves internals
  the plugin patches.
