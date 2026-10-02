/**
 * Keeps an older Manifexus from running on data a newer one saved in a way it can't read.
 *
 * The data format is the newest version (up to this one) marked "storageChange" in release-notes.json (3.3:
 * the backup store). Each version records in /data the newest format the data has been saved in, and the
 * version that saved it. A version that only knows an older format refuses to run there and shows a page
 * saying which version to start instead, so a version started by hand can't damage backups or settings.
 * (Versions before 3.4 don't have this check: going back to them is never offered.)
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { compareVersions, localReleases, localVersion } from './releaseNotes';
import { readJsonSafe, writeJsonAtomic } from './safeJson';

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(process.cwd(), 'data');
const FORMAT_FILE = path.join(DATA_DIR, 'data-format.json');

interface Stored {
  format: string;
  writtenBy?: string;
}

/** The newest data format this version reads and writes, e.g. "3.3" */
export function knownDataFormat(all = localReleases(), current = localVersion()): string | undefined {
  if (!current) return undefined;
  return all
    .filter((r) => r.storageChange && compareVersions(r.version, current) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version))[0]?.version;
}

/**
 * Checks this version against the data on this server. Returns what's wrong when the data is newer than this
 * version understands (it mustn't run); otherwise records this version's format and returns null.
 */
export function checkDataFormat(file = FORMAT_FILE, known = knownDataFormat(), current = localVersion()): Stored | null {
  if (!known) return null; // development build without release notes: nothing to compare
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stored = readJsonSafe<any>(file, null);
  const format = typeof stored?.format === 'string' ? stored.format : undefined;
  if (format && compareVersions(format, known) > 0) return { format, writtenBy: stored.writtenBy };
  if (!format || compareVersions(format, known) < 0 || stored.writtenBy !== current) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJsonAtomic(file, { format: known, writtenBy: current });
    } catch {
      // read-only data folder: the check simply can't be recorded
    }
  }
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Instead of Manifexus: one page explaining which version to start (and a 503 for every request) */
export function serveTooOldPage(port: number, problem: Stored): void {
  const current = localVersion() || 'this version';
  const newer = problem.writtenBy || problem.format;
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Manifexus</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1020;color:#fff;
font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px;box-sizing:border-box}
main{max-width:460px;background:rgba(30,40,70,.6);border-radius:22px;padding:28px 28px 24px;
box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 0 0 .5px rgba(255,255,255,.1),0 20px 60px rgba(0,0,0,.45)}
h1{font-size:22px;font-weight:600;margin:0 0 10px}p{font-size:15px;line-height:21px;color:rgba(235,235,245,.75);margin:0 0 12px}
b{color:#fff;font-weight:600}code{font-family:ui-monospace,Menlo,monospace;font-size:13px;color:#fff}</style></head>
<body><main><h1>This version of Manifexus is too old for this server</h1>
<p>Your backups and settings were saved by <b>Manifexus ${escapeHtml(newer)}</b>, in a way <b>${escapeHtml(current)}</b> can't read. To keep them safe, ${escapeHtml(current)} won't run here.</p>
<p>Start Manifexus ${escapeHtml(newer)} or newer again (the <code>latest</code> image). Your apps keep running in the meantime, and nothing was changed.</p>
</main></body></html>`;
  http
    .createServer((req, res) => {
      if ((req.url || '').startsWith('/api/')) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `This version of Manifexus (${current}) is older than the data on this server (saved by ${newer}).` }));
        return;
      }
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    })
    .listen(port, '0.0.0.0', () => {
      console.error(`[Manifexus] Not starting: the data on this server was saved by Manifexus ${newer}, which ${current} can't read. Start ${newer} or newer.`);
    });
}
