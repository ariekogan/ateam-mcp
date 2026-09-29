FROM node:22-alpine

WORKDIR /app

# Install from npm (auto-published by GitHub Actions CI).
# ATEAM_MCP_VERSION pins the version. ai-dev-assistant's docker-compose.yml
# passes it from the host .env (prod sets it via scripts/prod/08). Unset →
# latest, as before. Having the ARG here means prod no longer has to sed-patch
# this file at deploy time to get a pinned build.
ARG ATEAM_MCP_VERSION=latest
RUN npm init -y && npm install @ateam-ai/mcp@${ATEAM_MCP_VERSION}

ENV ATEAM_BASE_URL=https://mcp.ateam-ai.com

ENTRYPOINT ["node", "node_modules/@ateam-ai/mcp/src/index.js", "--http"]
