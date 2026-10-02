import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DeepContainerMetadata } from '../types';
import { CountTo } from './ui/LiquidGlass';
import { glideFrom, popIn } from '../motion';
import { AppIcon } from './AppCard';
import { MenuButton, MenuItem, ios } from './ui/ios';

/**
 * The dashboard below the hero, in the hero's style: a section bar under the header and
 * one glass panel per stack or group, with its apps on quiet tiles inside.
 */

/** What an app card carries while it's dragged to another stack */
export const DRAG_TYPE = 'application/x-manifexus-app';

export const displayFont = 'var(--mfx-sans)';

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
/** A callback ref: the element gets a tooltip with the full text only while its text is cut short */
function useTruncationTip(text: string) {
  const ro = useRef<ResizeObserver | null>(null);
  useEffect(() => () => ro.current?.disconnect(), []);
  return React.useCallback(
    (el: HTMLElement | null) => {
      ro.current?.disconnect();
      if (!el || typeof ResizeObserver === 'undefined') return;
      const check = () => (el.scrollWidth > el.clientWidth + 1 ? el.setAttribute('data-tip', text) : el.removeAttribute('data-tip'));
      ro.current = new ResizeObserver(check);
      ro.current.observe(el);
      check();
    },
    [text]
  );
}

export const RenameButton: React.FC<{ label: string; onClick: () => void; group?: 'head' | 'card' }> = ({ label, onClick, group = 'head' }) => (
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation();
      onClick();
    }}
    title="Rename"
    aria-label={`Rename ${label}`}
    // Takes no room until you point at it (or tab to it), so a name in a narrow stack keeps all the space it can
    className={`flex-shrink-0 w-0 h-7 -my-1.5 overflow-hidden rounded-full inline-flex items-center justify-center text-white opacity-0 transition-opacity hover:!opacity-100 hover:bg-white/[0.08] focus:outline-none focus-visible:w-7 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[#0A84FF] [@media(hover:none)]:w-7 [@media(hover:none)]:opacity-40 ${
      group === 'head' ? 'group-hover/head:w-7 group-hover/head:opacity-50' : 'group-hover/card:w-7 group-hover/card:opacity-50'
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
      className={`w-full min-w-0 -mx-1.5 px-1.5 rounded-[8px] bg-white/[0.08] text-white outline-none ring-2 ring-[#0A84FF]/70 placeholder:text-white/45 ${className}`}
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
  if (!apps.length) return <span style={{ color: ios.secondary }}>{empty}</span>;
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
  // A stack settles in when it first appears
  const self = useRef<HTMLElement>(null);
  useEffect(() => popIn(self.current), []);
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
  // A name cut short (a narrow stack) shows in full when you point at it
  const fullNameTip = useTruncationTip(title);
  return (
    <section
      ref={self}
      // Settles in when it first appears; glows blue while an app is dragged over it
      className={`mfx-specular rounded-[22px] min-w-0 transition-shadow duration-200 ${open ? 'flex-1 flex flex-col' : ''}`}
      // Light on glass: a soft highlight follows the pointer across the stack (set straight on the element, no re-render)
      onPointerMove={(e) => {
        if (e.pointerType !== 'mouse') return;
        const r = e.currentTarget.getBoundingClientRect();
        e.currentTarget.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
        e.currentTarget.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
      }}
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
                  className="text-[20px] leading-[24px] h-[28px] font-semibold"
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
                      ref={fullNameTip}
                      className="text-[20px] leading-[24px] font-semibold text-white truncate"
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
        // A message (an empty stack) sits in the middle when its stack grows to close a gap
        <div id={bodyId} className="flex-1 flex flex-col justify-center px-3 pb-3 sm:px-4 sm:pb-4">
          {children}
        </div>
      )}
    </section>
  );
};

/**
 * Stacks fit together like puzzle pieces, and every app card stays a comfortable, readable size:
 *
 * - The number of columns comes from the real width, so a card is never narrower than MIN_COL.
 * - Each stack's real height is measured, so pieces sit exactly on top of each other: a tall stack beside
 *   short ones never leaves empty space inside it or around it.
 * - A solver tries many arrangements (a beam search over the skyline: always filling the lowest spot next)
 *   and keeps the most even one. To get there a stack may change shape (its apps in more or fewer lines,
 *   or a little wider, up to twice a card's width) and stacks may swap places.
 * - A small gap left under a stack is closed by letting that stack grow a little (its cards spread out
 *   evenly, never stretched), so the dashboard ends in a clean, even edge.
 * - Stacks stay roughly in name order and where they were, unless moving them makes things fit better.
 * - When stacks grow or shrink, fold, or the window changes, it measures and solves again and everything
 *   glides into place.
 */
