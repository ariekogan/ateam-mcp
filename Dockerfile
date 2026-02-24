FROM node:22-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/
COPY .env.example ./

ENV ATEAM_BASE_URL=https://mcp.ateam-ai.com

ENTRYPOINT ["node", "src/index.js", "--http"]
