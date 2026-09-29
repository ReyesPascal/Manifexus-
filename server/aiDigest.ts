/**
 * Cutting down what the AI has to read. On a server without a graphics card, reading is the slowest
 * part of every answer (tens of words a second), so logs and files are boiled down to what matters
 * before the AI sees them, with a note saying what was left out and how to get the rest.
 */

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
// Leading timestamps and log prefixes: 2026-09-29T05:00:06.229Z, [2026-09-29 05:00:06,229], 05:00:06.229, Sep 29 05:00:06
const STAMP = /^\s*(\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?|\[?\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\]?|[A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2})\s*[-|:]?\s*/;
const IMPORTANT = /\b(error|err|fatal|panic|exception|traceback|fail(ed|ure)?|denied|refused|cannot|can't|unable|not found|no such|timeout|timed out|killed|oom|crash|warn(ing)?)\b/i;

/** Same line apart from numbers, ids and times, for merging repeats */
const shape = (line: string) => line.replace(/\b[0-9a-f]{8,}\b/gi, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

/**
 * Logs, boiled down: colour codes and timestamps removed, repeated lines merged ("×120"), and within
 * the size limit, every error and warning (with the line after it) plus the most recent lines.
 */
export function compactLogs(raw: string, maxChars = 3000): string {
  const lines = raw.replace(ANSI, '').split(/\r?\n/).map((l) => l.replace(STAMP, '').trimEnd()).filter((l) => l.trim());
  if (!lines.length) return '(no output)';
  const firstStamp = STAMP.exec(raw.replace(ANSI, '').split(/\r?\n/).find((l) => STAMP.test(l)) || '')?.[1];

  // Merge repeats: keep the last occurrence of each shape (the most recent), counting the rest
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(shape(l), (counts.get(shape(l)) || 0) + 1);
  const seen = new Set<string>();
  const merged: { text: string; important: boolean }[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const k = shape(lines[i]);
    if (seen.has(k)) continue;
    seen.add(k);
    const n = counts.get(k) || 1;
    merged.unshift({ text: n > 1 ? `${lines[i]}  (×${n})` : lines[i], important: IMPORTANT.test(lines[i]) });
  }

  // Keep: the last 25 lines, and every important line with the one after it, newest first until full
  const keep = new Set<number>();
  for (let i = Math.max(0, merged.length - 25); i < merged.length; i++) keep.add(i);
  let size = Array.from(keep).reduce((n, i) => n + merged[i].text.length + 1, 0);
  for (let i = merged.length - 1; i >= 0 && size < maxChars; i--) {
    if (!merged[i].important) continue;
    for (const j of [i, i + 1]) {
      if (j < merged.length && !keep.has(j)) {
        keep.add(j);
        size += merged[j].text.length + 1;
      }
    }
  }
  // Still too big: drop the oldest of what's kept
  const order = Array.from(keep).sort((a, b) => a - b);
  while (order.length > 1 && order.reduce((n, i) => n + merged[i].text.length + 1, 0) > maxChars) order.shift();

  const out: string[] = [];
  let prev = -1;
  for (const i of order) {
    if (prev >= 0 && i > prev + 1) out.push('…');
    out.push(merged[i].text.length > 400 ? `${merged[i].text.slice(0, 400)}…` : merged[i].text);
    prev = i;
  }
  const repeats = lines.length - merged.length;
  const note = [
    `${lines.length} lines${firstStamp ? ` since ${firstStamp.replace(/[[\]]/g, '')}` : ''}`,
    repeats ? `${repeats} repeats merged` : '',
    order.length < merged.length ? `showing errors, warnings and the latest ${order.length} of ${merged.length}` : '',
    'times removed',
  ]
    .filter(Boolean)
    .join('; ');
  return `(${note})\n${out.join('\n')}`;
}

/**
 * The part of a file around the given words (e.g. a setting's name), with line numbers, instead of
 * the whole file. Small files are returned whole. Lines are exact, so an edit can quote them.
 */
export function fileExcerpt(text: string, around: string[], context = 6, wholeBelow = 800): { text: string; partial: boolean } {
  const terms = around.map((t) => t.trim()).filter((t) => t.length >= 3);
  if (text.length <= wholeBelow || !terms.length) return { text, partial: false };
  const lines = text.split('\n');
  const hits = lines.map((l, i) => (terms.some((t) => l.includes(t)) ? i : -1)).filter((i) => i >= 0);
  if (!hits.length) return { text, partial: false };
  const keep = new Set<number>();
  for (const h of hits.slice(0, 8)) for (let i = Math.max(0, h - context); i <= Math.min(lines.length - 1, h + context); i++) keep.add(i);
  const order = Array.from(keep).sort((a, b) => a - b);
  const out: string[] = [];
  let prev = -1;
  for (const i of order) {
    if (prev >= 0 && i > prev + 1) out.push('…');
    out.push(lines[i]);
    prev = i;
  }
  const first = order[0] + 1;
  const last = order[order.length - 1] + 1;
  return {
    text: `(the file has ${lines.length} lines; showing lines ${first}–${last} around ${terms.map((t) => `“${t}”`).join(', ')}. Read it again without "around" for the whole file.)\n${out.join('\n')}`,
    partial: true,
  };
}

/** Setting names an issue mentions in quotes, like the "stacksDir" line */
export function quotedNames(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/["“]([A-Za-z_][\w.-]{2,40})["”]/g)) if (!/\s/.test(m[1]) && !/^(home|true|false|null)$/i.test(m[1])) out.add(m[1]);
  return Array.from(out).slice(0, 4);
}
