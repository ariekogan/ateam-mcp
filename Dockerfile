FROM node:22-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/
COPY .env.example ./

ENV ATEAM_BASE_URL=https://mcp.ateam-ai.com

# STUB MODE: Minimal MCP server matching official example pattern.
# Switch back to ["node", "src/index.js"] after testing.
ENTRYPOINT ["node", "src/stub.js"]
