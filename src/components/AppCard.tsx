import React, { useEffect, useMemo, useState } from 'react';
import { DeepContainerMetadata, UserGroup } from '../types';
import { MenuButton, MenuItem } from './ui/ios';
import { DRAG_TYPE, InlineName, RenameButton } from './Shelf';
import { helperKind } from '../appHelpers';

interface AppCardProps {
  container: DeepContainerMetadata;
  /** Shown inside its stack's section, so the stack name isn't repeated */
  inStack?: boolean;
  /** The stack's name as shown on the dashboard (when it's been renamed) */
  stackName?: string;
  /** Its own databases and caches, shown as part of it */
  helpers?: DeepContainerMetadata[];
  hostAddress: string;
  groups: UserGroup[];
  onInspect: (container: DeepContainerMetadata) => void;
  onAssignGroup: (containerId: string, groupId: string) => void;
  onAction: (containerId: string, action: 'start' | 'stop' | 'restart') => Promise<void>;
  onSetPrimaryPort?: (containerId: string, port: number) => void;
  /** Opens the Move apps flow with this app selected */
  onMoveApp?: (container: DeepContainerMetadata) => void;
  /** Rename it right on the card (empty goes back to its own name) */
  onRename?: (containerId: string, name: string) => void;
  /** Something is happening to it in the background, like "Moving to Media…" */
  busy?: string;
}

const STATE: Record<string, { label: string; color: string }> = {
  running: { label: 'Running', color: '#30D158' },
  restarting: { label: 'Restarting', color: '#FF9F0A' },
  paused: { label: 'Paused', color: '#FF9F0A' },
  created: { label: 'Not Started', color: '#8E8E93' },
  exited: { label: 'Stopped', color: '#8E8E93' },
  dead: { label: 'Stopped', color: '#FF453A' },
};

/** Apps whose own icon this page already reported */
const reported = new Set<string>();

