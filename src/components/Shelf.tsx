import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DeepContainerMetadata } from '../types';
import { AppIcon } from './AppCard';
import { MenuButton, MenuItem, ios } from './ui/ios';

/**
 * The dashboard below the hero, in the hero's style: a section bar under the header and
 * one glass panel per stack or group, with its apps on quiet tiles inside.
 */

/** What an app card carries while it's dragged to another stack */
export const DRAG_TYPE = 'application/x-manifexus-app';

export const displayFont = '"Inter Tight", "SF Pro Display", -apple-system, system-ui, sans-serif';

/**
 * Liquid glass: a light, translucent pane that blurs and tints what's behind it (the soft glow behind
 * the dashboard), with a bright top edge like light catching glass
 */
export const panelStyle: React.CSSProperties = {
  background: 'linear-gradient(165deg, rgba(255,255,255,0.105) 0%, rgba(255,255,255,0.055) 45%, rgba(255,255,255,0.04) 100%)',
  backdropFilter: 'blur(28px) saturate(170%)',
  WebkitBackdropFilter: 'blur(28px) saturate(170%)',
  boxShadow:
    'inset 0 1px 0 rgba(255,255,255,0.22), inset 0 0 0 1px rgba(255,255,255,0.09), inset 0 -1px 0 rgba(255,255,255,0.04), 0 24px 48px -28px rgba(0,0,0,0.75)',
};

const Chevron: React.FC<{ open: boolean }> = ({ open }) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    className="transition-transform duration-200"
    style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
  >
    <path d="m9 6 6 6-6 6" />
  </svg>
);

const InfoGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.6v.01" strokeWidth="2.6" />
  </svg>
);

const MoreGlyph = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <circle cx="5" cy="12" r="1.9" />
    <circle cx="12" cy="12" r="1.9" />
    <circle cx="19" cy="12" r="1.9" />
  </svg>
);

export const PlusGlyph: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const PencilGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" />
    <path d="m13.5 6.5 4 4" />
  </svg>
);

/**
 * The small ✎ beside a name. It appears when you point at the name (and stays faintly visible on
 * touch screens, which can't point), so names stay clean until you want to change one.
 */
export const RenameButton: React.FC<{ label: string; onClick: () => void; group?: 'head' | 'card' }> = ({ label, onClick, group = 'head' }) => (
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation();
      onClick();
    }}
    title="Rename"
    aria-label={`Rename ${label}`}
    className={`flex-shrink-0 w-6 h-6 -my-1 rounded-full inline-flex items-center justify-center text-white opacity-0 transition-opacity hover:!opacity-100 hover:bg-white/[0.08] focus:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[#0A84FF] [@media(hover:none)]:opacity-40 ${
      group === 'head' ? 'group-hover/head:opacity-50' : 'group-hover/card:opacity-50'
    }`}
  >
    <PencilGlyph />
  </button>
);

/**
 * A name being renamed, in place: the same type, on a soft field. Enter or clicking away saves,
 * Esc cancels, and an empty name goes back to the original (shown as the placeholder).
 */
export const InlineName: React.FC<{
  value: string;
  original: string;
  onSave: (name: string) => void;
  onCancel: () => void;
  className?: string;
  style?: React.CSSProperties;
}> = ({ value, original, onSave, onCancel, className = '', style }) => {
  const [text, setText] = useState(value);
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  // Focus once whatever opened it (e.g. a menu handing focus back to its button) has settled
  useEffect(() => {
    const t = setTimeout(() => input.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && text.trim() !== value) onSave(text.trim());
    else onCancel();
  };
  return (
    <input
      ref={input}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      placeholder={original}
      aria-label={`New name for ${original}`}
      spellCheck={false}
      className={`w-full min-w-0 -mx-1.5 px-1.5 rounded-[8px] bg-white/[0.08] text-white outline-none ring-2 ring-[#0A84FF]/70 placeholder:text-white/30 ${className}`}
      style={style}
    />
  );
};

/** A stack's icon: its apps' icons in a 2×2, like a folder on iPhone */
export const FolderIcon: React.FC<{ apps: DeepContainerMetadata[]; tint?: string; size?: number }> = ({ apps, tint, size = 44 }) => {
  const four = apps.slice(0, 4);
  const cell = Math.round((size - 12) / 2);
  // One app: its own icon, full size
  if (four.length === 1)
    return (
      <div className="flex-shrink-0" aria-hidden>
        <AppIcon container={four[0]} size={size} />
      </div>
    );
  return (
    <div
      className="flex-shrink-0 grid grid-cols-2 gap-[4px] p-[4px] rounded-[12px]"
      style={{
        width: size,
        height: size,
        background: tint ? `linear-gradient(145deg, ${tint}55, ${tint}22)` : 'rgba(118,118,128,0.22)',
        boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.12)',
      }}
      aria-hidden
    >
      {four.length === 0 ? (
        <div className="col-span-2 row-span-2 flex items-center justify-center" style={{ color: tint || 'rgba(235,235,245,0.45)' }}>
          <svg width={size * 0.42} height={size * 0.42} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
            <path d="m12 3 9 5-9 5-9-5 9-5Z" />
            <path d="m3 13 9 5 9-5" />
          </svg>
        </div>
      ) : (
        four.map((c) => (
          <div key={c.id} className="flex items-center justify-center">
            <AppIcon container={c} size={cell} />
          </div>
        ))
      )}
    </div>
  );
};

