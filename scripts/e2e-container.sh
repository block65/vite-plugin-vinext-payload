#!/usr/bin/env bash
# Run an e2e suite inside a container. The suites fetch templates with degit
# and run npm installs — postinstall scripts included — so by default none of
# that executes on the host: the checkout is mounted read-only and all work
# happens on a copy inside the container. Pass --host anywhere in the
# arguments to run directly on the host instead.
set -euo pipefail

args=()
host=0
for arg in "$@"; do
	if [[ $arg == --host ]]; then host=1; else args+=("$arg"); fi
done

repo=$(cd -- "$(dirname -- "$0")/.." && pwd)

if ((host)); then
	exec pnpm --dir "$repo" exec vitest run "${args[@]}"
fi

pnpm_version=$(node -p 'require(process.argv[1]).packageManager.split("@")[1]' "$repo/package.json")
playwright_version=$(node -p 'require(process.argv[1]).version' "$repo/node_modules/playwright/package.json")

docker build \
	--build-arg "PNPM_VERSION=$pnpm_version" \
	--build-arg "PLAYWRIGHT_VERSION=$playwright_version" \
	--file "$repo/scripts/e2e.Dockerfile" \
	--tag vinext-payload-e2e \
	"$repo/scripts"

# --shm-size: chromium crashes under docker's default 64MB /dev/shm.
exec docker run --rm --init \
	--shm-size=1g \
	--volume "$repo:/repo:ro" \
	--volume vinext-payload-e2e-pnpm-store:/pnpm-store \
	--volume vinext-payload-e2e-npm-cache:/npm-cache \
	--env npm_config_cache=/npm-cache \
	vinext-payload-e2e \
	/repo/scripts/e2e-container-entry.sh "${args[@]}"
