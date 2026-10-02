import fs from 'fs';

/**
 * Saving and reading Manifexus's own records (settings, the Restore history) so they can't be lost.
 *
 * - A save never leaves a half-written file: it's written to a temporary file, flushed to disk, then
 *   swapped in. If Manifexus is stopped mid-save (an update, a restart, a full disk) the last good copy stays.
 * - The previous good copy is kept beside it (`.bak`).
 * - A file that can't be read is never treated as empty (which would let the next save wipe it): it's set
 *   aside as `.corrupt-<time>` for recovery and the last good copy is used instead.
 */

export function writeJsonAtomic(file: string, data: unknown, opts: { backup?: boolean; pretty?: boolean } = {}): void {
  const text = JSON.stringify(data, null, opts.pretty === false ? undefined : 2);
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (opts.backup !== false && fs.existsSync(file)) {
    try {
      // Only a copy that still reads properly becomes the backup
      JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.copyFileSync(file, `${file}.bak`);
    } catch {
      /* the current file is damaged: keep the older backup */
    }
  }
  fs.renameSync(tmp, file);
}

/**
 * Reads a JSON file. Missing: the fallback. Damaged: set aside, and the last good copy (`.bak`) is used;
 * the fallback only when there's no good copy at all.
 */
export function readJsonSafe<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) {
    // A save interrupted between backup and swap leaves only the backup
    if (fs.existsSync(`${file}.bak`)) return readBackup(file, fallback);
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    console.error(`[Storage] ${file} couldn't be read (${(err as Error).message}); setting it aside and using the last good copy`);
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* leave it */
    }
    return readBackup(file, fallback);
  }
}

function readBackup<T>(file: string, fallback: T): T {
  try {
    const value = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')) as T;
    // Put the good copy back in place
    try {
      fs.copyFileSync(`${file}.bak`, file);
    } catch {
      /* reading it is enough */
    }
    return value;
  } catch {
    return fallback;
  }
}

/** Reads a JSON file only when it changed on disk (by time and size); otherwise the copy in memory */
export function cachedJsonReader<T>(file: string, fallback: () => T) {
  let cache: { mtimeMs: number; size: number; value: T } | null = null;
  return {
    read(): T {
      let st: fs.Stats | null = null;
      try {
        st = fs.statSync(file);
      } catch {
        st = null;
      }
      if (st && cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return structuredClone(cache.value);
      const value = readJsonSafe<T>(file, fallback());
      try {
        const now = fs.statSync(file);
        cache = { mtimeMs: now.mtimeMs, size: now.size, value };
      } catch {
        cache = null;
      }
      return structuredClone(value);
    },
    forget() {
      cache = null;
    },
  };
}
