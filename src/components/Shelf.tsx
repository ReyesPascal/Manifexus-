import React, { useEffect, useRef, useState } from 'react';
import { DeepContainerMetadata } from '../types';
import { AppIcon } from './AppCard';
import { MenuButton, MenuItem, ios } from './ui/ios';

/**
 * The dashboard below the hero, in the hero's style: a toolbar (Stacks | Groups, search, +) and
 * one glass panel per stack or group, with its apps on quiet tiles inside.
 */

export const displayFont = '"Inter Tight", "SF Pro Display", -apple-system, system-ui, sans-serif';

/** Same glass as the hero, a little quieter */
export const panelStyle: React.CSSProperties = {
  background: 'linear-gradient(180deg, rgba(36,36,40,0.78) 0%, rgba(24,24,27,0.82) 100%)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 0 0 1px rgba(255,255,255,0.06), 0 24px 48px -28px rgba(0,0,0,0.9)',
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
  /** Keep it open even if folded before (e.g. an app in it has a problem) */
  forceOpen?: boolean;
  children: React.ReactNode;
}> = ({ id, title, icon, status, action, menu, forceOpen, children }) => {
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
    <section className="rounded-[22px]" style={{ ...panelStyle, fontFamily: ios.font }} aria-label={title}>
      <header className="flex items-center gap-3 pl-4 pr-3 sm:pl-5 sm:pr-4 py-3.5">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={bodyId}
          className="group flex-1 min-w-0 flex items-center gap-3 text-left rounded-[12px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]"
          title={open ? 'Fold' : 'Show apps'}
        >
          {icon}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 min-w-0">
              <h2
                className="text-[19px] leading-[24px] font-semibold text-white truncate"
                style={{ fontFamily: displayFont, letterSpacing: '-0.02em' }}
              >
                {title}
              </h2>
              <span className="flex-shrink-0 opacity-40 group-hover:opacity-80 transition-opacity text-white">
                <Chevron open={open} />
              </span>
            </span>
            <span className="mt-0.5 flex items-center text-[13px] leading-[18px] min-w-0" style={{ color: ios.secondary }}>
              {status}
            </span>
          </span>
        </button>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            title={action.title}
            className="hidden sm:inline-flex flex-shrink-0 items-center gap-1.5 h-8 pl-2.5 pr-3.5 rounded-full text-[13px] font-medium transition-colors hover:brightness-125 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]"
            style={{ background: 'rgba(118,118,128,0.16)', boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.9)' }}
          >
            <PlusGlyph size={13} />
            {action.label}
          </button>
        )}
        {menu && menu.length > 0 && (
          <MenuButton
            look="bare"
            label={<MoreGlyph />}
            ariaLabel={`More for ${title}`}
            title="More"
            items={action && isPhone() ? [{ key: '__action', label: action.label, onSelect: action.onClick }, ...menu.map((m, i) => (i === 0 ? { ...m, divider: true } : m))] : menu}
            className="flex-shrink-0 w-9 h-9 rounded-full inline-flex items-center justify-center text-white/70 hover:text-white hover:bg-white/[0.08] focus-visible:outline-2 focus-visible:outline-[#0A84FF]"
          />
        )}
      </header>
      {open && (
        <div id={bodyId} className="px-3 pb-3 sm:px-4 sm:pb-4">
          {children}
        </div>
      )}
    </section>
  );
};

/** Phones hide the Add App capsule, so it moves into the menu there */
function isPhone() {
  return typeof window !== 'undefined' && window.matchMedia?.('(max-width: 639px)').matches;
}

/** The grid of app cards inside a panel */
export const TileGrid: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5 sm:gap-3">{children}</div>
);

/** A calm one-line message inside a panel (an empty stack or group) */
export const ShelfNote: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="rounded-[16px] px-4 py-5 text-center text-[14px] leading-[20px]" style={{ background: 'rgba(255,255,255,0.03)', color: ios.secondary }}>
    {children}
  </div>
);

