FROM node:22-alpine

WORKDIR /app

# Install from npm (auto-published by GitHub Actions CI)
RUN npm init -y && npm install @ateam-ai/mcp@latest

ENV ATEAM_BASE_URL=https://mcp.ateam-ai.com

ENTRYPOINT ["node", "node_modules/@ateam-ai/mcp/src/index.js", "--http"]