const MIN_COL = 320; // narrowest app card column, px (a one-app stack's name, + and ⓘ still fit)
const GAP = 16;

/** Columns (app cards across) for the panel a TileGrid is in; set by ShelfGrid */
const CellCols = React.createContext<number | null>(null);

/** A stack's shape: columns wide, lines of app cards, cards across, a cost for being unusual, empty card spots */
type Shape = { w: number; h: number; cols: number; pen: number; empty: number };
/** A stack's spot: column, top (px), size, and how much it grows to close a gap below it */
type Place = { i: number; col: number; top: number; w: number; h: number; cols: number; H: number; grow: number };

/** The shapes a stack may take; its usual shape costs nothing, others cost a little so they're used only when they help */
function shapesFor(n: number, C: number): Shape[] {
  if (n <= 0) {
    // An empty stack (just a message): one column, or two to close a gap
    const out: Shape[] = [{ w: 1, h: 0, cols: 1, pen: 0, empty: 0 }];
    if (C >= 2) out.push({ w: 2, h: 0, cols: 1, pen: 5, empty: 0 });
    return out;
  }
  const natW = Math.min(n, C);
  const natH = Math.ceil(n / natW);
  const out: Shape[] = [];
  for (let w = 1; w <= Math.min(C, 2 * n); w++) {
    if (w <= n) {
      const h = Math.ceil(n / w);
      // Never a long thin strip
      if (h > Math.max(3, natH + 1)) continue;
      out.push({ w, h, cols: w, pen: 2 * (natW - w), empty: w * h - n });
    } else {
      // Wider than its apps: the same cards, a little wider (up to twice as wide)
      out.push({ w, h: 1, cols: n, pen: Math.max(1, Math.round((6 * (w - n)) / n)), empty: 0 });
    }
  }
  return out;
}

/** What a stack measures: its height for a shape is base + lines × step (exact heights win once seen) */
type Model = { base: number; step: number; folded: boolean; exact: Map<string, number> };
const models = new Map<string, Model>();
let modelGen = 0;
const shapeKey = (s: { w: number; h: number }, colW: number, folded: boolean) => `${s.w}x${s.h}@${Math.round(colW / 8)}${folded ? 'f' : ''}`;

function heightOf(id: string, n: number, s: Shape, colW: number): number {
  const md = models.get(id);
  if (md) {
    const ex = md.exact.get(shapeKey(s, colW, md.folded));
    if (ex) return ex;
    return Math.round(md.base + (md.folded ? 0 : s.h * md.step));
  }
  // A first guess before anything is measured (corrected before it's drawn)
  return n > 0 ? 92 + s.h * 128 : 172;
}

// How much each kind of untidiness costs; empty space costs the most
const W_HOLE = 10; // per px of empty space, per column
const W_GROW = 2; // per px a stack grows to close a gap
const W_HEIGHT = 3; // per px of total height
const W_SHAPE = 120; // per point of an unusual shape
const W_ORDER = 40; // per place away from name order
const W_MOVED = 40; // per stack that changes column

type Piece = { i: number; id: string; n: number; shapes: (Shape & { H: number; maxGrow: number })[]; rank: number };
/** A partial arrangement; the stacks placed so far are a chain back through `from` (nothing is copied) */
type State = {
  sky: number[]; // next free y in each column
  room: number[]; // how much the lowest stack in each column may still grow
  next: number[]; // per kind of stack, how many are placed
  from: State | null;
  last: Place | null;
  cost: number;
  filled: number; // area covered so far (px²), for the height estimate
  area: number; // area still to place (each stack's smallest shape)
  top: number; // highest column so far
};
type Move = { st: State; k: number; s: Piece['shapes'][number]; p: Piece; start: number; y: number; cost: number; score: number };