/** "3 apps · ● All running" */
export const Health: React.FC<{ apps: DeepContainerMetadata[]; empty?: string; alsoCheck?: DeepContainerMetadata[] }> = ({ apps, empty = 'Empty', alsoCheck = [] }) => {
  if (!apps.length) return <span style={{ color: ios.tertiary }}>{empty}</span>;
  // The apps' own databases and caches count too: a stopped database means the app isn't working
  const all = [...apps, ...alsoCheck];
  const running = all.filter((a) => a.state === 'running').length;
  const restarting = all.filter((a) => a.state === 'restarting' || a.state === 'dead').length;
  const stopped = all.length - running - restarting;
  const n = `${apps.length} ${apps.length === 1 ? 'app' : 'apps'}`;
  const dot = (color: string) => <span className="w-[7px] h-[7px] rounded-full inline-block flex-shrink-0" style={{ background: color }} aria-hidden />;
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <span className="flex-shrink-0">{n}</span>
      <span aria-hidden>·</span>
      {restarting > 0 ? (
        <span className="inline-flex items-center gap-1.5" style={{ color: '#FF6961' }}>
          {dot(ios.red)}
          {restarting} {restarting === 1 ? 'keeps restarting' : 'keep restarting'}
        </span>
      ) : stopped > 0 ? (
        <span className="inline-flex items-center gap-1.5 truncate">
          {dot('#8E8E93')}
          {running === 0 ? (apps.length === 1 ? 'Stopped' : 'All stopped') : `${stopped} stopped`}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          {dot(ios.green)}
          {apps.length === 1 ? 'Running' : 'All running'}
        </span>
      )}
    </span>
  );
};

// Folded panels are remembered in this browser
const FOLD_KEY = 'manifexus.folded';
function readFolded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || '[]'));
  } catch {
    return new Set();
  }
}
function writeFolded(s: Set<string>) {
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify(Array.from(s)));
  } catch {
    // private window: only for this visit
  }
}

