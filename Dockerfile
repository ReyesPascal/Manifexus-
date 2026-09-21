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

# Install docker-cli and docker compose plugin so Manifexus can orchestrate host stacks
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3334
ENV MANIFEXUS_DOCKER=true
ENV DOCKER_SOCKET_PATH=/var/run/docker.sock
ENV HOST_ROOT=/host

# Create persistent storage directories
RUN mkdir -p /data /app/backups

# Copy production artifacts from builder
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Expose Manifexus central command port
EXPOSE 3334

# Declare persistent volumes for settings, groups & overrides, and pre-merge backup snapshots
VOLUME ["/data", "/app/backups"]

CMD ["node", "dist/server.cjs"]
