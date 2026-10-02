# Plan: stage 3, cloud backups and restoring a whole server

Status: planned, not started. Stages 1 and 2 (faster backups, the backup store, automatic backups) are built; see
[../backups.md](../backups.md).

## Goal

1. **A copy off the server:** every backup also kept somewhere else (cloud storage, a NAS, Google Drive), so a dead
   disk, a fire or ransomware doesn't take the backups with it.
2. **Rebuild after a crash:** install Linux, Docker and Manifexus on a fresh machine, pick **Restore from a backup**,
   and get every stack back: folders, volumes, databases, settings, app versions, and Manifexus's own settings.

## What stages 1 and 2 already give us

- One standard restic repository holding everything (`/app/backups/store`), deduplicated and encrypted.
- Its key in a separate file (`/app/backups/.store-key`), so copying the store never copies the key.
- Automatic backups of every stack, every night: the cloud copy can follow right after.
- Each item at a fixed path (`/backup/folders/...`, `/backup/volumes/...`, `/backup/databases/...`) with tags
  (`auto`, `stack:<name>`): a restore can find each stack's latest backup.

## Where backups can go

All through restic, which Manifexus already bundles. rclone is added to the image for the consumer drives.

| Destination | How | Good for | Cost |
|---|---|---|---|
| S3-compatible (Backblaze B2, Cloudflare R2, Wasabi, AWS) | restic's own S3 support | Off-site copy, reliable, fast | About $6/TB a month (B2); R2 has no download fees |
| Another computer (NAS, second server) | SFTP, restic's own support | Fast restores at home, free | Storage you own |
| Google Drive, Dropbox, OneDrive | rclone | Space you already pay for | Free up to 15 GB (Drive) |

Recommended: a NAS for fast restores, plus B2 or R2 for disasters.

## How the copy works

- After the nightly automatic backups, `restic copy` sends the new snapshots from the store to each destination.
  Only new data is uploaded.
- Same encryption key for both, set up with `restic init --copy-chunker-params --from-repo` so deduplication carries
  over and the cloud copy can be restored directly.
- Each destination has its own keep rule (for example 7 daily, 4 weekly, 6 monthly) and its own `forget --prune`.
- Once a month, `restic check --read-data-subset=5%` downloads a sample to prove the copy can really be restored.
- Optional **object lock** (S3, B2): backups can't be deleted or changed for N days, even with the keys. This
  protects against ransomware.

## The recovery key

Without it, the backups can't be read: that's what makes them private. It has to be impossible to lose by accident.

- Shown when the first destination is added: "Save your recovery key", with Download and Print. Continue only after
  saving.
- Settings → Backups shows when it was last saved, and can show it again (after confirming).
- It's the restic password, written as words (for example 12 words from a word list) so it can be typed by hand.
- Manifexus keeps it on the server too, but never uploads it.

## Connecting a destination (screens)

All in the Backups screen, a new section **Off-Site Copy**, built like the other sheets (inset groups, Liquid Glass
footer, Inter, Apple's type scale).

1. **Choose where:** Cloud Storage, Another Computer, Google Drive / Dropbox / OneDrive.
2. **Sign in:**
   - S3: provider, bucket, Key ID, Secret Key, with a short guide for each provider ("On Backblaze: App Keys → Add a
     New Application Key → choose your bucket").
   - SFTP: address, user, folder. Manifexus makes an SSH key and shows one line to paste on the other machine (or
     installs it with the password once), shows the server's fingerprint to confirm, then tests writing.
   - Google Drive and others: a sign-in window from the browser (OAuth through Manifexus, since the server has no
     browser), asking only for its own folder (`drive.file`).
3. **Test:** write and read a small file, show free space. "Connected to Backblaze B2 · ryan-backups".
4. **Recovery key** (the first time).
5. **Schedule:** after the nightly backup (default), or weekly; what to copy (everything, or only automatic backups).

Status in the Backups screen: "Copied to B2 · last night at 3:20 AM · 42 GB · about $0.25 a month". Problems in
plain words ("This key can't write to that bucket", "Reconnect Google Drive"), also in Diagnostics.

## Restoring a whole server

### On a fresh install

Getting Started's first step asks: **Set up a new server** or **Restore from a backup**.

1. Pick where the backup is and sign in again (the old server's keys and tokens are gone; the backups aren't).
2. Enter the recovery key.
3. Pick a restore point ("Last night, 3:00 AM"). Manifexus reads the server manifest (next section) and shows the
   stacks and apps in it, with sizes.
4. Choose all, or some stacks. Choose where stacks go (same folders by default).
5. A progress screen follows along, stack by stack:
   1. Put back Manifexus's own settings (stack names, icons, Restore history).
   2. For each stack, databases first: restore folders and volumes (owners and permissions kept); recreate volumes
      with their Compose labels; pull the same image versions (by digest); `docker compose up`; then load the
      database dump if the database came up empty; then start the apps that use it.
   3. Check every app is running; Diagnostics runs at the end.
6. A clear summary: what came back, what's left out (media libraries, which need their own copy), anything that
   couldn't be restored and why.

### One stack, any time

In the Backups screen, a stack's detail gets **Restore This Stack**, choosing a restore point (any of the kept
automatic backups) and either "in place" (backed up first, like every change) or "to another folder".

## The server manifest

A small file saved with every nightly backup (and copied to each destination), so a fresh server knows what to
rebuild:

- Each stack: name, folder, compose file name, apps, the image and exact digest each app runs, ports, volumes (name,
  driver, labels), which folders and volumes are in which snapshot, which folders were left out and why.
- Folder owners (user and group ids) and the users they belong to.
- Manifexus's own settings (`config.json`, icons, stack names, the Restore history).
- Docker networks the stacks use that Compose doesn't create.

## Things to get right

- **Images that are gone:** if an exact image version can't be downloaded any more, offer the closest version and
  say so.
- **Ports in use** on the new machine: warn before starting, offer another port (the port clash check already exists).
- **Different stacks folder** (new user name): let people choose; rewrite paths in compose files and the manifest
  with a preview.
- **Big first upload:** show the size and time estimate before starting; uploads keep going after restarts.
- **Bandwidth:** optional upload limit (`restic --limit-upload`), so backups don't fill the connection.
- **Costs:** estimate from the provider's price and the size.
- **Never silent:** every failed copy is in Activity and Diagnostics, and after 3 missed nights the header's Backups
  dot turns orange.

## Order of work

1. Off-site copy to S3-compatible storage and SFTP: connect, test, recovery key, nightly copy, status, keep rule,
   monthly check.
2. The server manifest, saved with every nightly backup.
3. Restore one stack from an automatic backup (in place or to another folder).
4. Restore from a backup in Getting Started (whole server).
5. Google Drive, Dropbox, OneDrive through rclone.
6. Object lock (ransomware protection) and upload limits.

## Open questions

- Should the recovery key be the same for the local store and every destination (simplest), or one per destination?
- Copy only automatic backups off-site, or change backups too? (Change backups are for undoing; automatic ones are
  for disasters. Copying only automatic ones keeps cloud costs down.)
- Should Manifexus's own data (settings, Restore history) also be in automatic backups locally, not just in the
  cloud copy?