/** A heap with the highest score on top, so the worst of the kept moves is dropped first */
function heapPush(h: Move[], m: Move) {
  h.push(m);
  for (let i = h.length - 1; i > 0; ) {
    const up = (i - 1) >> 1;
    if (h[up].score >= h[i].score) break;
    [h[up], h[i]] = [h[i], h[up]];
    i = up;
  }
}
function heapReplace(h: Move[], m: Move) {
  h[0] = m;
  for (let i = 0; ; ) {
    const l = 2 * i + 1;
    const r = l + 1;
    let big = i;
    if (l < h.length && h[l].score > h[big].score) big = l;
    if (r < h.length && h[r].score > h[big].score) big = r;
    if (big === i) break;
    [h[big], h[i]] = [h[i], h[big]];
    i = big;
  }
}

/**
 * Fills the dashboard from the top, always at the lowest spot, trying every stack (in each of its shapes and
 * positions) there and keeping the best arrangements at each step (a beam search); then picks the finished
 * arrangement that leaves the least empty space. The same input always gives the same layout.
 */
function solveLayout(pieces: Piece[], C: number, colW: number, prev: ({ col: number } | undefined)[]): Place[] {
  const n = pieces.length;
  if (!n) return [];
  // Stacks that are alike (same shapes and heights) are interchangeable: place them in name order
  const kinds: Piece[][] = [];
  const kindKey = new Map<string, number>();
  for (const p of pieces) {
    const k = p.shapes.map((s) => `${s.w}.${s.h}.${s.H}`).join(',');
    if (!kindKey.has(k)) {
      kindKey.set(k, kinds.length);
      kinds.push([]);
    }
    kinds[kindKey.get(k)!].push(p);
  }
  const unit = colW + GAP;
  const smallest = pieces.map((p) => Math.min(...p.shapes.map((s) => s.w * unit * (s.H + GAP))));
  const minArea = (p: Piece) => smallest[p.i];
  const width = C * unit;
  const BEAM = 200;
  const LIMIT = BEAM * 3;
  let beam: State[] = [
    { sky: Array(C).fill(0), room: Array(C).fill(0), next: kinds.map(() => 0), from: null, last: null, cost: 0, filled: 0, area: pieces.reduce((t, p) => t + minArea(p), 0), top: 0 },
  ];
  for (let step = 0; step < n; step++) {
    const moves: Move[] = [];
    for (const st of beam) {
      // The lowest spot (leftmost if several)
      let c = 0;
      for (let j = 1; j < C; j++) if (st.sky[j] < st.sky[c]) c = j;
      for (let k = 0; k < kinds.length; k++) {
        const p = kinds[k][st.next[k]];
        if (!p) continue;
        const orderCost = Math.abs(p.rank - step) * W_ORDER;
        for (const s of p.shapes) {
          for (let start = Math.max(0, c - s.w + 1); start <= Math.min(c, C - s.w); start++) {
            let y = 0;
            for (let j = start; j < start + s.w; j++) y = Math.max(y, st.sky[j]);
            // The space this leaves above it: closed if the stack above can grow that much, else empty
            let cost = st.cost + s.pen * W_SHAPE + orderCost;
            if (s.empty) cost += s.empty * W_HOLE * (s.H / Math.max(1, s.h));
            const was = prev[p.i];
            if (was && was.col !== start) cost += W_MOVED;
            let added = 0;
            for (let j = start; j < start + s.w; j++) {
              const d = y - st.sky[j];
              if (d > 0) cost += d <= st.room[j] ? d * W_GROW : d * W_HOLE;
              added += y + s.H + GAP - st.sky[j];
            }
            const filled = st.filled + added * unit;
            const area = st.area - minArea(p);
            const est = Math.max(st.top, y + s.H + GAP, (filled + area) / width);
            const score = cost + est * W_HEIGHT * C;
            // Only the best few hundred are kept (a heap with the worst on top)
            if (moves.length < LIMIT) heapPush(moves, { st, k, s, p, start, y, cost, score });
            else if (score < moves[0].score) heapReplace(moves, { st, k, s, p, start, y, cost, score });
          }
        }
      }
    }
    moves.sort((a, b) => a.score - b.score);
    // Keep the best, skipping ones that end up exactly like a better one
    const seen = new Set<string>();
    const nextBeam: State[] = [];
    for (const m of moves) {
      if (nextBeam.length >= BEAM) break;
      const sky = m.st.sky.slice();
      const room = m.st.room.slice();
      for (let j = m.start; j < m.start + m.s.w; j++) {
        sky[j] = m.y + m.s.H + GAP;
        room[j] = m.s.maxGrow;
      }
      const next = m.st.next.slice();
      next[m.k]++;
      const key = sky.join(',') + '|' + next.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      let added = 0;
      for (let j = m.start; j < m.start + m.s.w; j++) added += sky[j] - m.st.sky[j];
      nextBeam.push({
        sky,
        room,
        next,
        from: m.st,
        last: { i: m.p.i, col: m.start, top: m.y, w: m.s.w, h: m.s.h, cols: m.s.cols, H: m.s.H, grow: 0 },
        cost: m.cost,
        filled: m.st.filled + added * unit,
        area: m.st.area - minArea(m.p),
        top: Math.max(m.st.top, m.y + m.s.H + GAP),
      });
    }
    beam = nextBeam;
  }
  // Finish each: close the gaps stacks can grow into, then count what's still empty
  let best: Place[] = [];
  let bestCost = Infinity;
  for (const st of beam) {
    const placed: Place[] = [];
    for (let x: State | null = st; x?.last; x = x.from) placed.push({ ...x.last });
    placed.reverse();
    const bottom = Math.max(...placed.map((p) => p.top + p.H));
    const cols: Place[][] = Array.from({ length: C }, () => []);
    for (const p of placed) for (let j = p.col; j < p.col + p.w; j++) cols[j].push(p);
    for (const list of cols) list.sort((a, b) => a.top - b.top);
    const shapeOf = (p: Place) => pieces[p.i].shapes.find((x) => x.w === p.w && x.h === p.h)!;
    let grown = 0;
    for (const p of placed) {
      let gap = Infinity;
      for (let j = p.col; j < p.col + p.w; j++) {
        const list = cols[j];
        const below = list[list.indexOf(p) + 1];
        gap = Math.min(gap, (below ? below.top - GAP : bottom) - (p.top + p.H));
      }
      if (gap > 0 && gap <= shapeOf(p).maxGrow) {
        p.grow = gap;
        grown += gap;
      }
    }
    // What's still empty, column by column
    let empty = 0;
    for (const list of cols) {
      let y = 0;
      for (const p of list) {
        empty += Math.max(0, p.top - y);
        y = p.top + p.H + p.grow + GAP;
      }
      empty += Math.max(0, bottom + GAP - y);
    }
    let shape = 0;
    let order = 0;
    let moved = 0;
    placed
      .slice()
      .sort((a, b) => a.top - b.top || a.col - b.col)
      .forEach((p, k) => (order += Math.abs(pieces[p.i].rank - k)));
    for (const p of placed) {
      const s = shapeOf(p);
      shape += s.pen;
      empty += s.empty * (s.H / Math.max(1, s.h));
      if (prev[p.i] && prev[p.i]!.col !== p.col) moved++;
    }
    const cost = empty * W_HOLE + grown * W_GROW + bottom * W_HEIGHT * C + shape * W_SHAPE + order * W_ORDER + moved * W_MOVED;
    if (cost < bestCost) {
      bestCost = cost;
      best = placed;
    }
  }
  return best;
}