// ----------------------------------------------------------------------------
// Toolbar
// ----------------------------------------------------------------------------

const SearchGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </svg>
);

/**
 * Stacks | Groups as large titles you tap between, a search field, and one + button for creating
 * things (New Stack, New Group). Group editing lives with the groups themselves.
 */
export const LibraryBar: React.FC<{
  view: 'compose' | 'groups';
  onView: (v: 'compose' | 'groups') => void;
  search: string;
  onSearch: (q: string) => void;
  filter: 'all' | 'running' | 'stopped';
  onClearFilter: () => void;
  addItems: MenuItem[];
}> = ({ view, onView, search, onSearch, filter, onClearFilter, addItems }) => {
  const [searching, setSearching] = useState(Boolean(search));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searching) input.current?.focus();
  }, [searching]);
  const tab = (v: 'compose' | 'groups', label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={view === v}
      onClick={() => onView(v)}
      className="text-[26px] sm:text-[28px] leading-none font-bold rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]"
      style={{ fontFamily: displayFont, letterSpacing: '-0.03em', color: view === v ? '#fff' : 'rgba(235,235,245,0.3)' }}
    >
      {label}
    </button>
  );
  const field = (
    <label
      className="flex items-center gap-2 h-9 pl-3 pr-2 rounded-full w-full sm:w-[260px] transition-colors focus-within:ring-2 focus-within:ring-[#0A84FF]"
      style={{ background: 'rgba(118,118,128,0.16)', boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.08)', color: ios.secondary }}
    >
      <SearchGlyph />
      <input
        ref={input}
        type="search"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onSearch('');
            setSearching(false);
          }
        }}
        onBlur={() => !search && setSearching(false)}
        placeholder="Search apps"
        aria-label="Search apps"
        className="flex-1 min-w-0 bg-transparent outline-none text-[14px] text-white placeholder:text-[rgba(235,235,245,0.4)] [&::-webkit-search-cancel-button]:hidden"
      />
      {search && (
        <button type="button" onClick={() => onSearch('')} aria-label="Clear search" className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] text-black" style={{ background: 'rgba(235,235,245,0.45)' }}>
          ✕
        </button>
      )}
    </label>
  );
  return (
    <div className="mb-5 mt-2" style={{ fontFamily: ios.font }}>
      <div className="flex items-center gap-3">
        <div role="tablist" aria-label="Arrange apps" className="flex items-baseline gap-5 min-w-0">
          {tab('compose', 'Stacks')}
          {tab('groups', 'Groups')}
        </div>
        <div className="flex-1" />
        <div className="hidden sm:block">{field}</div>
        {!searching && (
          <button
            type="button"
            onClick={() => setSearching(true)}
            aria-label="Search apps"
            className="sm:hidden w-9 h-9 rounded-full inline-flex items-center justify-center hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]"
            style={{ background: 'rgba(118,118,128,0.16)', color: 'rgba(255,255,255,0.85)' }}
          >
            <SearchGlyph />
          </button>
        )}
        <MenuButton
          look="bare"
          ariaLabel="Create"
          title="New Stack or Group"
          items={addItems}
          label={<PlusGlyph size={17} />}
          className="flex-shrink-0 w-9 h-9 rounded-full inline-flex items-center justify-center text-white bg-[#0A84FF] shadow-[0_4px_14px_-4px_rgba(10,132,255,0.6)] transition-all hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-black focus-visible:ring-[#0A84FF]"
        />
      </div>
      {searching && <div className="sm:hidden mt-3">{field}</div>}
      {filter !== 'all' && (
        <div className="mt-3 flex items-center gap-2 text-[13px]" style={{ color: ios.secondary }}>
          <span>Showing only {filter === 'running' ? 'running' : 'stopped'} apps.</span>
          <button type="button" onClick={onClearFilter} className="font-medium hover:opacity-80" style={{ color: ios.blue }}>
            Show All
          </button>
        </div>
      )}
    </div>
  );
};