/** One stack or group: header (icon, name, health, actions) and its apps */
export const Shelf: React.FC<{
  id: string;
  title: string;
  icon: React.ReactNode;
  status: React.ReactNode;
  /** A quiet primary action beside the menu, e.g. + Add App */
  action?: { label: string; onClick: () => void; title?: string };
  menu?: MenuItem[];
  /** Opens the stack's details (shown as ⓘ, like on app cards; takes the place of the ⋯ menu) */
  onDetails?: () => void;
  /** Keep it open even if folded before (e.g. an app in it has a problem) */
  forceOpen?: boolean;
  /** How many app columns it asks for in the ShelfGrid (its app count) */
  span?: number;
  /** An app dragged onto it from the dashboard (the app's id) */
  onDropApp?: (appId: string) => void;
  /** Open with its name ready to type (a new stack) */
  startRenaming?: boolean;
  /** Typing the name was cancelled (Escape, or left empty) */
  onCancelRename?: () => void;
  /** Rename it on the dashboard; `original` is its real name (the folder's), shown as the placeholder */
  rename?: { original: string; onSave: (name: string) => void };
  children: React.ReactNode;
}> = ({ id, title, icon, status, action, menu, onDetails, forceOpen, rename, onDropApp, startRenaming, onCancelRename, children }) => {
  const [renaming, setRenaming] = useState(Boolean(startRenaming));
  const [over, setOver] = useState(false);
  const [folded, setFolded] = useState(() => readFolded().has(id));
  const open = forceOpen || !folded;
  const toggle = () => {
    const s = readFolded();
    if (open) s.add(id);
    else s.delete(id);
    writeFolded(s);
    setFolded(open);
  };
  const bodyId = `shelf-${id.replace(/[^a-z0-9_-]/gi, '_')}`;
  return (
    <section
      // Pops in when it first appears; glows blue while an app is dragged over it
      className={`mfx-pop rounded-[22px] min-w-0 transition-shadow duration-200 ${open ? 'flex-1 flex flex-col' : ''}`}
      style={{
        ...panelStyle,
        fontFamily: ios.font,
        ...(over ? { boxShadow: `${panelStyle.boxShadow}, inset 0 0 0 2px rgba(100,181,255,0.85), 0 0 36px rgba(10,132,255,0.35)` } : null),
      }}
      aria-label={title}
      onDragOver={
        onDropApp
          ? (e) => {
              if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (!over) setOver(true);
            }
          : undefined
      }
      onDragLeave={onDropApp ? (e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(false) : undefined}
      onDrop={
        onDropApp
          ? (e) => {
              e.preventDefault();
              setOver(false);
              const appId = e.dataTransfer.getData(DRAG_TYPE);
              if (appId) onDropApp(appId);
            }
          : undefined
      }
    >
      <header className="group/head flex items-center gap-3 pl-4 pr-3 sm:pl-5 sm:pr-4 py-3.5">
        {/* Tapping the icon, name or status folds the stack; the ✎ beside the name renames it */}
        <div className="group flex-1 min-w-0 flex items-center gap-3 cursor-pointer" onClick={renaming ? undefined : toggle}>
          <span className="flex-shrink-0">{icon}</span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 min-w-0">
              {renaming && rename ? (
                <InlineName
                  value={title === rename.original ? '' : title}
                  original={rename.original}
                  onSave={(n) => {
                    setRenaming(false);
                    rename.onSave(n);
                  }}
                  onCancel={() => {
                    setRenaming(false);
                    onCancelRename?.();
                  }}
                  className="text-[19px] leading-[24px] h-[28px] font-semibold"
                  style={{ fontFamily: displayFont, letterSpacing: '-0.02em' }}
                />
              ) : (
                <>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle();
                    }}
                    aria-expanded={open}
                    aria-controls={bodyId}
                    title={rename && title !== rename.original ? `Folder: ${rename.original}` : undefined}
                    className="flex items-center gap-1.5 min-w-0 text-left rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]"
                  >
                    <h2
                      className="text-[19px] leading-[24px] font-semibold text-white truncate"
                      style={{ fontFamily: displayFont, letterSpacing: '-0.02em' }}
                    >
                      {title}
                    </h2>
                    <span className="flex-shrink-0 opacity-40 group-hover:opacity-80 transition-opacity text-white">
                      <Chevron open={open} />
                    </span>
                  </button>
                  {rename && <RenameButton label={title} onClick={() => setRenaming(true)} />}
                </>
              )}
            </span>
            <span className="mt-0.5 flex items-center text-[13px] leading-[18px] min-w-0" style={{ color: ios.secondary }}>
              {status}
            </span>
          </span>
        </div>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            title={action.title || action.label}
            aria-label={action.label}
            // Just a +, so the stack's name keeps the room; the tooltip says what it adds
            className="inline-flex flex-shrink-0 items-center justify-center w-8 h-8 rounded-full transition-colors hover:brightness-125 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]"
            style={{ background: 'rgba(118,118,128,0.16)', boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.9)' }}
          >
            <PlusGlyph size={13} />
          </button>
        )}
        {onDetails && (
          <button
            type="button"
            onClick={onDetails}
            title="Details"
            aria-label={`Details for ${title}`}
            className="inline-flex flex-shrink-0 items-center justify-center w-8 h-8 rounded-full transition-colors hover:brightness-125 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]"
            style={{ background: 'rgba(118,118,128,0.16)', boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.9)' }}
          >
            <InfoGlyph />
          </button>
        )}
        {!onDetails && menu && menu.length > 0 && (
          <MenuButton
            look="bare"
            label={<MoreGlyph />}
            ariaLabel={`More for ${title}`}
            title="More"
            items={rename ? [{ key: '__rename', label: 'Rename', onSelect: () => setRenaming(true) }, ...menu.map((m, i) => (i === 0 ? { ...m, divider: true } : m))] : menu}
            className="flex-shrink-0 w-9 h-9 rounded-full inline-flex items-center justify-center text-white/70 hover:text-white hover:bg-white/[0.08] focus-visible:outline-2 focus-visible:outline-[#0A84FF]"
          />
        )}
      </header>
      {open && (
        <div id={bodyId} className="flex-1 flex flex-col px-3 pb-3 sm:px-4 sm:pb-4">
          {children}
        </div>
      )}
    </section>
  );
};

/**
 * Stacks fit together like tiles on a grid, and every app card is the same size everywhere:
 *
 * - The number of columns comes from the real width, so a card is never narrower than MIN_COL.
 * - A layout solver tries arrangements and keeps the tightest: no gaps between stacks (any leftover space
 *   only at the very end), then as few rows as possible. To get there a stack may take another shape
 *   (its apps stacked in 2 or 3 lines, or a little wider, up to 1.5 × card width), and stacks may swap places.
 * - Stacks stay where they were unless moving them closes a gap, and otherwise go in name order.
 * - When stacks grow or shrink, or the window changes, it solves again and everything glides into place.
 * - Stacks sharing a row line up to the same height.
 */
const MIN_COL = 320; // narrowest app card column, px (a one-app stack's name, + and ⓘ still fit)
const GAP = 16;

/** Columns (app cards across) for the panel a TileGrid is in; set by ShelfGrid */
const CellCols = React.createContext<number | null>(null);

/** A stack's spot: grid cell, its size in columns × rows, and how many app cards go across inside it */
type Place = { i: number; col: number; row: number; w: number; h: number; cols: number };
type Shape = { w: number; h: number; cols: number; pen: number };

