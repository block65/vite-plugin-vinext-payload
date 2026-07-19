#!/usr/bin/env bash
# In-container half of e2e-container.sh: copy the read-only repo mount to a
# writable workdir, install, hand the remaining arguments to vitest.
set -euo pipefail

tar -C /repo \
	--exclude=./.git \
	--exclude=./node_modules \
	--exclude=./dist \
	--exclude='./test/.test-*' \
	--exclude=./test/.mock-project \
	-cf - . | tar -C /work -xf -

cd /work
pnpm install --frozen-lockfile --store-dir /pnpm-store

exec pnpm exec vitest run "$@"
