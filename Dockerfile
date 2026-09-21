# Build stage runs natively on the builder host (zero QEMU emulation overhead for npm/vite)
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder

WORKDIR /app

# Install dependencies first for efficient caching
COPY package*.json ./
RUN npm install --legacy-peer-deps

# Copy application source code
COPY . .

# Build Vite client and bundle server into dist/server.cjs
RUN npm run build

# Production runtime stage (glibc Node 22 ensures total compatibility across amd64 and arm64)
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3334
ENV MANIFEXUS_DOCKER=true
ENV DOCKER_SOCKET_PATH=/var/run/docker.sock

# Create persistent storage directory
RUN mkdir -p /data

# Copy production artifacts from builder
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Expose Manifexus central command port
EXPOSE 3334

# Declare persistent volume for settings, groups & overrides
VOLUME ["/data"]

CMD ["node", "dist/server.cjs"]
