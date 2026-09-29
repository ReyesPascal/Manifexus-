import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { DeepContainerMetadata } from './types';
import { BackButton, Button, SectionFooter, Sheet, ios } from './components/ui/ios';
import { AppIcon } from './components/AppCard';

/**
 * Stack icons. Every stack has one from the start: a symbol on a coloured tile, like lists in Apple's
 * Reminders. The symbol is guessed from the stack's name and the colour comes from it, so each stack
 * keeps its look. People can pick any of Lucide's 1,600+ symbols and 12 colours, or an app's logo from
 * the Dashboard Icons set. Once a stack has apps (and no picked icon), it shows their icons in a 2×2.
 */

export interface StackIconChoice {
  /** Lucide symbol name, e.g. "clapperboard" */
  symbol?: string;
  /** Its drawing, kept with the choice so the dashboard never needs the whole set */
  svg?: string;
  color?: string;
  /** An app logo (image address) instead of a symbol */
  logo?: string;
}

export const COLORS = ['#FF453A', '#FF9F0A', '#FFD60A', '#30D158', '#63E6E2', '#40C8E0', '#64D2FF', '#0A84FF', '#5E5CE6', '#BF5AF2', '#FF375F', '#AC8E68'];

/** Symbols guessed from a stack's name (drawings included so they're always available) */
const GUESS_SVG: Record<string, string> = {"clapperboard": "<path d=\"M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z\" /><path d=\"m6.2 5.3 3.1 3.9\" /><path d=\"m12.4 3.4 3.1 4\" /><path d=\"M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z\" />","tv": "<path d=\"m17 2-5 5-5-5\" /><rect width=\"20\" height=\"15\" x=\"2\" y=\"7\" rx=\"2\" />","film": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" /><path d=\"M7 3v18\" /><path d=\"M3 7.5h4\" /><path d=\"M3 12h18\" /><path d=\"M3 16.5h4\" /><path d=\"M17 3v18\" /><path d=\"M17 7.5h4\" /><path d=\"M17 16.5h4\" />","music": "<path d=\"M9 18V5l12-2v13\" /><circle cx=\"6\" cy=\"18\" r=\"3\" /><circle cx=\"18\" cy=\"16\" r=\"3\" />","headphones": "<path d=\"M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3\" />","download": "<path d=\"M12 15V3\" /><path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\" /><path d=\"m7 10 5 5 5-5\" />","cloud-download": "<path d=\"M12 13v8l-4-4\" /><path d=\"m12 21 4-4\" /><path d=\"M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284\" />","image": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" ry=\"2\" /><circle cx=\"9\" cy=\"9\" r=\"2\" /><path d=\"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21\" />","camera": "<path d=\"M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z\" /><circle cx=\"12\" cy=\"13\" r=\"3\" />","book-open": "<path d=\"M12 7v14\" /><path d=\"M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z\" />","library": "<path d=\"m16 6 4 14\" /><path d=\"M12 6v14\" /><path d=\"M8 8v12\" /><path d=\"M4 4v16\" />","house": "<path d=\"M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8\" /><path d=\"M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\" />","lightbulb": "<path d=\"M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5\" /><path d=\"M9 18h6\" /><path d=\"M10 22h4\" />","chart-line": "<path d=\"M3 3v16a2 2 0 0 0 2 2h16\" /><path d=\"m19 9-5 5-4-4-3 3\" />","activity": "<path d=\"M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2\" />","globe": "<circle cx=\"12\" cy=\"12\" r=\"10\" /><path d=\"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\" /><path d=\"M2 12h20\" />","network": "<rect x=\"16\" y=\"16\" width=\"6\" height=\"6\" rx=\"1\" /><rect x=\"2\" y=\"16\" width=\"6\" height=\"6\" rx=\"1\" /><rect x=\"9\" y=\"2\" width=\"6\" height=\"6\" rx=\"1\" /><path d=\"M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3\" /><path d=\"M12 12V8\" />","shield": "<path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\" />","lock": "<rect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\" /><path d=\"M7 11V7a5 5 0 0 1 10 0v4\" />","hard-drive": "<line x1=\"22\" x2=\"2\" y1=\"12\" y2=\"12\" /><path d=\"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z\" /><line x1=\"6\" x2=\"6.01\" y1=\"16\" y2=\"16\" /><line x1=\"10\" x2=\"10.01\" y1=\"16\" y2=\"16\" />","database": "<ellipse cx=\"12\" cy=\"5\" rx=\"9\" ry=\"3\" /><path d=\"M3 5V19A9 3 0 0 0 21 19V5\" /><path d=\"M3 12A9 3 0 0 0 21 12\" />","server": "<rect width=\"20\" height=\"8\" x=\"2\" y=\"2\" rx=\"2\" ry=\"2\" /><rect width=\"20\" height=\"8\" x=\"2\" y=\"14\" rx=\"2\" ry=\"2\" /><line x1=\"6\" x2=\"6.01\" y1=\"6\" y2=\"6\" /><line x1=\"6\" x2=\"6.01\" y1=\"18\" y2=\"18\" />","wrench": "<path d=\"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z\" />","code": "<path d=\"m16 18 6-6-6-6\" /><path d=\"m8 6-6 6 6 6\" />","gamepad-2": "<line x1=\"6\" x2=\"10\" y1=\"11\" y2=\"11\" /><line x1=\"8\" x2=\"8\" y1=\"9\" y2=\"13\" /><line x1=\"15\" x2=\"15.01\" y1=\"12\" y2=\"12\" /><line x1=\"18\" x2=\"18.01\" y1=\"10\" y2=\"10\" /><path d=\"M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z\" />","message-circle": "<path d=\"M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719\" />","mail": "<path d=\"m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7\" /><rect x=\"2\" y=\"4\" width=\"20\" height=\"16\" rx=\"2\" />","calendar": "<path d=\"M8 2v4\" /><path d=\"M16 2v4\" /><rect width=\"18\" height=\"18\" x=\"3\" y=\"4\" rx=\"2\" /><path d=\"M3 10h18\" />","file-text": "<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\" /><path d=\"M14 2v4a2 2 0 0 0 2 2h4\" /><path d=\"M10 9H8\" /><path d=\"M16 13H8\" /><path d=\"M16 17H8\" />","bot": "<path d=\"M12 8V4H8\" /><rect width=\"16\" height=\"12\" x=\"4\" y=\"8\" rx=\"2\" /><path d=\"M2 14h2\" /><path d=\"M20 14h2\" /><path d=\"M15 13v2\" /><path d=\"M9 13v2\" />","layers": "<path d=\"M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z\" /><path d=\"M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12\" /><path d=\"M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17\" />","sparkles": "<path d=\"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z\" /><path d=\"M20 2v4\" /><path d=\"M22 4h-4\" /><circle cx=\"4\" cy=\"20\" r=\"2\" />","newspaper": "<path d=\"M15 18h-5\" /><path d=\"M18 14h-8\" /><path d=\"M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0v-9a2 2 0 0 1 2-2h2\" /><rect width=\"8\" height=\"4\" x=\"10\" y=\"6\" rx=\"1\" />","radio": "<path d=\"M16.247 7.761a6 6 0 0 1 0 8.478\" /><path d=\"M19.075 4.933a10 10 0 0 1 0 14.134\" /><path d=\"M4.925 19.067a10 10 0 0 1 0-14.134\" /><path d=\"M7.753 16.239a6 6 0 0 1 0-8.478\" /><circle cx=\"12\" cy=\"12\" r=\"2\" />","podcast": "<path d=\"M13 17a1 1 0 1 0-2 0l.5 4.5a0.5 0.5 0 0 0 1 0z\" fill=\"currentColor\" /><path d=\"M16.85 18.58a9 9 0 1 0-9.7 0\" /><path d=\"M8 14a5 5 0 1 1 8 0\" /><circle cx=\"12\" cy=\"11\" r=\"1\" fill=\"currentColor\" />","users": "<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\" /><path d=\"M16 3.128a4 4 0 0 1 0 7.744\" /><path d=\"M22 21v-2a4 4 0 0 0-3-3.87\" /><circle cx=\"9\" cy=\"7\" r=\"4\" />","wallet": "<path d=\"M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1\" /><path d=\"M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4\" />","shopping-cart": "<circle cx=\"8\" cy=\"21\" r=\"1\" /><circle cx=\"19\" cy=\"21\" r=\"1\" /><path d=\"M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12\" />","cloud": "<path d=\"M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z\" />","folder": "<path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\" />"};

