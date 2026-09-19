# Manifexus — Container Fleet Command Nexus

> **"The central nexus for your container fleet."**

Manifexus is a lightweight, self-hosted central command hub that automatically tracks and displays running Docker containers, applications, web ports, and Docker Compose stacks on an Ubuntu server via the local Docker daemon.

---

## 🌟 Key Architecture & Capabilities

### 1. Automatic Discovery Engine
* **Direct Socket Integration:** Connects to `/var/run/docker.sock:ro` using Node.js native Unix domain socket HTTP calls. No external Docker CLI binaries or heavy agents required.
* **Instant Reactivity:** When a container starts, stops, or restarts on your host system, Manifexus picks up the state changes immediately.
* **Automated Port Extraction:** Parses both published (`HostPort -> ContainerPort`) and container-exposed ports (`tcp` and `udp`).
* **Intelligent Icon Resolver:** Automatically matches running containers and image names (e.g., Plex, Pi-hole, Portainer, Nextcloud, Uptime Kuma, Home Assistant, Jellyfin) to official icons via dashboard catalogs with graceful letter-badge fallbacks.

### 2. Deep Container Inspection & Metadata
* **Docker Compose Awareness:** Automatically inspects container labels:
  * `com.docker.compose.project`: identifies project/stack membership
  * `com.docker.compose.project.working_dir`: the exact host working directory where `docker-compose.yml` resides
  * `com.docker.compose.project.config_files`: exact path of the Compose config file on the host
  * `com.docker.compose.service`: individual service name within the stack
* **Standard `docker run` Inspection:** Extracts base image, storage mounts (host path -> container path, RW/RO permissions), environment variables (with sensitive credentials masked), restart policies, and internal IP addresses.

### 3. Visual Stacks & Custom Category Grouping
* **View Mode Switcher:**
  * **Compose Stacks View:** Automatically groups containers by their `com.docker.compose.project`, displaying the stack working directory and service count. Standalone containers (`docker run`) are grouped in their own section.
  * **Custom User Groups View:** Organize containers into user-defined categories (e.g., *Media & Streaming*, *Networking & DNS*, *Databases & Storage*, *Home Automation*, *Monitoring & Ops*).
* **Data Persistence:** User configurations, custom groups, custom friendly names, icon overrides, and port customizations are stored in `/data/config.json` (mapped to `./data` on the host), surviving container restarts and image updates.

---

## 🚀 Quick Start (Single-Line Installation)

### Using Docker Compose (`docker-compose.yml`)

Create a directory on your Ubuntu server:
```bash
mkdir -p ~/manifexus && cd ~/manifexus
```

Create `docker-compose.yml`:
```yaml
services:
  manifexus:
    image: ghcr.io/reyespascal/manifexus:latest
    container_name: manifexus
    restart: unless-stopped
    ports:
      - "3334:3334"
    environment:
      - NODE_ENV=production
      - PORT=3334
      - DOCKER_SOCKET_PATH=/var/run/docker.sock
    volumes:
      # Read-only Docker daemon socket for automatic container discovery
      - /var/run/docker.sock:/var/run/docker.sock:ro
      # Persistent host directory for custom groups and app overrides
      - ./data:/data
```

Launch the container:
```bash
docker compose up -d
```

Open your browser at `http://<your-server-ip>:3334`.

---

### Using `docker run`

```bash
docker run -d \
  --name manifexus \
  --restart unless-stopped \
  -p 3334:3334 \
  -e PORT=3334 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v $(pwd)/data:/data \
  ghcr.io/reyespascal/manifexus:latest
```

---

## 📤 Push to GitHub (`ReyesPascal/Manifexus-`)

To push this project to your GitHub repository:

```bash
git init
git add .
git commit -m "Initial release of Manifexus fleet command hub"
git branch -M main
git remote add origin https://github.com/ReyesPascal/Manifexus-.git
git push -u origin main
```

When pushed, the included GitHub Actions workflow (`.github/workflows/docker-publish.yml`) will automatically build and publish the multi-arch container image to GitHub Container Registry (`ghcr.io/reyespascal/manifexus:latest`).

---

## 🔒 Security Best Practices

1. **Read-Only Socket (`:ro`):** Notice the `:ro` flag when mounting `/var/run/docker.sock:/var/run/docker.sock:ro`. This ensures Manifexus can inspect telemetry without any ability to modify the host socket file.
2. **Environment Variable Masking:** Manifexus automatically filters and masks sensitive environment variables containing passwords, secrets, or API keys (`••••••`).
3. **Internal Reverse Proxy:** If exposing Manifexus outside your local network, put it behind Nginx Proxy Manager, Caddy, or Traefik with TLS and Authelia/Cloudflare Access authentication.

---

## 📦 Project Structure

```
.
├── Dockerfile                           # Multi-stage production container build
├── docker-compose.yml                   # One-line deployment specification
├── .github/
│   └── workflows/
│       └── docker-publish.yml           # Automated multi-arch GHCR build & release
├── server.ts                            # Express backend + Vite middleware
├── server/
│   ├── dockerService.ts                 # Docker Engine socket query & telemetry parser
│   └── storageService.ts                # Atomic JSON persistent volume storage
├── src/
│   ├── App.tsx                          # Central Command Hub interface
│   ├── types.ts                         # Docker, Compose & Grouping schemas
│   ├── components/
│   │   ├── Navbar.tsx                   # Brand, view switch, search & command bar
│   │   ├── StatsBar.tsx                 # Real-time fleet metrics
│   │   ├── AppCard.tsx                  # Large application tile with port links
│   │   ├── InspectModal.tsx             # Deep container inspection & metadata
│   │   ├── HelpDrawer.tsx               # Interactive deployment guide drawer
│   │   ├── GroupManagerModal.tsx        # Custom category manager
│   │   ├── SettingsModal.tsx            # Host IP & telemetry polling config
│   │   └── SimulateContainerModal.tsx   # Instant container spawner for testing
│   └── index.css                        # Tailwind CSS + Cyber theme utilities
└── metadata.json                        # Applet configuration
```