/** The app's icon, or its initials on a tinted tile when there's no icon */
export const AppIcon: React.FC<{ container: DeepContainerMetadata; size?: number }> = ({ container, size = 48 }) => {
  const [failed, setFailed] = useState<string[]>([]);
  const name = container.customName || container.friendlyName || container.cleanName;
  // Where to look, best first: the icon Manifexus saved, then the app's own icon files, fetched by
  // this browser straight from the app's web page (the same icon its browser tab shows)
  const candidates = useMemo(() => {
    const list: string[] = [];
    // An icon Manifexus found (or you chose) comes first
    if (container.iconUrl && container.iconSource) list.push(container.iconUrl);
    // Otherwise the app's own icon, as its browser tab shows it
    if (container.webPort && typeof window !== 'undefined') {
      const base = container.customUrl ? container.customUrl.replace(/\/+$/, '') : `http://${window.location.hostname}:${container.webPort}`;
      for (const f of ['/apple-touch-icon.png', '/apple-touch-icon-180x180.png', '/favicon.svg', '/favicon.ico']) list.push(base + f);
    }
    // Then a guess from the icon sets
    if (container.iconUrl && !container.iconSource) list.push(container.iconUrl);
    return list;
  }, [container.iconUrl, container.iconSource, container.webPort, container.customUrl]);
  const url = candidates.find((u) => !failed.includes(u));
  // The app's own icon loaded here but Manifexus hasn't saved one: tell it, so every screen uses it
  const report = (loaded: string) => {
    if (container.iconSource || loaded === container.iconUrl || reported.has(container.id)) return;
    reported.add(container.id);
    void fetch(`/api/apps/${encodeURIComponent(container.id)}/icon/seen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: loaded }),
    }).catch(() => undefined);
  };
  const initials = name
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
  // A calm colour picked from the name, so each app's tile stays the same
  const hue = Array.from(name).reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
  return (
    <div
      className="flex-shrink-0 flex items-center justify-center overflow-hidden"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.24,
        background: url ? 'rgba(255,255,255,0.06)' : `linear-gradient(145deg, hsl(${hue} 45% 32%), hsl(${(hue + 30) % 360} 50% 22%))`,
        boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.12)',
      }}
    >
      {url ? (
        <img src={url} alt="" onError={() => setFailed((f) => [...f, url])} onLoad={(e) => (e.currentTarget.naturalWidth < 8 ? setFailed((f) => [...f, url]) : report(url!))} referrerPolicy="no-referrer" className="object-contain" style={{ width: size * 0.72, height: size * 0.72 }} />
      ) : (
        <span className="font-semibold text-white/90" style={{ fontSize: size * 0.36, letterSpacing: '0.02em' }}>
          {initials || '?'}
        </span>
      )}
    </div>
  );
};

const OpenGlyph = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M7 17 17 7M9 7h8v8" />
  </svg>
);

const RestartGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 11a8 8 0 1 0-2.3 5.7" />
    <path d="M20 4v7h-7" />
  </svg>
);

const StopGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <rect x="4" y="4" width="16" height="16" rx="3.5" />
  </svg>
);

/** Same arrows as Move in Restore */
const MoveGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 8h13m0 0-3.5-3.5M17 8l-3.5 3.5M20 16H7m0 0 3.5-3.5M7 16l3.5 3.5" />
  </svg>
);

const InfoGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.6v.01" strokeWidth="2.6" />
  </svg>
);

/**
 * An app on the dashboard. The top row is about the app itself: its icon, name, whether it's running,
 * and Move and Details beside it. The bottom row runs it: one clear action (Open its web page, or
 * Start it) with Restart and Stop beside it. Tapping the card also opens Details.
 */
export const AppCard: React.FC<AppCardProps> = ({ container, inStack, stackName, helpers = [], hostAddress, groups, onInspect, onAction, onSetPrimaryPort, onMoveApp, onRename, busy }) => {
  const [acting, setActing] = useState<'start' | 'stop' | 'restart'>();
  const [renaming, setRenaming] = useState(false);
  // A new name shows straight away, before the refresh brings it back from the server
  const [pending, setPending] = useState<string>();
  const ownName = container.friendlyName || container.cleanName;
  const saved = container.customName || ownName;
  const name = pending !== undefined ? pending || ownName : saved;
  useEffect(() => setPending(undefined), [saved]);
  const running = container.state === 'running';
  const st = STATE[container.state] || { label: container.state, color: '#8E8E93' };
  const host = hostAddress || 'localhost';
  const webPort = container.webPort;
  const url = container.customUrl || (webPort ? `http://${host}:${webPort}` : undefined);
  const others = container.otherWebPorts || [];
  const group = groups.find((g) => g.id === container.customGroup);

  // A helper that isn't running means the app isn't really working
  const downHelpers = helpers.filter((h) => h.state !== 'running');

  const act = async (a: 'start' | 'stop' | 'restart') => {
    setActing(a);
    try {
      await onAction(container.id, a);
    } finally {
      setActing(undefined);
    }
  };

  const openMenu: MenuItem[] = [
    ...[webPort!, ...others].map((p, i) => ({
      key: `o-${p}`,
      label: `Open Port ${p}`,
      detail: i === 0 ? 'Default' : undefined,
      onSelect: () => window.open(`http://${host}:${p}`, '_blank', 'noopener'),
    })),
    ...(onSetPrimaryPort
      ? [
          { key: 'dh', label: 'Open by Default', header: true, divider: true, onSelect: () => undefined },
          ...[webPort!, ...others].map((p) => ({ key: `d-${p}`, label: `Port ${p}`, checked: p === webPort, onSelect: () => onSetPrimaryPort(container.id, p) })),
        ]
      : []),
  ];

  const busyLabel = busy || (acting === 'start' ? 'Starting…' : acting === 'stop' ? 'Stopping…' : acting === 'restart' ? 'Restarting…' : undefined);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onInspect(container)}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onInspect(container);
        }
      }}
      aria-label={`${name}, ${st.label}. Show details`}
      // Lets the dashboard glide this card to its new place when stacks change (see ShelfGrid); keyed by the
      // compose service, which stays the same when an app moves to another stack
      data-flip={`app:${container.compose?.service || container.cleanName}`}
      // Drag it onto another stack to move it there
      draggable={!busy}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, container.id);
        e.dataTransfer.effectAllowed = 'move';
        e.currentTarget.classList.add('mfx-dragging');
      }}
      onDragEnd={(e) => e.currentTarget.classList.remove('mfx-dragging')}
      className={`group/card relative flex flex-col gap-4 rounded-[18px] p-4 cursor-pointer text-left transition-colors ${busyLabel || container.state === 'restarting' ? 'mfx-busy' : ''} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0A84FF] ${
        running ? 'bg-white/[0.07] hover:bg-white/[0.10]' : 'bg-white/[0.045] hover:bg-white/[0.075]'
      }`}
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", Roboto, sans-serif' }}
    >
      <div className="relative flex items-center gap-3 min-w-0">
        <div className={running ? '' : 'opacity-60 grayscale-[35%]'}>
          <AppIcon container={container} size={48} />
        </div>
        <div className="flex-1 min-w-0">
          {renaming ? (
            <InlineName
              value={container.customName ? name : ''}
              original={ownName}
              onSave={(n) => {
                setRenaming(false);
                setPending(n);
                onRename?.(container.id, n);
              }}
              onCancel={() => setRenaming(false)}
              className="text-[16px] leading-[21px] h-[23px] font-semibold"
            />
          ) : (
            <div className="flex items-center gap-1 min-w-0">
              <h3 className="text-[16px] leading-[21px] font-semibold text-white truncate" title={name !== ownName ? `${name} (${ownName})` : name}>
                {name}
              </h3>
              {onRename && <RenameButton group="card" label={name} onClick={() => setRenaming(true)} />}
            </div>
          )}
          <div className="mt-0.5 flex items-center gap-1.5 text-[13px] leading-[18px] min-w-0" style={{ color: 'rgba(235,235,245,0.6)' }}>
            <span className="w-[7px] h-[7px] rounded-full flex-shrink-0" style={{ background: busyLabel ? '#0A84FF' : running && downHelpers.length ? '#FF9F0A' : st.color }} aria-hidden />
            <span className="flex-shrink-0">{busyLabel || st.label}</span>
            {running && !busyLabel && downHelpers.length > 0 && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate" style={{ color: '#FF9F0A' }}>
                  {downHelpers.length === 1 ? `${helperKind(downHelpers[0])} stopped` : `${downHelpers.length} linked parts stopped`}
                </span>
              </>
            )}
            {container.compose?.project && !inStack && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{stackName || container.compose.project}</span>
              </>
            )}
            {group && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate flex-shrink-0 max-w-[40%]" style={{ color: group.color }}>
                  {group.name}
                </span>
              </>
            )}
          </div>
        </div>
        {/* Managing the app: Move and Details, in the same capsule as Restart and Stop */}
        <div className="flex items-stretch h-[32px] rounded-[10px] overflow-hidden flex-shrink-0" style={{ background: 'rgba(255,255,255,0.06)' }}>
          {onMoveApp && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onMoveApp(container);
              }}
              title="Move to Another Stack"
              aria-label={`Move ${name} to another stack`}
              className="w-[36px] inline-flex items-center justify-center text-white/60 hover:text-white hover:bg-white/[0.08] focus-visible:outline-2 focus-visible:outline-[#0A84FF] -outline-offset-2"
            >
              <MoveGlyph />
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onInspect(container);
            }}
            title="Details"
            aria-label={`Details for ${name}`}
            className={`w-[36px] inline-flex items-center justify-center text-white/60 hover:text-white hover:bg-white/[0.08] focus-visible:outline-2 focus-visible:outline-[#0A84FF] -outline-offset-2 ${onMoveApp ? 'border-l border-white/[0.08]' : ''}`}
          >
            <InfoGlyph />
          </button>
        </div>
      </div>

      {/* The main action, with Restart and Stop beside it */}
      <div className="flex items-stretch gap-2">
        <div className="flex-1 min-w-0">
      {running && url ? (
            <div className="flex items-stretch h-[38px] rounded-[11px] overflow-hidden" style={{ background: 'rgba(10,132,255,0.16)' }}>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                title={`Open ${url}`}
                className="flex-1 inline-flex items-center justify-center gap-1.5 text-[15px] font-semibold hover:bg-white/[0.06] focus-visible:outline-2 focus-visible:outline-[#0A84FF] -outline-offset-2"
                style={{ color: '#64B5FF' }}
              >
                Open
                <OpenGlyph />
              </a>
              {others.length > 0 && !container.customUrl && (
                <MenuButton
                  look="bare"
                  align="right"
                  ariaLabel={`Other web pages of ${name}`}
                  title="Other web pages"
                  items={openMenu}
                  label={
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  }
                  className="w-[40px] inline-flex items-center justify-center hover:bg-white/[0.06] focus-visible:outline-2 focus-visible:outline-[#0A84FF] -outline-offset-2 border-l border-white/[0.08] text-[#64B5FF]"
                />
              )}
            </div>
          ) : !running && container.state !== 'restarting' ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void act('start');
              }}
              disabled={!!acting}
              className="w-full h-[38px] rounded-[11px] text-[15px] font-semibold hover:bg-white/[0.1] disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-[#0A84FF]"
              style={{ background: 'rgba(48,209,88,0.14)', color: '#4ADE80' }}
            >
              {acting === 'start' ? 'Starting…' : 'Start'}
            </button>
          ) : (
            <div className="h-[38px] rounded-[11px] flex items-center justify-center text-[13.5px]" style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)', color: 'rgba(235,235,245,0.4)' }}>
              {container.state === 'restarting' ? 'Restarting…' : 'No web page'}
            </div>
          )}
        </div>
        {running && (
          <div className="flex items-stretch h-[38px] rounded-[11px] overflow-hidden flex-shrink-0" style={{ background: 'rgba(255,255,255,0.06)' }}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void act('restart');
              }}
              disabled={!!acting}
              title="Restart"
              aria-label={`Restart ${name}`}
              className="w-[42px] inline-flex items-center justify-center text-white/70 hover:text-white hover:bg-white/[0.08] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[#0A84FF] -outline-offset-2"
            >
              <span className={acting === 'restart' ? 'animate-spin motion-reduce:animate-none' : ''}>
                <RestartGlyph />
              </span>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void act('stop');
              }}
              disabled={!!acting}
              title="Stop"
              aria-label={`Stop ${name}`}
              className="w-[42px] inline-flex items-center justify-center border-l border-white/[0.08] text-white/70 hover:text-[#FF6961] hover:bg-[rgba(255,69,58,0.12)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[#0A84FF] -outline-offset-2"
            >
              <StopGlyph />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