/** The shapes a stack may take, each with a small cost so the usual shape wins when it fits as well */
function shapesFor(n: number, C: number): Shape[] {
  const m = Math.max(1, n);
  const out: Shape[] = [];
  const add = (w: number, h: number, cols: number, pen: number) => {
    if (w >= 1 && w <= C && !out.some((x) => x.w === w && x.h === h)) out.push({ w, h, cols, pen });
  };
  if (m <= C) add(m, 1, m, 0);
  else {
    // More apps than columns: as wide as possible first; a narrower shape may leave a few empty spots inside it
    const minW = Math.max(1, Math.ceil(m / Math.max(3, Math.ceil(m / C))));
    for (let w = C; w >= minW; w--) {
      const h = Math.ceil(m / w);
      add(w, h, w, (w * h - m) * 2 + (C - w));
    }
  }
  // Its apps in 2 or 3 lines, with no empty spots
  for (let w = Math.min(C, m); w >= 1; w--) {
    const h = Math.ceil(m / w);
    if (w * h === m && h > 1 && h <= 3) add(w, h, w, 3 * (h - 1));
  }
  // A little wider than its apps (cards up to 1.5 × as wide), to close a gap
  if (m <= C) for (let w = m + 1; w <= Math.min(C, Math.floor(m * 1.5)); w++) add(w, 1, m, 4 * (w - m));
  return out;
}

/**
 * Tries arrangements (filling the first empty cell each time, with every stack and shape that fits there, or
 * leaving it empty) and keeps the best: gaps before the last row cost the most, then rows, then unusual shapes,
 * then stacks that left their previous spot, then name order. Stops after a few dozen milliseconds with the
 * best found so far.
 */
function solveLayout(apps: number[], C: number, prev: ({ row: number; col: number } | undefined)[], budgetMs = 60): Place[] {
  const n = apps.length;
  if (!n) return [];
  const shapes = apps.map((a) => shapesFor(a, C));
  const grid: (boolean | 'skip')[][] = [];
  const at = (r: number, c: number) => grid[r]?.[c];
  const set = (r: number, c: number, w: number, h: number, v: boolean) => {
    for (let y = r; y < r + h; y++) {
      grid[y] = grid[y] || Array(C).fill(false);
      for (let x = c; x < c + w; x++) grid[y][x] = v;
    }
  };
  const fits = (r: number, c: number, w: number, h: number) => {
    if (c + w > C) return false;
    for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) if (at(y, x)) return false;
    return true;
  };
  const tryOrder = apps.map((_, i) => i).sort((a, b) => Math.max(1, apps[b]) - Math.max(1, apps[a]) || a - b);
  const used = Array(n).fill(false);
  const cur: Place[] = [];
  let best: Place[] | null = null;
  let bestCost = Infinity;
  const t0 = Date.now();
  let nodes = 0;
  let out = false;
  const leaf = (pen: number) => {
    let rows = 0;
    for (let y = 0; y < grid.length; y++) if (grid[y]?.some((x) => x === true)) rows = y + 1;
    let gaps = 0;
    for (let y = 0; y < rows - 1; y++) for (let x = 0; x < C; x++) if (grid[y][x] !== true) gaps++;
    const order = cur.slice().sort((a, b) => a.row - b.row || a.col - b.col);
    let disorder = 0;
    order.forEach((p, k) => (disorder += Math.abs(p.i - k)));
    let moved = 0;
    for (const p of cur) {
      const q = prev[p.i];
      if (q && (q.row !== p.row || q.col !== p.col)) moved++;
    }
    const cost = gaps * 1000 + rows * 40 + pen * 5 + moved * 8 + disorder;
    if (cost < bestCost) {
      bestCost = cost;
      best = cur.map((p) => ({ ...p }));
    }
  };
  const skipsIn = (r: number) => (grid[r] || []).filter((x) => x === 'skip').length;
  const dfs = (r: number, c: number, placed: number, pen: number, certainGaps: number) => {
    if (++nodes % 256 === 0 && Date.now() - t0 > budgetMs) out = true;
    if (out && best) return;
    if (placed === n) return leaf(pen);
    while (at(r, c)) {
      c++;
      if (c >= C) {
        c = 0;
        r++;
      }
    }
    if (certainGaps * 1000 + pen * 5 + (r + 1) * 40 >= bestCost) return;
    for (const i of tryOrder) {
      if (used[i]) continue;
      for (const s of shapes[i]) {
        if (!fits(r, c, s.w, s.h)) continue;
        used[i] = true;
        set(r, c, s.w, s.h, true);
        cur.push({ i, row: r, col: c, w: s.w, h: s.h, cols: s.cols });
        dfs(r, c, placed + 1, pen + s.pen, certainGaps);
        cur.pop();
        set(r, c, s.w, s.h, false);
        used[i] = false;
        if (out && best) return;
      }
    }
    // Or leave this cell empty: a gap, unless it ends up in the last row
    grid[r] = grid[r] || Array(C).fill(false);
    grid[r][c] = 'skip';
    const nr = c + 1 >= C ? r + 1 : r;
    dfs(nr, c + 1 >= C ? 0 : c + 1, placed, pen, certainGaps + (nr > r ? skipsIn(r) : 0));
    grid[r][c] = false;
  };
  dfs(0, 0, 0, 0, 0);
  return best || [];
}

