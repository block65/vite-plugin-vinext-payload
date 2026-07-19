# Image for running the e2e suites in isolation — see e2e-container.sh.
# Version args are required, passed from the repo's own pins so the image
# never drifts from what the host would run.
FROM node:24-bookworm

ARG PNPM_VERSION
ARG PLAYWRIGHT_VERSION

RUN npm install -g "pnpm@${PNPM_VERSION}"

# Bake the browser and its system libraries into the image, outside any home
# directory so the unprivileged user resolves the same path at run time.
ENV PLAYWRIGHT_BROWSERS_PATH=/browsers
RUN npx -y "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium \
	&& chown -R node:node /browsers

# Pre-create the volume mount points owned by the unprivileged user, so the
# named volumes docker seeds from the image are writable by it.
RUN install -d -o node -g node /work /pnpm-store /npm-cache

# In this image, getaddrinfo("localhost") orders ::1 first while undici's
# fetch connects to 127.0.0.1 — so a dev server told to listen on
# "localhost" binds an address its own test harness never dials. Pinning
# the result order makes every node process resolve localhost the same way.
ENV NODE_OPTIONS=--dns-result-order=ipv4first

USER node
WORKDIR /work