const GUESS: [RegExp, string][] = [
  [/movie|film|cinema|plex|jellyfin|emby|media|stream|video/, 'clapperboard'],
  [/tv|show|series|sonarr/, 'tv'],
  [/music|audio|song|lidarr|navidrome|spotify/, 'music'],
  [/podcast/, 'podcast'],
  [/radio/, 'radio'],
  [/download|torrent|usenet|nzb|sab|arr/, 'download'],
  [/photo|picture|image|immich|gallery/, 'image'],
  [/camera|cctv|frigate|nvr|security-cam/, 'camera'],
  [/book|read|kavita|komga|calibre|library|comic/, 'book-open'],
  [/home|house|assistant|hass|iot|smart/, 'house'],
  [/light|hue/, 'lightbulb'],
  [/monitor|grafana|prometheus|metric|stat|uptime/, 'chart-line'],
  [/health|status/, 'activity'],
  [/network|dns|proxy|nginx|traefik|caddy|pihole|adguard|vpn|wireguard|gluetun/, 'globe'],
  [/secur|auth|vault|bitwarden|password/, 'shield'],
  [/backup|sync|cloud|nextcloud|drive/, 'cloud'],
  [/storage|nas|disk|files?$/, 'hard-drive'],
  [/db|database|sql|postgres|mariadb|redis|mongo/, 'database'],
  [/server|infra|system|core/, 'server'],
  [/tool|util|misc|admin/, 'wrench'],
  [/dev|code|git|build/, 'code'],
  [/game|minecraft|steam/, 'gamepad-2'],
  [/chat|message|matrix|discord/, 'message-circle'],
  [/mail|email/, 'mail'],
  [/calendar|schedule/, 'calendar'],
  [/doc|paper|office|note|wiki/, 'file-text'],
  [/ai|llm|ollama|bot|gpt/, 'bot'],
  [/news|rss|feed/, 'newspaper'],
  [/finance|money|budget/, 'wallet'],
  [/shop|store/, 'shopping-cart'],
  [/family|users|people/, 'users'],
];