// The last arrangement for the same stacks, sizes and columns: re-renders (status updates) don't solve again
let solved: { key: string; places: Place[] } | null = null;
// Which column each stack was in last (by its id), so stacks stay put unless moving makes things fit better
const lastSpot = new Map<string, { col: number }>();

function placeStacks(apps: number[], C: number, colW: number, ids: string[]): Place[] {
  const key = `${C}|${Math.round(colW / 8)}|${modelGen}|` + ids.map((id, k) => `${id}:${apps[k]}`).join(',');
  if (solved?.key === key) return solved.places;
  const pieces: Piece[] = ids.map((id, i) => ({
    i,
    id,
    n: apps[i],
    rank: i,
    shapes: shapesFor(apps[i], C).map((s) => {
      const H = heightOf(id, apps[i], s, colW);
      // How much it may grow to close a gap and still look the same (its cards just spread out a little)
      // (a message in an empty stack stays centred, so that one may grow more)
      const maxGrow = Math.round(s.h === 0 ? Math.min(H * 0.5, 96) : Math.min(H * 0.3, 24 + 30 * s.h));
      return { ...s, H, maxGrow };
    }),
  }));
  const places = solveLayout(pieces, C, colW, ids.map((id) => lastSpot.get(id + '@' + C)));
  for (const p of places) lastSpot.set(ids[p.i] + '@' + C, { col: p.col });
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
function useGlide(container: React.RefObject<HTMLElement | null>, signature: string, zoom = 1) {
  const prevSig = useRef<string | null>(null);
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
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
      glideFrom(n, dx, dy, { lift: isApp && far, far });
    }
  });
}


