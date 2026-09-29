/**
 * Release notes written for people, not developers. `release-notes.json` at the root of the repo
 * lists every version, newest first, with a headline and what's New, Improved and Fixed. Each build
 * carries its own copy (so Manifexus knows its version), and the Updates screen reads the copy from
 * the version on offer to show what's new since yours.
 */
import fs from 'fs';
import path from 'path';

export interface Release {
  /** "1.1" or "1.1.1" */
  version: string;
  /** YYYY-MM-DD */
  date: string;
  /** One friendly sentence: the reason to update */
  headline: string;
  new?: string[];
  improved?: string[];
  fixed?: string[];
}

let local: Release[] | undefined;

/** This build's own release notes (newest first) */
export function localReleases(): Release[] {
  if (local) return local;
  for (const p of [path.join(process.cwd(), 'release-notes.json'), path.join(__dirname, '..', 'release-notes.json'), '/app/release-notes.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(j?.releases)) return (local = j.releases as Release[]);
    } catch {
      // try the next place
    }
  }
  return (local = []);
}

/** The version this build is, e.g. "1.1" */
export const localVersion = (): string | undefined => localReleases()[0]?.version;

/** Compare "1.10.2" and "1.9": negative when a is older */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** The release notes of another build, read from the repo at that build's commit */
export async function remoteReleases(source: string | undefined, revision: string | undefined): Promise<Release[] | null> {
  const m = source?.match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (!m || !revision) return null;
  const repo = `${m[1]}/${m[2].replace(/\.git$/, '')}`;
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${revision}/release-notes.json`, {
      headers: { 'User-Agent': 'Manifexus' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return Array.isArray(j?.releases) ? (j.releases as Release[]) : null;
  } catch {
    return null;
  }
}

/** Releases newer than `current` (all of them when current is unknown), newest first */
export function releasesSince(all: Release[], current: string | undefined): Release[] {
  return current ? all.filter((r) => compareVersions(r.version, current) > 0) : all.slice(0, 1);
}
