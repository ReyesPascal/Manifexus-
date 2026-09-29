import React, { useState } from 'react';
import { DeepContainerMetadata, UserGroup } from '../types';
import { MenuButton, MenuItem } from './ui/ios';

interface AppCardProps {
  container: DeepContainerMetadata;
  /** Shown inside its stack's section, so the stack name isn't repeated */
  inStack?: boolean;
  hostAddress: string;
  groups: UserGroup[];
  onInspect: (container: DeepContainerMetadata) => void;
  onAssignGroup: (containerId: string, groupId: string) => void;
  onAction: (containerId: string, action: 'start' | 'stop' | 'restart') => Promise<void>;
  onSetPrimaryPort?: (containerId: string, port: number) => void;
  /** Opens the Move apps flow with this app selected */
  onMoveApp?: (container: DeepContainerMetadata) => void;
}

const STATE: Record<string, { label: string; color: string }> = {
  running: { label: 'Running', color: '#30D158' },
  restarting: { label: 'Restarting', color: '#FF9F0A' },
  paused: { label: 'Paused', color: '#FF9F0A' },
  created: { label: 'Not Started', color: '#8E8E93' },
  exited: { label: 'Stopped', color: '#8E8E93' },
  dead: { label: 'Stopped', color: '#FF453A' },
};

/** The app's icon, or its initials on a tinted tile when there's no icon */
export const AppIcon: React.FC<{ container: DeepContainerMetadata; size?: number }> = ({ container, size = 48 }) => {
  const [failed, setFailed] = useState<string>();
  const name = container.customName || container.friendlyName || container.cleanName;
  const url = container.iconUrl && failed !== container.iconUrl ? container.iconUrl : undefined;
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
        <img src={url} alt="" onError={() => setFailed(url)} referrerPolicy="no-referrer" className="object-contain" style={{ width: size * 0.72, height: size * 0.72 }} />
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

const MoreGlyph = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <circle cx="5" cy="12" r="1.9" />
    <circle cx="12" cy="12" r="1.9" />
    <circle cx="19" cy="12" r="1.9" />
  </svg>
);

/**
 * An app on the dashboard: its icon and name, whether it's running and where it lives, and one clear
 * action (Open its web page, or Start it) with Restart and Stop beside it. Moving and groups are in the
 * ⋯ menu; tap the card for Details.
 */
export const AppCard: React.FC<AppCardProps> = ({ container, inStack, hostAddress, groups, onInspect, onAssignGroup, onAction, onSetPrimaryPort, onMoveApp }) => {
  const [acting, setActing] = useState<'start' | 'stop' | 'restart'>();
  const name = container.customName || container.friendlyName || container.cleanName;
  const running = container.state === 'running';
  const st = STATE[container.state] || { label: container.state, color: '#8E8E93' };
  const host = hostAddress || 'localhost';
  const webPort = container.webPort;
  const url = container.customUrl || (webPort ? `http://${host}:${webPort}` : undefined);
  const others = container.otherWebPorts || [];
  const group = groups.find((g) => g.id === container.customGroup);

  const act = async (a: 'start' | 'stop' | 'restart') => {
    setActing(a);
    try {
      await onAction(container.id, a);
    } finally {
      setActing(undefined);
    }
  };

  const menu: MenuItem[] = [
    ...(onMoveApp ? [{ key: 'move', label: 'Move to Another Stack…', onSelect: () => onMoveApp(container) }] : []),
    ...(groups.length
      ? [
          { key: 'gh', label: 'Group', header: true, divider: !!onMoveApp, onSelect: () => undefined },
          { key: 'g-none', label: 'None', checked: !container.customGroup, onSelect: () => onAssignGroup(container.id, '') },
          ...groups.map((g) => ({ key: `g-${g.id}`, label: g.name, dot: g.color, checked: container.customGroup === g.id, onSelect: () => onAssignGroup(container.id, g.id) })),
        ]
      : []),
    { key: 'details', label: 'Details', divider: true, onSelect: () => onInspect(container) },
  ];

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

  const busyLabel = acting === 'start' ? 'Starting…' : acting === 'stop' ? 'Stopping…' : acting === 'restart' ? 'Restarting…' : undefined;

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
      className={`group relative flex flex-col gap-4 rounded-2xl p-4 cursor-pointer text-left transition-colors border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0A84FF] ${
        running ? 'bg-[#0f1422] border-white/[0.07] hover:border-white/[0.14] hover:bg-[#121827]' : 'bg-[#0c101b] border-white/[0.05] hover:border-white/[0.1]'
      }`}
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", Roboto, sans-serif' }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className={running ? '' : 'opacity-60 grayscale-[35%]'}>
          <AppIcon container={container} size={48} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-[16px] leading-[21px] font-semibold text-white truncate" title={name}>
            {name}
          </h3>
          <div className="mt-0.5 flex items-center gap-1.5 text-[13px] leading-[18px] min-w-0" style={{ color: 'rgba(235,235,245,0.6)' }}>
            <span className="w-[7px] h-[7px] rounded-full flex-shrink-0" style={{ background: busyLabel ? '#0A84FF' : st.color }} aria-hidden />
            <span className="flex-shrink-0">{busyLabel || st.label}</span>
            {container.compose?.project && !inStack && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{container.compose.project}</span>
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
        <MenuButton
          look="bare"
          label={<MoreGlyph />}
          ariaLabel={`More for ${name}`}
          title="More"
          items={menu}
          className="flex-shrink-0 -mr-1 w-9 h-9 rounded-full inline-flex items-center justify-center text-white/60 hover:text-white hover:bg-white/[0.08] focus-visible:outline-2 focus-visible:outline-[#0A84FF]"
        />
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
            <div className="h-[38px] rounded-[11px] flex items-center justify-center text-[13.5px]" style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(235,235,245,0.45)' }}>
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