export const ShelfGrid: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const outer = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => (typeof window !== 'undefined' ? Math.min(window.innerWidth - 48, 1712) : 1712));
  const [, remeasure] = useState(0);
  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    // While the window is being resized the stacks simply stretch with it; they re-fit once it settles
    let first = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width);
      clearTimeout(t);
      if (first) setWidth(w);
      else t = setTimeout(() => setWidth((cur) => (cur === w ? cur : w)), 120);
      first = false;
    });
    ro.observe(el);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, []);
  const items = React.Children.toArray(children).filter(React.isValidElement) as React.ReactElement<{ span?: number; id?: string }>[];
  const C = Math.max(1, Math.floor((width + GAP) / (MIN_COL + GAP)));
  const colW = Math.max(1, (width - (C - 1) * GAP) / C);
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
  const ids = stacks.map((c) => String(c.props.id ?? c.key));
  const places = placeStacks(
    stacks.map((c) => Math.max(0, c.props.span ?? 1)),
    C,
    colW,
    ids
  );
  const bottom = places.length ? Math.max(...places.map((p) => p.top + p.H + p.grow)) : 0;
  // What the arrangement is: columns, and each stack's column and shape (not its status, nor pixel sizes,
  // so a window drag or a card growing a little doesn't set everything gliding)
  const signature = C + '|' + places.map((p) => `${stacks[p.i].key}@${p.col}:${p.w}x${p.h}:${stacks[p.i].props.span}`).join(';') + '|' + loose.map((c) => c.props.span).join(',');
  useGlide(ref, signature);

  // Measure each stack's own height (as if it didn't grow); if any differs from what the layout assumed, solve
  // again with the real heights. This happens before the page is drawn, so the first layout is already right.
  const tries = useRef(0);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const wraps = Array.from(root.querySelectorAll<HTMLElement>('[data-pack]'));
    const saved = wraps.map((w) => w.style.height);
    wraps.forEach((w) => (w.style.height = 'auto'));
    const seen = wraps.map((w) => {
      const grid = w.querySelector<HTMLElement>('[data-tilegrid]');
      return {
        N: w.offsetHeight,
        gridH: grid ? grid.offsetHeight : 0,
        gap: grid ? parseFloat(getComputedStyle(grid).rowGap) || 0 : 0,
        folded: Boolean(w.querySelector('header [aria-expanded="false"]')),
      };
    });
    wraps.forEach((w, k) => (w.style.height = saved[k]));
    let changed = false;
    wraps.forEach((w, k) => {
      const p = places[Number(w.dataset.pack)];
      if (!p) return;
      const id = ids[p.i];
      const { N, gridH, gap, folded } = seen[k];
      if (!N) return;
      const md = models.get(id) || { base: N, step: 0, folded, exact: new Map<string, number>() };
      if (gridH && p.h > 0 && !folded) md.step = (gridH + gap) / p.h;
      md.base = N - (folded ? 0 : p.h * md.step);
      if (Math.abs(N - p.H) > 1 || md.folded !== folded) changed = true;
      md.folded = folded;
      if (md.exact.size > 48) md.exact.clear();
      md.exact.set(shapeKey(p, colW, folded), N);
      models.set(id, md);
    });
    if (changed && tries.current < 4) {
      tries.current++;
      modelGen++;
      remeasure((x) => x + 1);
    } else if (!changed) tries.current = 0;
  });
  // A stack that changes size by itself (folded, an app's message got longer, the fonts arrived): measure again
  useEffect(() => {
    const root = ref.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) return void (first = false);
      remeasure((x) => x + 1);
    });
    root.querySelectorAll('[data-pack] > section').forEach((s) => ro.observe(s));
    return () => ro.disconnect();
  }, [signature]);

  return (
    <div ref={outer}>
      <div ref={ref} className="flex flex-col gap-3 sm:gap-4" style={{ ['--mfx-lift' as string]: '1.05' } as React.CSSProperties}>
        <div className="relative" style={{ height: bottom }}>
          {places.map((p, k) => (
            <div
              key={stacks[p.i].key ?? p.i}
              data-flip={`stack:${stacks[p.i].props.id ?? stacks[p.i].key}`}
              data-pack={k}
              className="mfx-lift-host flex flex-col min-w-0"
              // Across in shares of the width (so it always fits, even mid-resize), down in exact pixels
              style={{
                position: 'absolute',
                left: `calc((100% + ${GAP}px) * ${p.col / C})`,
                width: `calc((100% + ${GAP}px) * ${p.w / C} - ${GAP}px)`,
                top: p.top,
                height: p.H + p.grow,
              }}
            >
              <CellCols.Provider value={p.cols}>{stacks[p.i]}</CellCols.Provider>
            </div>
          ))}
        </div>
        {loose.map((c, i) => (
          <div key={c.key ?? `loose${i}`} className="mfx-lift-host flex flex-col min-w-0 mt-2 sm:mt-3">
            <CellCols.Provider value={C}>{c}</CellCols.Provider>
          </div>
        ))}
      </div>
    </div>
  );
};

