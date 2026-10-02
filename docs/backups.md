# Backups in Manifexus

How backups work as of version 3.3: what gets backed up, where it's kept, and how it was tested. The plan for
cloud backups and restoring a whole server after a fresh install is in
[plans/stage-3-cloud-backups.md](plans/stage-3-cloud-backups.md).

## Two kinds of backup

| | Change backups | Automatic backups |
|---|---|---|
| When | Before every move, delete and restore | When a stack first appears, then every night (3:00 AM by default) |
| What for | Undo that change from **Restore** | Bring a stack back after a crash; make moves fast |
| What's kept | Everything the change touches, every file | Everything the stack needs to come back, except video and music |
| Shown in | Restore | Backups (toolbar) |
| Kept for | The Restore "Keep backups for" setting, or forever if pinned | Every day of the last week, one a week for a month, always the newest |

Both go into the same **backup store**, so they share data: a move right after an automatic backup only saves what
changed since.

## The backup store

- A standard [restic](https://restic.net) repository at `/app/backups/store` (restic 0.19.1 is bundled in the image,
  checksum-verified at build time).
- **Deduplicated:** the same data is only kept once across all backups. A second backup of an unchanged app adds a
  few KB.
- **Compressed** (zstd) and **encrypted**. The key is `/app/backups/.store-key`, beside the store, never inside it,
  so copying the store somewhere (stage 3) never copies its key.
- **Readable without Manifexus:** `RESTIC_REPOSITORY=/app/backups/store RESTIC_PASSWORD_FILE=/app/backups/.store-key restic snapshots`.
- **One snapshot per folder, volume or database**, at a fixed path:
  - `/backup/folders/<host path>` for folders
  - `/backup/volumes/<volume name>` for Docker volumes
  - `/backup/databases/<container>/dump.sql` for database dumps

  restic finds the previous snapshot of the same path, so the next backup only reads files that changed.
- **Tags:** `manifexus` on everything, `backup:<snapshot folder>` for change backups, `auto` and `stack:<name>` for
  automatic backups, `pre` for a move's first pass, `converted` for older backups moved into the store.
- **Cleanup:** snapshots no Restore entry points to are removed (after an hour; first passes after 10 minutes), and
  automatic backups follow their keep rule. Space is reclaimed with `restic prune`. It runs 5 minutes after start,
  2 minutes after Restore entries are deleted, and every 6 hours.
- **Fallback:** if restic isn't available (Manifexus not running from its image), backups are `.tar.zst` archives
  (or `.tar.gz` when the helper has no zstd), one helper per backup. Restore reads all three kinds.

## What an automatic backup keeps

