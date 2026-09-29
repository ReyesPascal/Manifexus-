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
    libgomp1 \
    zstd \
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

# Built-in AI engine (Ollama), CPU-only: graphics-card libraries are gigabytes, so they're skipped.
# Downloaded from Ollama's GitHub release. If that fails for any reason, the build still succeeds
# without the engine: Manifexus then says "Update Manifexus to use the built-in AI" and nothing
# else is affected. Models are downloaded later, on request, into /data/ai.
ARG TARGETARCH
ARG OLLAMA_VERSION=0.34.4
RUN set -u; \
    base="https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}"; \
    if curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 -o /tmp/ollama.tar.zst "$base/ollama-linux-${TARGETARCH}.tar.zst" \
       && curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 -o /tmp/ollama.sha256 "$base/sha256sum.txt" \
       && (cd /tmp && grep "ollama-linux-${TARGETARCH}.tar.zst\$" ollama.sha256 | sed 's#\./##' | sed "s#ollama-linux-${TARGETARCH}.tar.zst#ollama.tar.zst#" | sha256sum -c -) \
       && mkdir -p /tmp/ollama \
       && tar --use-compress-program=unzstd -xf /tmp/ollama.tar.zst -C /tmp/ollama --wildcards \
            --exclude='lib/ollama/cuda_*' --exclude='lib/ollama/rocm*' --exclude='lib/ollama/vulkan*' --exclude='lib/ollama/mlx*' \
       && install -m 0755 /tmp/ollama/bin/ollama /usr/bin/ollama \
       && mkdir -p /usr/lib/ollama && cp -a /tmp/ollama/lib/ollama/. /usr/lib/ollama/ \
       && /usr/bin/ollama --help > /dev/null; then \
      echo "Built-in AI engine ${OLLAMA_VERSION} included ($(du -sh /usr/lib/ollama | cut -f1) of libraries)"; \
    else \
      echo "WARNING: built-in AI engine could not be included in this build; continuing without it"; \
      rm -rf /usr/bin/ollama /usr/lib/ollama; \
    fi; \
    rm -rf /tmp/ollama /tmp/ollama.tar.zst /tmp/ollama.sha256

# Copy production artifacts from builder
COPY --from=builder /app/package.json ./
# What's new in each version (shown in Updates; also tells Manifexus its own version)
COPY --from=builder /app/release-notes.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Expose Manifexus central command port
EXPOSE 3334

# Declare persistent volumes for settings, groups & overrides, and pre-merge backup snapshots
VOLUME ["/data", "/app/backups"]

CMD ["node", "dist/server.cjs"]
