import React, { useState } from 'react';
import { DeepContainerMetadata } from '../types';
import { AppIcon } from './AppCard';
import { MenuButton, MenuItem, ios } from './ui/ios';

/**
 * The dashboard below the hero, in the hero's style: a section bar under the header and
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
// Section bar
// ----------------------------------------------------------------------------

/**
 * The break between the header and the stacks: a quiet "Your Stacks" label and a hairline, with the
 * "Showing only running apps" note on the right. Search and New Stack live in the header. With groups
 * shown, the label becomes Stacks | Groups to tap between, and + adds or edits groups.
 */
export const LibraryBar: React.FC<{
  /** Off: just the Your Stacks label, no Groups to switch to */
  showGroups?: boolean;
  view: 'compose' | 'groups';
  onView: (v: 'compose' | 'groups') => void;
  /** How many stacks are shown */
  count?: number;
  filter: 'all' | 'running' | 'stopped';
  onClearFilter: () => void;
  /** Group actions (New Group, Edit Groups), while groups are shown */
  groupItems?: MenuItem[];
}> = ({ showGroups = false, view, onView, count, filter, onClearFilter, groupItems = [] }) => {
  const label = 'text-[12px] font-semibold uppercase tracking-[0.08em]';
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
    <div className="mt-3 mb-4 flex items-center gap-3 min-h-[28px]" style={{ fontFamily: ios.font }}>
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
      <div className="flex-1 h-px" style={{ background: 'linear-gradient(90deg, rgba(255,255,255,0.14), rgba(255,255,255,0.03))' }} aria-hidden />
      {filter !== 'all' && (
        <div className="flex items-center gap-2 text-[13px] flex-shrink-0" style={{ color: ios.secondary }}>
          <span className="max-sm:hidden">Showing only {filter === 'running' ? 'running' : 'stopped'} apps.</span>
          <span className="sm:hidden">Only {filter}</span>
          <button type="button" onClick={onClearFilter} className="font-medium hover:opacity-80" style={{ color: ios.blue }}>
            Show All
          </button>
        </div>
      )}
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
