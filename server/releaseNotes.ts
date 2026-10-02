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
  /**
   * Set on a version that changed how Manifexus stores its data in a way earlier versions can't read
   * (3.3: the backup store). Its text says why, in plain words. Going back never goes below the newest
   * version that has it.
   */
  storageChange?: string;
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

/** "3.3" -> "3.3.0": the numbered image tag the build publishes for a version */
export function fullVersion(v: string): string {
  const parts = v.split('.');
  while (parts.length < 3) parts.push('0');
  return parts.slice(0, 3).join('.');
}

export interface EarlierVersion {
  version: string;
  date: string;
  headline: string;
}

export interface VersionHistory {
  /** Earlier versions that can be installed, newest first */
  versions: EarlierVersion[];
  /** The oldest version going back may reach, and why (a storage change); absent when there is no limit */
  limit?: { version: string; reason: string };
}

/**
 * The versions this one may go back to: every earlier release down to the newest one (up to and including
 * this version) that changed how data is stored. Earlier versions than that can't read what Manifexus keeps
 * now, so they're never offered.
 */
export function versionHistory(all: Release[] = localReleases(), current: string | undefined = localVersion()): VersionHistory {
  if (!current) return { versions: [] };
  const upToNow = all
    .filter((r) => compareVersions(r.version, current) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  const floor = upToNow.find((r) => r.storageChange);
  const versions = upToNow
    .filter((r) => compareVersions(r.version, current) < 0 && (!floor || compareVersions(r.version, floor.version) >= 0))
    .map((r) => ({ version: r.version, date: r.date, headline: r.headline }));
  return { versions, limit: floor ? { version: floor.version, reason: floor.storageChange! } : undefined };
}

/** Whether `version` may be installed from `current` (checked on the server, whatever the screen sends) */
export function canGoBackTo(version: string, all: Release[] = localReleases(), current: string | undefined = localVersion()): string | null {
  const h = versionHistory(all, current);
  if (h.versions.some((v) => v.version === version)) return null;
  if (current && compareVersions(version, current) === 0) return `Manifexus is already on ${version}.`;
  if (current && compareVersions(version, current) > 0) return `${version} is newer than this version. Use Update Now instead.`;
  if (h.limit && compareVersions(version, h.limit.version) < 0) return `Manifexus can’t go back before ${h.limit.version}. ${h.limit.reason}`;
  return `${version} isn’t a Manifexus version.`;
}