const hashOf = (s: string) => Array.from(s).reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

/** The symbol and colour a stack gets before anyone picks one */
export function guessIcon(name: string): { symbol: string; svg: string; color: string } {
  const n = name.toLowerCase();
  const symbol = GUESS.find(([re]) => re.test(n))?.[1] || 'layers';
  return { symbol, svg: GUESS_SVG[symbol] || GUESS_SVG.layers, color: COLORS[hashOf(n || 'stack') % COLORS.length] };
}

/** Draw a Lucide symbol from its stored drawing, allowing only plain shapes (never scripts or links) */
const SHAPES = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
const ATTRS = new Set(['d', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'points']);
export const SymbolGlyph: React.FC<{ svg: string; size: number; color?: string; strokeWidth?: number }> = ({ svg, size, color = '#fff', strokeWidth = 2 }) => {
  const shapes = useMemo(() => {
    const out: React.ReactElement[] = [];
    const re = /<(path|circle|rect|line|polyline|polygon|ellipse)\s+([^>]*?)\/?>/g;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(svg))) {
      if (!SHAPES.has(m[1])) continue;
      const props: Record<string, string> = {};
      const ar = /([a-z][a-z0-9-]*)="([^"]*)"/gi;
      let a: RegExpExecArray | null;
      while ((a = ar.exec(m[2]))) if (ATTRS.has(a[1])) props[a[1]] = a[2];
      const Tag = m[1] as 'path';
      out.push(<Tag key={i++} {...props} />);
    }
    return out;
  }, [svg]);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {shapes}
    </svg>
  );
};

/** A symbol (or logo) on its coloured tile */
export const IconTileFor: React.FC<{ choice: StackIconChoice; size: number }> = ({ choice, size }) => {
  const [failed, setFailed] = useState(false);
  const color = choice.color || COLORS[7];
  if (choice.logo && !failed)
    return (
      <div className="flex-shrink-0 flex items-center justify-center overflow-hidden" style={{ width: size, height: size, borderRadius: size * 0.26, background: 'rgba(255,255,255,0.08)', boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.12)' }}>
        <img src={choice.logo} alt="" onError={() => setFailed(true)} style={{ width: size * 0.72, height: size * 0.72 }} className="object-contain" />
      </div>
    );
  return (
    <div
      className="flex-shrink-0 flex items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.26,
        background: `linear-gradient(160deg, ${color}, ${color}cc)`,
        boxShadow: `inset 0 1px 0 rgba(255,255,255,0.25), 0 6px 16px -8px ${color}`,
      }}
    >
      <SymbolGlyph svg={choice.svg || GUESS_SVG.layers} size={size * 0.52} strokeWidth={size > 50 ? 1.8 : 2.1} />
    </div>
  );
};