// The last arrangement for the same stacks and columns: re-renders (status updates) don't solve again
let solved: { key: string; places: Place[] } | null = null;
// Where each stack was last (by its id), so stacks stay put unless moving closes a gap
const lastSpot = new Map<string, { row: number; col: number }>();

function placeStacks(apps: number[], C: number, ids: string[]): Place[] {
  const key = C + '|' + ids.map((id, k) => `${id}:${apps[k]}`).join(',');
  if (solved?.key === key) return solved.places;
  const places = solveLayout(apps, C, ids.map((id) => lastSpot.get(id + '@' + C)));
  for (const p of places) lastSpot.set(ids[p.i] + '@' + C, { row: p.row, col: p.col });
  solved = { key, places };
  return places;
}

/**
 * Gliding (FLIP): after the stacks re-fit, each stack and app card starts where it was and glides to its
 * new place, so you can follow what moved. An app moved to another stack flies across from the old one.
 * Positions are remembered by name (stack:…, app:…), so this works even though React draws the moved card anew.
 * Only when the arrangement really changes (apps added, moved or removed, or a different number of columns);
 * a status update or a small window drag doesn't animate. Off for people who ask for reduced motion.
 */
const lastSeen = new Map<string, { x: number; y: number; at: number }>();
function useGlide(container: React.RefObject<HTMLElement | null>, signature: string, zoom = 1, paused = false) {
  const prevSig = useRef<string | null>(null);
  useLayoutEffect(() => {
    const root = container.current;
    // While the size is worked out (before anything is drawn), wait: then glide from where things were
    // to where they end up, not through the sizes tried on the way
    if (!root || paused) return;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const animate = prevSig.current !== null && prevSig.current !== signature && !reduce;
    prevSig.current = signature;
    const now = Date.now();
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-flip]'));
    // A name shown twice (two stacks with the same service name) can't be followed: leave those be
    const count = new Map<string, number>();
    for (const n of nodes) count.set(n.dataset.flip!, (count.get(n.dataset.flip!) || 0) + 1);
    // First where everything was and is, then glide; a card inside a moving stack only glides by the
    // difference, because it already moves with its stack
    const deltas = new Map<HTMLElement, { dx: number; dy: number }>();
    for (const n of nodes) {
      const id = n.dataset.flip!;
      if (count.get(id)! > 1) continue;
      const r = n.getBoundingClientRect();
      // A card you're pointing at is drawn bigger around its middle: measure where it really sits
      let left = r.left, top = r.top;
      if (n.hasAttribute('data-lift')) {
        const cs = getComputedStyle(n);
        const sc = cs.scale && cs.scale !== 'none' ? parseFloat(cs.scale) : 1;
        if (sc && sc !== 1) {
          const [ox, oy] = cs.transformOrigin.split(' ').map((v) => parseFloat(v) || 0);
          left -= ox * zoom * (1 - sc);
          top -= oy * zoom * (1 - sc);
        }
      }
      const pos = { x: left + window.scrollX, y: top + window.scrollY, at: now };
      const before = lastSeen.get(id);
      lastSeen.set(id, pos);
      if (!animate || !before || now - before.at > 5 * 60 * 1000) continue;
      deltas.set(n, { dx: before.x - pos.x, dy: before.y - pos.y });
    }
    for (const [n, d] of deltas) {
      const parent = n.parentElement?.closest<HTMLElement>('[data-flip]');
      const pd = parent ? deltas.get(parent) : undefined;
      // Measured on screen; inside a zoomed-out dashboard, moves are drawn at that zoom
      const dx = (d.dx - (pd?.dx || 0)) / zoom, dy = (d.dy - (pd?.dy || 0)) / zoom;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
      const isApp = n.dataset.flip!.startsWith('app:');
      // Apps that change stacks travel further: a touch longer, lifted above the rest while they fly
      const far = Math.hypot(dx, dy) * zoom > 400;
      n.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)${isApp && far ? ' scale(1.03)' : ''}`, zIndex: isApp ? 30 : 1 },
          { transform: 'translate(0, 0)', zIndex: isApp ? 30 : 1 },
        ],
        { duration: far ? 650 : 480, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
      );
    }
  });
}

/** Overview: app cards show just their icon, name and status (set by ShelfGrid) */
export const CompactCards = React.createContext(false);

/** Comfortable: designed size, a little bigger when there's room. Overview: simple cards, a little smaller to fit. */
const SIZES = { comfortable: { max: 1.12, min: 1 }, overview: { max: 1, min: 0.85 } } as const;
export type DashboardView = keyof typeof SIZES;

/**
 * The dashboard's stacks, in one of two views:
 *  - Comfortable (the default): full cards at an easy-to-read size, a little bigger when there's room and
 *    never smaller than the size they were designed at; past that, it scrolls.
 *  - Overview: every stack at once, with simple cards (icon, name, status) so the text stays readable.
 * On a computer, dragging an app while some stacks are off screen switches to Overview for the drag, and
 * back a moment after it lands, so you see it arrive.
 */
export const ShelfGrid: React.FC<{ children: React.ReactNode; view?: DashboardView; fit?: boolean; dragOverview?: boolean }> = ({
  children,
  view = 'comfortable',
  fit = false,
  dragOverview = false,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  // The room on screen, measured outside the zoom; zoomed out, the dashboard gets 1/zoom times as much
  const outer = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => (typeof window !== 'undefined' ? Math.min(window.innerWidth - 32, 1232) : 1232));
  const [vh, setVh] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 900));
  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width);
      setWidth((cur) => (cur === w ? cur : w));
    });
    ro.observe(el);
    const onResize = () => setVh(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, []);

  // Dragging an app with stacks off screen: Overview until it has landed
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragOverview) return;
    const root = outer.current;
    if (!root) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    let dropped = false;
    const start = (e: DragEvent) => {
      // An app card (its own handler runs after this one, so look at what's being dragged)
      if (!(e.target as HTMLElement)?.closest?.('[data-lift][draggable="true"]')) return;
      dropped = false;
      clearTimeout(t);
      const hidden = Array.from(ref.current?.querySelectorAll<HTMLElement>('[data-flip^="stack:"]') || []).some((el) => {
        const r = el.getBoundingClientRect();
        return r.top < 0 || r.bottom > window.innerHeight;
      });
      // Changing the page during dragstart can cancel the drag in some browsers: a moment later
      if (hidden) t = setTimeout(() => setDragging(true), 0);
    };
    const back = (delay: number) => {
      clearTimeout(t);
      t = setTimeout(() => setDragging(false), delay);
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
      dropped = true;
      // Stay a moment: the app lands and the stacks settle into place, then back
      back(1400);
    };
    const onEnd = () => {
      if (!dropped) back(0);
      dropped = false;
    };
    root.addEventListener('dragstart', start);
    document.addEventListener('drop', onDrop, true);
    document.addEventListener('dragend', onEnd, true);
    return () => {
      clearTimeout(t);
      root.removeEventListener('dragstart', start);
      document.removeEventListener('drop', onDrop, true);
      document.removeEventListener('dragend', onEnd, true);
    };
  }, [dragOverview]);
  const shown: DashboardView = dragging ? 'overview' : view;
  const compact = shown === 'overview';
  const size = SIZES[shown];

  // Sizing: try the biggest first and step down until every stack is on screen, or the smallest readable size
  // is reached (then it scrolls). Worked out before the screen is drawn, so nothing flickers.
  const [zoom, setZoom] = useState<number>(size.min);
  const searching = useRef(false);
  const [, settle] = useState(0);
  const contentKey = React.Children.toArray(children)
    .map((c) => (React.isValidElement(c) ? `${c.key}:${(c.props as { span?: number }).span ?? ''}` : ''))
    .join(',');
  const fitKey = `${shown}|${fit}|${width}|${vh}|${contentKey}`;
  const lastKey = useRef<string | null>(null);
  if (lastKey.current !== fitKey) {
    lastKey.current = fitKey;
    // A phone: the designed size in both views (the simple cards are what make Overview shorter there)
    const startAt = fit ? size.max : 1;
    searching.current = fit;
    if (zoom !== startAt) setZoom(startAt);
  }
  const items = React.Children.toArray(children).filter(React.isValidElement) as React.ReactElement<{ span?: number; id?: string }>[];
  const C = Math.max(1, Math.floor((width / zoom + GAP) / (MIN_COL + GAP)));
  // "Not in a Stack" isn't a stack: it sits on its own at the bottom, full width, and never changes how the stacks fit
  // Stacks by name (numbers in order), so they stay put; a stack still being named comes first
  const stacks = items
    .filter((c) => c.props.id !== 'stack:none')
    .sort((a, b) => {
      const ta = a.props.id === 'stack:__new' ? '' : String((a.props as { title?: string }).title || '');
      const tb = b.props.id === 'stack:__new' ? '' : String((b.props as { title?: string }).title || '');
      return ta.localeCompare(tb, undefined, { numeric: true, sensitivity: 'base' });
    });
  const loose = items.filter((c) => c.props.id === 'stack:none');
  const places = placeStacks(
    stacks.map((c) => Math.max(0, c.props.span ?? 1)),
    C,
    stacks.map((c) => String(c.props.id ?? c.key))
  );
  // What the arrangement is: columns, and each stack's place, size and apps (not their status)
  const signature = C + '|' + places.map((p) => `${stacks[p.i].key}@${p.col},${p.row},${p.w}x${p.h}:${stacks[p.i].props.span}`).join(';') + '|' + loose.map((c) => c.props.span).join(',');
  useGlide(ref, signature, zoom, searching.current);
  useLayoutEffect(() => {
    if (!searching.current || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    // Fits: every stack in view once you've scrolled down to them
    if (r.height > window.innerHeight - 32 && zoom > size.min + 0.001) setZoom((z) => Math.max(size.min, Math.round((z - 0.04) * 100) / 100));
    else {
      searching.current = false;
      settle((n) => n + 1);
    }
  });
  return (
    // Drawn a little smaller, more columns fit and the stacks re-fit (and glide) to them
    <div ref={outer}>
    <CompactCards.Provider value={compact}>
    <div
      ref={ref}
      data-zoom={zoom}
      className="flex flex-col gap-3 sm:gap-4"
      // How much an app card grows when you point at it: a gentle lift (a simple card grows a little more)
      style={{ ...(zoom !== 1 ? { zoom } : null), ['--mfx-lift' as string]: compact ? '1.08' : '1.04' } as React.CSSProperties}
    >
      <div className="grid gap-3 sm:gap-4" style={{ gridTemplateColumns: `repeat(${C}, minmax(0, 1fr))` }}>
        {places.map(({ i, col, row, w, h, cols }) => (
          <div
            key={stacks[i].key ?? i}
            data-flip={`stack:${stacks[i].props.id ?? stacks[i].key}`}
            className="mfx-lift-host flex flex-col min-w-0"
            style={{ gridColumn: `${col + 1} / span ${w}`, gridRow: `${row + 1} / span ${h}` }}
          >
            <CellCols.Provider value={cols}>{stacks[i]}</CellCols.Provider>
          </div>
        ))}
      </div>
      {loose.map((c, i) => (
        <div key={c.key ?? `loose${i}`} className="mfx-lift-host flex flex-col min-w-0 mt-2 sm:mt-3">
          <CellCols.Provider value={C}>{c}</CellCols.Provider>
        </div>
      ))}
    </div>
    </CompactCards.Provider>
    </div>
  );
};

/** How many app columns a panel with this many apps asks for (the grid decides how many fit) */
export const shelfSpan = (apps: number) => Math.max(0, Math.min(8, apps));

const COLS_CLASS: Record<number, string> = { 1: '', 2: 'md:grid-cols-2', 3: 'md:grid-cols-2 lg:grid-cols-3' };

/** The grid of app cards inside a panel: as many columns as its place in the ShelfGrid gives it */
export const TileGrid: React.FC<{ span?: number; children: React.ReactNode }> = ({ span = 3, children }) => {
  const cols = React.useContext(CellCols);
  if (cols)
    return (
      // Fills the panel: when it's taller than its apps (beside stacked neighbours), the space is shared evenly
      <div className="flex-1 grid gap-2.5 sm:gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, alignContent: 'space-evenly' }}>
        {children}
      </div>
    );
  return <div className={`grid grid-cols-1 ${COLS_CLASS[span] ?? COLS_CLASS[3]} gap-2.5 sm:gap-3`}>{children}</div>;
};

/** A calm one-line message inside a panel (an empty stack or group) */
export const ShelfNote: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="rounded-[16px] px-4 py-5 text-center text-[14px] leading-[20px]" style={{ background: 'rgba(255,255,255,0.05)', color: ios.secondary }}>
    {children}
  </div>
);

// ----------------------------------------------------------------------------
// Section bar
// ----------------------------------------------------------------------------

type Filter = 'all' | 'running' | 'stopped';

/** One quiet number on the section bar: a dot, the count and a word. Tapping it filters (or opens). */
const Stat: React.FC<{
  value?: number;
  word: string;
  dot?: string;
  active?: boolean;
  tip: string;
  onClick?: () => void;
}> = ({ value, word, dot, active, tip, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    title={tip}
    aria-pressed={active}
    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[13px] transition-colors hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]"
    style={
      active
        ? { background: 'rgba(10,132,255,0.16)', boxShadow: 'inset 0 0 0 0.5px rgba(10,132,255,0.55)', color: '#6CB6FF' }
        : { color: ios.secondary }
    }
  >
    {dot && <span className="w-[7px] h-[7px] rounded-full flex-shrink-0" style={{ background: dot }} aria-hidden />}
    <span className="font-semibold tabular-nums" style={{ color: active ? '#fff' : 'rgba(255,255,255,0.92)' }}>
      {value ?? '…'}
    </span>
    <span>{word}</span>
    {active && (
      <span className="ml-0.5 text-[11px] opacity-80" aria-hidden>
        ✕
      </span>
    )}
  </button>
);

/**
 * The break between the header and the stacks: a quiet "Your Stacks" label and a hairline, and on its
 * right the numbers that describe what's below: how many apps are running and stopped (tap one to
 * show only those, tap it again for all) and how many ports are in use (tap to see them). Search and
 * New Stack live in the header. With groups shown, the label becomes Stacks | Groups to tap between.
 */
export const LibraryBar: React.FC<{
  /** Off: just the Your Stacks label, no Groups to switch to */
  showGroups?: boolean;
  view: 'compose' | 'groups';
  onView: (v: 'compose' | 'groups') => void;
  /** How many stacks are shown */
  count?: number;
  filter: Filter;
  onFilter: (f: Filter) => void;
  running?: number;
  stopped?: number;
  ports?: number;
  onShowPorts?: () => void;
  /** Group actions (New Group, Edit Groups), while groups are shown */
  groupItems?: MenuItem[];
  /** Comfortable (full cards) or Overview (every stack at once, simple cards) */
  dashboardView?: DashboardView;
  onDashboardView?: (v: DashboardView) => void;
}> = ({ showGroups = false, view, onView, count, filter, onFilter, running, stopped, ports, onShowPorts, groupItems = [], dashboardView, onDashboardView }) => {
  const label = 'text-[12px] font-semibold uppercase tracking-[0.08em]';
  const toggle = (f: Filter) => onFilter(filter === f ? 'all' : f);
  const tab = (v: 'compose' | 'groups', text: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === v}
      onClick={() => onView(v)}
      className={`${label} rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]`}
      style={{ color: view === v ? 'rgba(255,255,255,0.9)' : 'rgba(235,235,245,0.35)' }}
    >
      {text}
    </button>
  );
  return (
    <div className="mt-3 mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 min-h-[28px]" style={{ fontFamily: ios.font }}>
      {showGroups ? (
        <div role="tablist" aria-label="Arrange apps" className="flex items-center gap-4 flex-shrink-0">
          {tab('compose', 'Stacks')}
          {tab('groups', 'Groups')}
        </div>
      ) : (
        <h2 className={`${label} flex-shrink-0 flex items-center gap-2`} style={{ color: 'rgba(235,235,245,0.6)' }}>
          Your Stacks
          {count !== undefined && (
            <span className="tabular-nums font-medium normal-case tracking-normal px-1.5 rounded-full text-[11.5px] leading-[18px]" style={{ background: 'rgba(118,118,128,0.2)', color: 'rgba(235,235,245,0.7)' }}>
              {count}
            </span>
          )}
        </h2>
      )}
      <div className="flex-1 min-w-6 h-px" style={{ background: 'linear-gradient(90deg, rgba(255,255,255,0.14), rgba(255,255,255,0.03))' }} aria-hidden />
      <div className="flex items-center gap-0.5 -mr-2.5 max-sm:w-full max-sm:-ml-2.5" role="group" aria-label="Your apps">
        <Stat
          value={running}
          word="Running"
          dot={ios.green}
          active={filter === 'running'}
          tip={filter === 'running' ? 'Showing only running apps. Click to show all.' : 'Show only the apps that are running'}
          onClick={() => toggle('running')}
        />
        <Stat
          value={stopped}
          word="Stopped"
          dot={stopped ? '#FF9F0A' : '#8E8E93'}
          active={filter === 'stopped'}
          tip={filter === 'stopped' ? 'Showing only stopped apps. Click to show all.' : 'Show only the apps that aren’t running'}
          onClick={() => toggle('stopped')}
        />
        <span className="w-px h-3.5 mx-1" style={{ background: 'rgba(255,255,255,0.12)' }} aria-hidden />
        <Stat value={ports} word={ports === 1 ? 'Port' : 'Ports'} tip="Ports in use on your server. Click to see which app uses each one." onClick={onShowPorts} />
        {onDashboardView && dashboardView && (
          <>
            <span className="w-px h-3.5 mx-1" style={{ background: 'rgba(255,255,255,0.12)' }} aria-hidden />
            {/* Two views, one capsule: full cards, or every stack at once (O switches too) */}
            <div role="radiogroup" aria-label="View" className="flex items-center p-0.5 rounded-full" style={{ background: 'rgba(118,118,128,0.16)' }}>
              {(
                [
                  ['comfortable', 'Comfortable', 'Full cards at an easy-to-read size', <path key="c" d="M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h7v6h-7z" />],
                  ['overview', 'Overview', 'Every stack at once, with simple cards. Press O to switch.', <path key="o" d="M4 5h4v3H4zM10 5h4v3h-4zM16 5h4v3h-4zM4 10.5h4v3H4zM10 10.5h4v3h-4zM16 10.5h4v3h-4zM4 16h4v3H4zM10 16h4v3h-4zM16 16h4v3h-4z" />],
                ] as const
              ).map(([v, word, tip, glyph]) => {
                const on = dashboardView === v;
                return (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={word}
                    onClick={() => onDashboardView(v)}
                    data-tip={tip}
                    className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-[12.5px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]"
                    style={{ color: on ? '#fff' : 'rgba(235,235,245,0.6)', background: on ? 'rgba(255,255,255,0.14)' : undefined, boxShadow: on ? 'inset 0 0.5px 0 rgba(255,255,255,0.2)' : undefined }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
                      {glyph}
                    </svg>
                    <span className="max-sm:hidden">{word}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
      {showGroups && groupItems.length > 0 && (
        <MenuButton
          look="bare"
          ariaLabel="Groups"
          title="New or Edit Groups"
          items={groupItems}
          label={<PlusGlyph size={15} />}
          className="flex-shrink-0 w-7 h-7 rounded-full inline-flex items-center justify-center text-white/70 hover:text-white hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]"
        />
      )}
    </div>
  );
};