/** How many app columns a panel with this many apps asks for (the grid decides how many fit) */
export const shelfSpan = (apps: number) => Math.max(0, apps);

const COLS_CLASS: Record<number, string> = { 1: '', 2: 'md:grid-cols-2', 3: 'md:grid-cols-2 lg:grid-cols-3' };

/** The grid of app cards inside a panel: as many columns as its place in the ShelfGrid gives it */
export const TileGrid: React.FC<{ span?: number; children: React.ReactNode }> = ({ span = 3, children }) => {
  const cols = React.useContext(CellCols);
  if (cols)
    return (
      // Fills the panel: when it's taller than its apps (beside stacked neighbours), the space is shared evenly
      <div data-tilegrid className="flex-1 grid gap-2.5 sm:gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, alignContent: 'space-evenly' }}>
        {children}
      </div>
    );
  return <div className={`grid grid-cols-1 ${COLS_CLASS[span] ?? COLS_CLASS[3]} gap-2.5 sm:gap-3`}>{children}</div>;
};

/** A calm one-line message inside a panel (an empty stack or group) */
export const ShelfNote: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="rounded-[16px] px-4 py-5 text-center text-[15px] leading-[20px]" style={{ background: 'rgba(255,255,255,0.05)', color: ios.secondary }}>
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
    <CountTo value={value} className="font-semibold tabular-nums" style={{ color: active ? '#fff' : 'rgba(255,255,255,0.92)' }} />
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
  /** Zoomed out: every stack at once, smaller, for moving things around */
  zoomedOut?: boolean;
  onZoom?: () => void;
}> = ({ showGroups = false, view, onView, count, filter, onFilter, running, stopped, ports, onShowPorts, groupItems = [], zoomedOut, onZoom }) => {
  const label = 'text-[12px] font-semibold uppercase tracking-[0.08em]';
  const toggle = (f: Filter) => onFilter(filter === f ? 'all' : f);
  const tab = (v: 'compose' | 'groups', text: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === v}
      onClick={() => onView(v)}
      className={`${label} rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]`}
      style={{ color: view === v ? 'rgba(255,255,255,0.9)' : 'rgba(235,235,245,0.6)' }}
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
            <span className="tabular-nums font-medium normal-case tracking-normal px-1.5 rounded-full text-[12px] leading-[18px]" style={{ background: 'rgba(118,118,128,0.2)', color: 'rgba(235,235,245,0.7)' }}>
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
        {onZoom && (
          <>
            <span className="w-px h-3.5 mx-1" style={{ background: 'rgba(255,255,255,0.12)' }} aria-hidden />
            <button
              type="button"
              onClick={onZoom}
              aria-pressed={Boolean(zoomedOut)}
              title={zoomedOut ? 'Back to the normal size' : 'See every stack at once. Zoomed out, drag an app onto another stack to move it.'}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[13px] transition-colors hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]"
              style={{ color: zoomedOut ? '#64B5FF' : 'rgba(235,235,245,0.75)', background: zoomedOut ? 'rgba(10,132,255,0.16)' : undefined }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
                {zoomedOut ? <path d="M8 11h6M11 8v6" /> : <path d="M8 11h6" />}
              </svg>
              {zoomedOut ? 'Zoom In' : 'Zoom Out'}
            </button>
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