/** A stack's icon: yours if you picked one, its apps' icons once it has apps, otherwise a symbol guessed from its name */
export const StackIcon: React.FC<{ name: string; apps: DeepContainerMetadata[]; choice?: StackIconChoice; size?: number }> = ({ name, apps, choice, size = 44 }) => {
  if (choice && (choice.svg || choice.logo)) return <IconTileFor choice={choice} size={size} />;
  if (apps.length === 1) return <AppIcon container={apps[0]} size={size} />;
  if (apps.length > 1) {
    const cell = Math.round((size - 12) / 2);
    return (
      <div className="flex-shrink-0 grid grid-cols-2 gap-[4px] p-[4px] rounded-[12px]" style={{ width: size, height: size, background: 'rgba(118,118,128,0.22)', boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.12)' }} aria-hidden>
        {apps.slice(0, 4).map((c) => (
          <div key={c.id} className="flex items-center justify-center">
            <AppIcon container={c} size={cell} />
          </div>
        ))}
      </div>
    );
  }
  return <IconTileFor choice={guessIcon(name)} size={size} />;
};

// ----------------------------------------------------------------------------
// Picker
// ----------------------------------------------------------------------------

type Tab = 'symbols' | 'logos';
const LOGO_BASE = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons';
let logoIndex: Promise<string[]> | undefined;
function loadLogos(): Promise<string[]> {
  logoIndex ??= fetch(`${LOGO_BASE}/tree.json`)
    .then((r) => r.json())
    .then((j) => ((j.svg as string[]) || (j.png as string[]) || []).map((f) => f.replace(/\.(svg|png)$/, '')))
    .catch((e) => {
      logoIndex = undefined;
      throw e;
    });
  return logoIndex;
}

/** Shown first, before any search: symbols that suit a stack */
const SUGGESTED = [
  'clapperboard', 'film', 'tv', 'music', 'headphones', 'radio', 'podcast', 'image', 'camera', 'book-open', 'library',
  'download', 'cloud-download', 'cloud', 'hard-drive', 'database', 'server', 'house', 'lightbulb', 'thermometer', 'plug',
  'globe', 'network', 'wifi', 'router', 'shield', 'lock', 'key-round', 'chart-line', 'activity', 'gauge', 'bell',
  'mail', 'message-circle', 'calendar', 'file-text', 'folder', 'archive', 'package', 'boxes', 'code', 'terminal',
  'cpu', 'wrench', 'hammer', 'settings', 'bot', 'brain', 'sparkles', 'gamepad-2', 'newspaper', 'rss', 'wallet',
  'shopping-cart', 'users', 'heart', 'paw-print', 'leaf', 'sun', 'car', 'plane', 'map', 'printer', 'smartphone',
  'monitor', 'mic', 'video', 'rocket', 'star', 'coffee', 'utensils', 'dumbbell', 'graduation-cap', 'briefcase',
  'palette', 'layers',
];

const QUICK = ['Media', 'Home', 'Network', 'Files', 'Devices', 'Charts', 'Security', 'Communication', 'Development', 'Games', 'Weather', 'Travel', 'Food', 'Animals'];
const QUICK_WORDS: Record<string, string> = {
  Media: 'multimedia', Home: 'home', Network: 'connectivity', Files: 'files', Devices: 'devices', Charts: 'charts',
  Security: 'security', Communication: 'communication', Development: 'development', Games: 'gaming', Weather: 'weather',
  Travel: 'transportation', Food: 'food-beverage', Animals: 'animals',
};

/**
 * Choose a stack's icon: a symbol and colour, or an app's logo. Opens on top of the screen you're on;
 * Back returns to it, Use This Icon keeps the choice.
 */
export const StackIconPicker: React.FC<{
  open: boolean;
  name: string;
  current?: StackIconChoice;
  onClose: () => void;
  onChoose: (choice: StackIconChoice | undefined) => void;
}> = ({ open, name, current, onClose, onChoose }) => {
  const start = current && (current.svg || current.logo) ? current : guessIcon(name);
  const [choice, setChoice] = useState<StackIconChoice>(start);
  const [tab, setTab] = useState<Tab>(current?.logo ? 'logos' : 'symbols');
  const [q, setQ] = useState('');
  const [quick, setQuick] = useState<string>();
  const [symbols, setSymbols] = useState<[string, string, string][] | null>(null);
  const [logos, setLogos] = useState<string[] | null>(null);
  const [logoError, setLogoError] = useState(false);
  const [shown, setShown] = useState(240);

  useEffect(() => {
    if (!open) return;
    setChoice(current && (current.svg || current.logo) ? current : guessIcon(name));
    setQ('');
    setQuick(undefined);
    setShown(240);
    import('./data/stackSymbols').then((m) => setSymbols(m.SYMBOLS)).catch(() => setSymbols([]));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || tab !== 'logos' || logos) return;
    setLogoError(false);
    loadLogos().then(setLogos).catch(() => setLogoError(true));
  }, [open, tab, logos]);

  const query = q.trim().toLowerCase();
  const symbolList = useMemo(() => {
    if (!symbols) return [];
    const word = quick ? QUICK_WORDS[quick] : '';
    const list = symbols.filter(([n, words]) => (!query || n.includes(query) || words.includes(query)) && (!word || words.includes(word)));
    // Before searching: the symbols that suit stacks come first
    if (!query && !word) {
      const first = new Set(SUGGESTED);
      return [...SUGGESTED.map((n) => list.find((x) => x[0] === n)).filter((x): x is [string, string, string] => Boolean(x)), ...list.filter((x) => !first.has(x[0]))];
    }
    return list;
  }, [symbols, query, quick]);
  const logoList = useMemo(() => (logos || []).filter((n) => !query || n.includes(query.replace(/\s+/g, '-'))), [logos, query]);

  if (!open) return null;
  const color = choice.color || COLORS[7];
  const cellCls = 'aspect-square rounded-[12px] flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]';

  const sheet = (
    <Sheet
      open
      title="Choose Icon"
      subtitle={name}
      onClose={onClose}
      leftAction={<BackButton label="Back" onClick={onClose} />}
      rightAction={<span />}
      zIndex={95}
      footer={
        <div className="flex items-center justify-between gap-3">
          <button type="button" onClick={() => onChoose(undefined)} className="text-[15px] hover:opacity-80" style={{ color: ios.blue }}>
            Automatic
          </button>
          <Button onClick={() => onChoose(choice)} className="flex-1 sm:flex-none sm:min-w-[170px]">
            Use This Icon
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        {/* Live preview */}
        <div className="flex flex-col items-center pt-1">
          <IconTileFor choice={choice} size={76} />
          <div className="mt-2.5 text-[15px] font-semibold text-white truncate max-w-full">{name}</div>
        </div>

        {/* Symbols | App Logos */}
        <div className="flex justify-center">
          <div role="tablist" className="inline-flex p-[2px] rounded-[9px]" style={{ background: 'rgba(118,118,128,0.2)' }}>
            {(['symbols', 'logos'] as Tab[]).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => {
                  setTab(t);
                  setQ('');
                }}
                className="h-7 px-4 rounded-[7px] text-[13px] font-medium transition-colors"
                style={tab === t ? { background: 'rgba(99,99,102,0.9)', color: '#fff' } : { color: ios.secondary }}
              >
                {t === 'symbols' ? 'Symbols' : 'App Logos'}
              </button>
            ))}
          </div>
        </div>

        {tab === 'symbols' && (
          <div className="flex flex-wrap justify-center gap-2.5" role="radiogroup" aria-label="Colour">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={`Colour ${c}`}
                onClick={() => setChoice((x) => ({ ...x, logo: undefined, color: c, svg: x.svg || guessIcon(name).svg, symbol: x.symbol || guessIcon(name).symbol }))}
                className="w-8 h-8 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                style={{ background: c, boxShadow: color === c && !choice.logo ? `0 0 0 2.5px #1c1c1e, 0 0 0 4.5px ${c}` : undefined }}
              />
            ))}
          </div>
        )}

        <input
          type="search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setShown(240);
          }}
          placeholder={tab === 'symbols' ? 'Search 1,600+ symbols' : 'Search app logos (Plex, Jellyfin…)'}
          aria-label="Search icons"
          className="w-full h-10 px-4 rounded-[10px] text-[15px] text-white outline-none placeholder:text-[rgba(235,235,245,0.4)] focus:ring-2 focus:ring-[#0A84FF]"
          style={{ background: 'rgba(118,118,128,0.2)' }}
        />

        {tab === 'symbols' && (
          <>
            {!query && (
              <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
                {QUICK.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setQuick(quick === k ? undefined : k)}
                    className="flex-shrink-0 h-7 px-3 rounded-full text-[13px] transition-colors"
                    style={quick === k ? { background: ios.blue, color: '#fff' } : { background: 'rgba(118,118,128,0.18)', color: 'rgba(235,235,245,0.85)' }}
                  >
                    {k}
                  </button>
                ))}
              </div>
            )}
            {!symbols ? (
              <p className="text-center text-[14px] py-10" style={{ color: ios.secondary }}>Loading symbols…</p>
            ) : symbolList.length === 0 ? (
              <p className="text-center text-[14px] py-10" style={{ color: ios.secondary }}>No symbols match “{q}”.</p>
            ) : (
              <div className="grid grid-cols-6 sm:grid-cols-9 gap-1.5" role="radiogroup" aria-label="Symbol">
                {symbolList.slice(0, shown).map(([n, , svg]) => {
                  const on = !choice.logo && choice.symbol === n;
                  return (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-label={n.replace(/-/g, ' ')}
                      title={n.replace(/-/g, ' ')}
                      onClick={() => setChoice((x) => ({ symbol: n, svg, color: x.color || color }))}
                      className={cellCls}
                      style={on ? { background: color } : { background: 'rgba(255,255,255,0.05)' }}
                    >
                      <SymbolGlyph svg={svg} size={22} color={on ? '#fff' : 'rgba(235,235,245,0.85)'} />
                    </button>
                  );
                })}
              </div>
            )}
            {symbolList.length > shown && (
              <div className="flex justify-center">
                <Button tone="gray" onClick={() => setShown((n) => n + 480)} className="!h-9 !text-[14px]">
                  Show More ({symbolList.length - shown})
                </Button>
              </div>
            )}
            <SectionFooter>Symbols from Lucide, free for everyone.</SectionFooter>
          </>
        )}

        {tab === 'logos' && (
          <>
            {logoError ? (
              <p className="text-center text-[14px] py-10 px-4" style={{ color: ios.secondary }}>
                App logos come from the internet, and they couldn’t be reached from this browser right now. Symbols work offline.
              </p>
            ) : !logos ? (
              <p className="text-center text-[14px] py-10" style={{ color: ios.secondary }}>Loading app logos…</p>
            ) : !query ? (
              <p className="text-center text-[14px] py-10 px-4" style={{ color: ios.secondary }}>
                Type an app’s name to find its logo. There are {logos.length.toLocaleString()} to choose from.
              </p>
            ) : logoList.length === 0 ? (
              <p className="text-center text-[14px] py-10" style={{ color: ios.secondary }}>No logos match “{q}”.</p>
            ) : (
              <div className="grid grid-cols-4 sm:grid-cols-6 gap-2" role="radiogroup" aria-label="App logo">
                {logoList.slice(0, 60).map((n) => {
                  const url = `${LOGO_BASE}/svg/${n}.svg`;
                  const on = choice.logo === url;
                  return (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-label={n}
                      onClick={() => setChoice((x) => ({ ...x, logo: url }))}
                      className={`${cellCls} flex-col gap-1 p-2`}
                      style={on ? { background: 'rgba(10,132,255,0.25)', boxShadow: `inset 0 0 0 2px ${ios.blue}` } : { background: 'rgba(255,255,255,0.05)' }}
                    >
                      <img src={url} alt="" loading="lazy" className="w-9 h-9 object-contain" />
                      <span className="text-[10.5px] leading-tight truncate w-full text-center" style={{ color: ios.secondary }}>
                        {n}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            <SectionFooter>Logos from Dashboard Icons, the community set for self-hosted apps.</SectionFooter>
          </>
        )}
      </div>
    </Sheet>
  );
  return createPortal(sheet, document.body);
};
