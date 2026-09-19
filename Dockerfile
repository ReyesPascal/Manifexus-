# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first for efficient caching
COPY package.json ./
RUN npm install

# Copy application source code
COPY . .

# Build Vite client and bundle server into dist/server.cjs
RUN npm run build

# Production runtime stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3334
ENV DOCKER_SOCKET_PATH=/var/run/docker.sock

# Create persistent storage directory
RUN mkdir -p /data && chown -R node:node /data

# Copy production artifacts from builder
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Expose Manifexus central command port
EXPOSE 3334

# Declare persistent volume for settings, groups & overrides
VOLUME ["/data"]

# Run as non-root node user (ensure docker group permissions or socket mapping)
CMD ["node", "dist/server.cjs"]
