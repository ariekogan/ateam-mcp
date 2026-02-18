FROM node:22-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/
COPY .env.example ./

# Default: stdio transport (for Claude, Cursor, Windsurf, VS Code)
# Override with: --http [port] for HTTP transport (for ChatGPT, remote clients)
ENTRYPOINT ["node", "src/index.js"]
