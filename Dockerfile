# multidb-mcp image on top of Debian 12.
#
# Why a container: IBM's Db2 CLI driver (used by ibm_db) needs libxml2.so.2,
# while newer distributions such as Ubuntu 26.04 only ship libxml2.so.16.
# Debian 12 still ships libxml2.so.2, so nothing has to be installed on the host.
#
#   npm run docker:build      -> runtime image  multidb-mcp:<version> and multidb-mcp:latest
#   npm run docker:build:dev  -> dev image      multidb-mcp-dev (Db2 tests & checks)

FROM node:24-bookworm AS deps
WORKDIR /app
# The ibm_db install script (allowed through allowScripts in package.json) downloads the Db2 CLI driver.
# IBM's mirror on GitHub is used because public.dhe.ibm.com is very slow (~20 KB/s);
# the version is pinned so the build is repeatable.
ENV IBM_DB_INSTALLER_URL=https://github.com/ibmdb/db2drivers/raw/main/clidriver/v12.1.4
COPY package.json package-lock.json ./
# The node:24-bookworm image already contains python3, make, and g++ for node-gyp (ibm_db).
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# To run the Db2 tests & checks inside the container. The source is mounted from the host.
FROM deps AS dev
ENV NODE_ENV=development

FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends libxml2 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
# stdout is reserved for the MCP protocol; run with: docker run -i --rm --init ...
ENTRYPOINT ["node", "/app/dist/index.js"]
