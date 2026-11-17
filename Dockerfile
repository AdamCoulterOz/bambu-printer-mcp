# Build and run on the same Debian/glibc family so native npm dependencies match.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY patches/ ./patches/
COPY scripts/install-patches.mjs ./scripts/install-patches.mjs
RUN npm ci
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
# The supported signing setup and repair commands compile a private counter helper.
RUN apt-get update && apt-get install -y --no-install-recommends openssl gcc libc6-dev ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/dist/ ./dist/
COPY --from=build /app/src/ ./src/
COPY package.json LICENSE CONTRIBUTORS.md ./
COPY scripts/install-patches.mjs scripts/signing-counter.c scripts/signing-setup.mjs scripts/artifact-store-lock.py ./scripts/
COPY patches/ ./patches/
ENV NODE_ENV=production HOME=/home/node XDG_CONFIG_HOME=/home/node/.config MCP_TRANSPORT=streamable-http MCP_HTTP_HOST=0.0.0.0
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