For each stack (Manifexus's own stack is skipped):

1. **The stack folder:** compose file, `.env` and everything in it, except app folders that are backed up on their
   own (next item).
2. **Each app's own folders and volumes:** the same rule moves use (`appOwnData`). A folder inside a stack folder
   that no other app uses, and every volume only this stack uses.
3. **Folders outside the stack that only this stack's apps use** (like `/opt/appdata/plex`), unless they're mostly
   media (over half the bytes are video or music) or bigger than 50 GB. Those are listed as "Left Out" with the
   reason.
4. **A dump of each running database:** Postgres (`pg_dumpall`), MySQL and MariaDB (`mariadb-dump` / `mysqldump
   --all-databases --single-transaction`), run inside the database's own container. The database's files are kept
   too; the dump is the copy that always restores cleanly.

Left out everywhere in automatic backups: video (`.mkv .mp4 .avi .mov .m4v .ts …`), music (`.mp3 .flac .m4a …`),
disk images (`.iso .img`) and unfinished downloads (`.!qB .part …`). Kept: settings, databases, `.torrent` files,
posters, playlists.

Change backups (move, delete, restore) keep **every** file, media included: deleting an app removes its data, so its
backup must hold all of it.

Automatic backups run one stack at a time with `nice -n 19 ionice -c 3` (lowest CPU and disk priority) and never
lock anything. A move while a backup runs is fine: both only read.

## How a move is backed up

1. **First pass while the apps still run:** backs up the app's own folders and volumes (tag `pre`).
2. Stop the apps.
3. **The real backup:** only what changed since the first pass, usually seconds.
4. Rewrite the compose files, start the apps.

Every step of every backup is recorded in Activity, with the commands and how long they took.

## Older backups

Backups made before 3.3 (`.tar.gz` / `.tar.zst` archives) move into the store on their own, in the background
(`server/backupUpgrade.ts`), one Restore entry at a time:

1. Unpack the archive into a temporary folder and back it up into the store, keeping its original date.
2. Restore that copy into a second folder and compare it with the first: contents (`diff -r`), plus every file's and
   folder's owner and permissions.
3. Only if every archive of the entry matches does the entry switch to the store. The old file is deleted 10 minutes
   later. If anything fails or there isn't room, the entry stays as it was and is tried again in an hour.

The header shows it live ("Updating older backups · 3 of 12 · 1.2 GB freed").

## Speed (measured)

Compression, on 1.1 GB of real app data (a 717 MB Postgres database, 284 MB of config in 9,773 files, 101 MB of
images):

| | Backup | Restore | Size |
|---|---|---|---|
| gzip (before 3.3) | 25.3 s | 10.3 s | 212 MB |
| zstd, all cores | 2.4 s | 7.4 s | 201 MB |

A move before 3.3 started 13 helper containers; checks are now done together and each backup uses one helper.
Helpers are checked every 100 ms at first instead of every second.

The first move right after an automatic backup saved 350 KB new out of 46 MB. A test app with 77 MB of data was down
for 7.6 s during a move (2.4 s of it the backup, the rest writing the compose file and starting it).

## How it was tested

On a real Docker server with real images (Postgres, Navidrome, filebrowser, and test apps with known data):

- A test app's data (an 80 MB file, 1,500 files owned by different users, a file with mode 600 owned by 1234:5678, a
  symlink, a volume of 300 files) was fingerprinted: every file's contents, owner, group, permissions and link target.
- Backups made every way (gzip, zstd, the store, converted from archives, and after a cleanup removed other backups)
  were restored to a new folder: **all matched the fingerprint exactly.**
- `restic check --read-data` (reads every byte of the store): no errors.
- Browsing files, downloading one file (byte-identical) and downloading a whole backup work for store backups.
- Deleting Restore entries removed 13 unused snapshots and shrank the store from 212 MB to 80 MB.
- Automatic backups of a qBittorrent-style, a Plex-style and a Postgres stack kept and left out exactly what's
  described above; the database dump held the test table with all its rows.

Not tested here: building the real Manifexus image (the sandbox can't download Docker's packages). The first image
build is the first real test of bundling restic; if the download fails, the build still succeeds and backups use
`.tar.zst` archives.

## Known gaps

- **There's no button to restore a stack from an automatic backup yet.** The data is in the store and readable with
  restic; a "Restore this stack" flow belongs with stage 3.
- **Restoring a move doesn't bring back data deleted inside an existing stack folder.** Restore puts the compose files
  back and only unpacks data when the whole stack folder is gone. That's by design (a move doesn't change data), but
  Restore could offer to put the data back too.
- **SQLite files** (most *arr apps) are copied while the app runs: almost always fine, not guaranteed consistent like
  the Postgres and MySQL dumps.
- **Dragging an app out of "Not in a Stack" fails:** the move looks the app up by compose project, which a
  `docker run` app doesn't have (`src/App.tsx`, `runBatch`).
- **First setup collides with the AI example:** the example problem for the built-in AI saves the stacks folder
  without its leading `/`, so step 2 of Getting Started shows an error and a greyed-out Continue until it's fixed by
  hand (`server/aiExample.ts`).

## Where the code is

| File | What it does |
|---|---|
| `server/backupStore.ts` | The store: create it, back up items (in parallel), restore, list, download, cleanup |
| `server/backupAuto.ts` | Automatic backups: what to keep, schedule, queue, status |
| `server/backupUpgrade.ts` | Moving older backups into the store, with verification |
| `server/dataBackupService.ts` | Helper containers, archives (fallback), one-helper backups, batched checks |
| `server/restoreService.ts` | Restore, browsing, downloads for both kinds |
| `server/automationService.ts` | Moves (first pass while running) |
| `src/components/BackupsSheet.tsx`, `backupSummary.ts` | The Backups screen and its status |
| `src/components/ManifexusHeroHeader.tsx` | Backups button, older-backups status |
| `Dockerfile` | Bundles restic |
