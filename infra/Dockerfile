FROM node:22-slim

# git and ca-certificates are here for the Claude CLI, which the Gateway spawns.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10 @anthropic-ai/claude-code

WORKDIR /app

# Manifests first so a source-only change does not re-resolve the dependency
# graph on every build.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json tsconfig.json ./
COPY shared/package.json shared/
COPY core/package.json core/
COPY mcp/package.json mcp/
COPY gateway/package.json gateway/
COPY eval/package.json eval/
RUN pnpm install --frozen-lockfile || pnpm install

COPY . .
RUN pnpm build

ENV NODE_ENV=production
CMD ["node", "core/dist/server-cli.js"]
