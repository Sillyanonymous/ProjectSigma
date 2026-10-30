# Project Σ in a container. Build and run it from the repository root with compose:
#   docker compose -f docker/compose.yaml up -d
# The libraries, settings and backups live in the /data volume, installed extensions in /extensions.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    CL_DATA_DIR=/data \
    CL_EXTENSIONS_DIR=/extensions \
    CL_HOST=0.0.0.0 \
    CL_PORT=7788

WORKDIR /app

# better-sqlite3 and sharp install from their prebuilt binaries for amd64 and arm64, so no compiler is needed
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY app ./app
COPY server ./server
COPY extensions/bundled ./extensions/bundled
COPY docs ./docs
COPY tools ./tools
COPY LICENSE NOTICE README.md ./

# a fresh named volume takes the ownership of the folder it mounts over
RUN mkdir -p /data /extensions && chown node:node /data /extensions
USER node
VOLUME ["/data", "/extensions"]
EXPOSE 7788

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.CL_PORT || 7788) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "server/index.js"]
