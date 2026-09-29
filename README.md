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

### 4. Activity: a complete record for troubleshooting
* **Everything you do is an activity:** moves, deletes, restores, updates, new stacks, app start/stop/restart and settings changes are each recorded from start to finish, with every step, Docker API call, host command (with its full output and exit code), file written (with its contents) and the request that started it.
* **See exactly why something failed:** a failed activity shows Docker's own error text and the command that produced it, plus what your containers were doing around that time (crashes, out-of-memory kills, restarts, health changes).
* **Copy Report:** one tap copies a Markdown troubleshooting report to paste into any AI assistant or support request; *Download → Everything (.json)* saves the full record including the environment (Manifexus build, Docker version, mounts, permissions).
* **All Events** (bottom of Activity): search, filter by level, time and kind, follow live, and export as JSON Lines or CSV.
* **Stored on disk** in `/data/logs` (daily JSON Lines files). Retention (7 days to 1 year), a storage limit and background detail are set in Activity Settings. Passwords, tokens and keys are replaced with `••••••` before anything is saved.

### 5. Restore: go back to before any change
* **Every change keeps a backup:** moving apps and deleting a stack save the compose files (and, unless you turn it off, the stack folders and volumes) first.
* **Restore to before a change** from the Restore screen. Manifexus first checks whether anything was edited since and shows exactly what will happen to each stack. If newer changes touched the same stacks, they're covered too: each stack is put back once, as it was before the oldest of them, instead of undoing changes one by one.
* **Restores can be undone:** every restore saves how the stacks looked just before it, and shows up in Restore like any other change.
* **Standalone apps** (started with `docker run`) that were moved into a stack are recreated exactly as they were — same settings, volumes, ports and restart policy — when the move is restored.
* **Recover without restoring everything:** put a deleted stack's files back without starting it, copy a backup into another folder, browse a backup and download single files, or download the whole backup as a `.tar.gz`.
* **Backups are kept for 30 days** by default (7 days to forever in Restore Settings, the gear in Restore). Pin a backup to keep it forever. Expired backups move their change to the Archive. Restore Settings also has **Delete Changes…** to choose several at once, and one-tap clean up of restored changes and deleted empty stacks.

### 6. Diagnostics and app details
* **Health in plain words:** Diagnostics (in the header) checks Docker, automation, stack folders, backup space, recent problems and updates, with anything that needs you listed first. Every app has the same view from its card's **Details** button.
* **See why an app stopped:** a crashed app shows what its exit code means and the last thing it wrote to its logs.
* **Right now:** memory, CPU, processes and network for the app or Manifexus itself.
* **App Output:** what the app itself has printed. Search, choose how much to show, copy or download. Errors are red and warnings orange. (For Manifexus itself, Diagnostics links to Activity instead.)
* **Copy Report** copies a full troubleshooting report to paste into any AI assistant; **Download** saves it as a Markdown file.
* **Fix it in place:** a check that points somewhere (Restore, Settings, Updates, Activity) opens that screen on top of Diagnostics, with a Back button to return.

### 7. Settings
* **Changes save as you make them,** like the iPhone's Settings app: choices save on tap, text fields when you press Enter or leave the field. A checkmark confirms each save.

### 8. Ask Manifexus: a built-in AI that stays on your server
* **Private and free:** the AI engine (Ollama) is built into Manifexus. Models are downloaded once, on request, into `/data/ai`; nothing leaves your network and there are no keys or costs.
* **Guided setup:** the first time you open Ask (or Fix with AI), a short setup picks the models, what it may do, what it may look at and how hard it thinks. The models download as one pipeline while you choose: one after another, smallest first, each checked, loaded into memory and tested (which also measures its speed on your server) while the next downloads.
* **Choose what it sees:** app logs, files on the server, Activity and Restore, and server details can each be turned off in setup or AI Settings. Apps, stacks and Diagnostics are always available; passwords, tokens and keys are always hidden.
* **Picked for your server:** Manifexus reads your processor, memory, graphics card and disk space and recommends a quick helper (explanations, summaries) and a fixer (finding causes, planning fixes) that fit without squeezing your apps. Only one runs at a time, and it frees its memory a few minutes after you're done.
* **Sees everything Manifexus sees:** apps, stacks, compose and `.env` files, logs, Activity, Restore, Diagnostics and the server itself. Passwords and tokens are always hidden from it.
* **Fixes with your OK:** proposed changes show a before/after of every file. Making them takes a backup first, uses the same progress tracker as moves, is saved in Restore (Undo This Fix) and recorded in Activity.
* **Choose what it may do:** Look Only, Ask Before Changes (default), Fix Routine Things (starts and restarts on its own), or Expert (may also propose commands, each shown first).
* **Fix with AI** from Diagnostics' To Fix list opens its own screen: the problem, the AI working on it step by step, the proposed change as a before/after (Make Changes, Do It Myself or Not Now), then the checks run again to confirm it's fixed.
* **Knows Manifexus:** for things Manifexus has a screen for (Move, New Stack, Restore, Diagnostics…) it offers a button that opens that screen ready to go, and asks a short question when it needs a detail.
* **Chats:** every time Ask opens it's a new chat; earlier ones are under Previous Chats (kept in your browser). The message box only shows when it's your turn.
* **Chooses automatically:** each request is sorted (question, fix or change) and gets the model and amount of thinking it needs. The obvious things are looked up before the AI starts, small file changes are one-line edits, and the fixer takes over if the quick helper gets stuck (only when there's memory free). Turn it off in AI Settings to always use the fixer.
* **See it work:** every lookup, AI round (what it read and wrote, with a progress bar and time left from its measured speed on your server) and check is listed with how long it took. Answers appear all at once, formatted, when they're complete.

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

### Releasing a new version

1. Add the version to the top of `release-notes.json`: a one-sentence headline and short, plain **New / Improved / Fixed** lines. This is what people read in Manifexus → Updates, so write it for them, not for developers.
2. Commit, then tag the commit with the same number: `git tag v1.2.0 && git push origin main --tags`.

Every tag is published as its own image (`ghcr.io/reyespascal/manifexus:1.2.0`), so any past version stays available.

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
│   │   ├── AppDetailsSheet.tsx          # App details and Diagnostics
│   │   ├── GroupManagerModal.tsx        # Custom category manager
│   │   ├── SettingsModal.tsx            # Host IP & telemetry polling config
│   │   └── SimulateContainerModal.tsx   # Instant container spawner for testing
│   └── index.css                        # Tailwind CSS + Cyber theme utilities
└── metadata.json                        # Applet configuration
```
