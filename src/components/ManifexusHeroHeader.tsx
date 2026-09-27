import React from 'react';
import { Activity, RotateCcw, Stethoscope, Settings, RefreshCw } from 'lucide-react';
import { DeepContainerMetadata, SystemStatus } from '../types';
import { ManifexusAppIcon, UpdateGlyph } from './SoftwareUpdateSheet';
import { ios } from './ui/ios';

interface ManifexusHeroHeaderProps {
  container?: DeepContainerMetadata;
  systemStatus: SystemStatus | null;
  onInspectContainer?: (container: DeepContainerMetadata) => void;
  versionLabel?: string;
  updateAvailable?: boolean;
  /** An update is being installed right now */
  updating?: boolean;
  onOpenUpdates?: () => void;
  /** Number of stacks, same as the Stacks card */
  stackCount?: number;
  onOpenActivity: () => void;
  /** Something failed since Activity was last opened */
  activityAlert?: boolean;
  onOpenHistory?: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  isRefreshing?: boolean;
}

/** Hover/focus tooltip. Wrap it in an element with the `group` class. */
const Tip: React.FC<{ text: string; side?: 'top' | 'bottom'; align?: 'center' | 'end' }> = ({
  text,
  side = 'top',
  align = 'center',
}) => (
  <span
    role="tooltip"
    className={`pointer-events-none absolute z-30 w-max max-w-[230px] rounded-[10px] px-2.5 py-1.5 text-[11.5px] leading-snug font-normal normal-case tracking-normal whitespace-normal text-left opacity-0 scale-95 transition-all duration-150 delay-200 group-hover:opacity-100 group-hover:scale-100 group-focus-visible:opacity-100 group-focus-visible:scale-100 ${
      side === 'top' ? 'bottom-full mb-2 origin-bottom' : 'top-full mt-2 origin-top'
    } ${align === 'end' ? 'right-0' : 'left-1/2 -translate-x-1/2'}`}
    style={{
      background: 'rgba(44,44,46,0.96)',
      color: 'rgba(235,235,245,0.86)',
      boxShadow: '0 0 0 0.5px rgba(255,255,255,0.12), 0 10px 30px rgba(0,0,0,0.55)',
      backdropFilter: 'blur(20px)',
      fontFamily: ios.font,
    }}
  >
    {text}
  </span>
);

/** A status capsule: quiet label, bright value. */
const Chip: React.FC<{
  label: string;
  tip: string;
  onClick?: () => void;
  tone?: 'default' | 'blue';
  children: React.ReactNode;
}> = ({ label, tip, onClick, tone = 'default', children }) => {
  const cls =
    'group relative inline-flex items-center gap-2 h-8 pl-3 pr-3.5 rounded-full text-[12.5px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]';
  const style: React.CSSProperties =
    tone === 'blue'
      ? { background: 'rgba(10,132,255,0.16)', boxShadow: 'inset 0 0 0 0.5px rgba(10,132,255,0.55)' }
      : { background: 'rgba(118,118,128,0.14)', boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.08)' };
  const body = (
    <>
      <span style={{ color: ios.secondary }}>{label}</span>
      {children}
      <Tip text={tip} />
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} aria-label={`${label}. ${tip}`} className={`${cls} hover:brightness-125 cursor-pointer`} style={style}>
      {body}
    </button>
  ) : (
    <span tabIndex={0} aria-label={`${label}. ${tip}`} className={`${cls} cursor-default`} style={style}>
      {body}
    </span>
  );
};

/** A button inside the glass toolbar. The label hides on narrower screens; the tooltip always explains it. */
const ToolButton: React.FC<{
  icon: React.ReactNode;
  label: string;
  tip: string;
  onClick: () => void;
  tone?: 'default' | 'blue' | 'red';
  align?: 'center' | 'end';
}> = ({ icon, label, tip, onClick, tone = 'default', align = 'center' }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    className="group relative inline-flex items-center gap-1.5 h-8 px-2.5 xl:px-3 rounded-full text-[13px] font-medium transition-colors hover:bg-white/[0.08] active:bg-white/[0.12] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]"
    style={{
      color: tone === 'blue' ? '#6CB6FF' : tone === 'red' ? '#FF8A80' : 'rgba(255,255,255,0.88)',
      background: tone === 'blue' ? 'rgba(10,132,255,0.18)' : undefined,
    }}
  >
    {icon}
    <span className="hidden xl:inline">{label}</span>
    <Tip text={tip} side="bottom" align={align} />
  </button>
);

const Divider = () => <span className="w-px h-4 mx-0.5" style={{ background: 'rgba(255,255,255,0.12)' }} aria-hidden="true" />;

export const ManifexusHeroHeader: React.FC<ManifexusHeroHeaderProps> = ({
  container,
  systemStatus,
  onInspectContainer,
  versionLabel,
  updateAvailable,
  updating,
  onOpenUpdates,
  stackCount,
  onOpenActivity,
  activityAlert,
  onOpenHistory,
  onOpenSettings,
  onRefresh,
  isRefreshing,
}) => {
  const port = container?.ports?.[0]?.publicPort || 3334;
  const socketOn = !!systemStatus?.dockerConnected;
  // The server labels builds "Build <revision>" or "Development build"; show just the revision
  const build = !versionLabel ? undefined : versionLabel.startsWith('Build ') ? versionLabel.slice(6) : 'dev';
  const iconCls = 'w-[15px] h-[15px]';

  return (
    <section
      className="relative w-full mb-6 rounded-[22px]"
      style={{
        fontFamily: ios.font,
        background: 'linear-gradient(180deg, rgba(38,38,42,0.92) 0%, rgba(24,24,27,0.94) 100%)',
        boxShadow:
          'inset 0 1px 0 rgba(255,255,255,0.07), 0 0 0 1px rgba(255,255,255,0.07), 0 30px 60px -30px rgba(0,0,0,0.9), 0 12px 24px -12px rgba(0,0,0,0.6)',
      }}
    >
      {/* Ambient light */}
      <div className="absolute inset-0 overflow-hidden rounded-[22px] pointer-events-none" aria-hidden="true">
        <div className="absolute -top-24 -left-16 w-80 h-80 rounded-full blur-3xl" style={{ background: 'radial-gradient(circle, rgba(10,132,255,0.22), transparent 65%)' }} />
        <div className="absolute -top-32 left-1/3 w-[28rem] h-72 rounded-full blur-3xl" style={{ background: 'radial-gradient(circle, rgba(94,92,230,0.12), transparent 70%)' }} />
        <div className="absolute inset-x-0 top-0 h-px" style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent)' }} />
      </div>

      <div className="relative px-5 sm:px-7 pt-6 pb-5">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-5">
          {/* Identity */}
          <div className="flex items-start sm:items-center gap-4 sm:gap-5 min-w-0">
            <div
              className="relative flex-shrink-0 w-12 h-12 sm:w-16 sm:h-16 [&>svg]:w-full [&>svg]:h-full"
              style={{ filter: 'drop-shadow(0 10px 22px rgba(47,140,255,0.35))' }}
            >
              <ManifexusAppIcon size={64} />
              <span
                className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full"
                style={{ background: socketOn ? ios.green : ios.red, boxShadow: '0 0 0 3px #1f1f23' }}
                aria-hidden="true"
              />
            </div>
            <div className="min-w-0">
              <h1
                className="text-[30px] sm:text-[38px] leading-none font-bold"
                style={{
                  fontFamily: '"Inter Tight", "SF Pro Display", -apple-system, system-ui, sans-serif',
                  letterSpacing: '-0.035em',
                  backgroundImage: 'linear-gradient(180deg, #ffffff 0%, #e4e4ea 45%, #9a9aa6 100%)',
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  color: 'transparent',
                }}
              >
                Manifexus
              </h1>
              <p className="mt-2 text-[13px] sm:text-[14px] leading-[1.45] max-w-[34rem]" style={{ color: ios.secondary }}>
                All your Docker apps in one place. See what&rsquo;s running, organize apps into stacks, and move them
                safely, with a backup before every change.
              </p>
            </div>
          </div>

          {/* Toolbar: records, then system */}
          <nav
            aria-label="Manifexus"
            className="w-full sm:w-auto sm:self-start lg:self-auto flex-shrink-0 flex items-center justify-between sm:justify-start gap-0.5 p-1 rounded-full"
            style={{
              background: 'rgba(118,118,128,0.14)',
              boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.1), 0 1px 2px rgba(0,0,0,0.3)',
              backdropFilter: 'blur(20px)',
            }}
          >
            <ToolButton
              icon={
                <span className="relative flex">
                  <Activity className={iconCls} />
                  {activityAlert && (
                    <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full" style={{ background: ios.red, boxShadow: '0 0 0 2px #26262a' }} />
                  )}
                </span>
              }
              label="Activity"
              tip={activityAlert ? 'Something failed. Open Activity to see exactly what happened.' : 'Everything Manifexus has done, with full details.'}
              tone={activityAlert ? 'red' : 'default'}
              onClick={onOpenActivity}
            />
            {onOpenHistory && (
              <ToolButton
                icon={<RotateCcw className={iconCls} />}
                label="Undo"
                tip="Undo a recent move or delete, from its saved backup."
                onClick={onOpenHistory}
              />
            )}
            <Divider />
            {container && onInspectContainer && (
              <ToolButton
                icon={<Stethoscope className={iconCls} />}
                label="Diagnostics"
                tip="Health, mounts, environment and logs for the Manifexus container."
                onClick={() => onInspectContainer(container)}
              />
            )}
            {onOpenUpdates && (
              <ToolButton
                icon={updating ? <RefreshCw className={`${iconCls} animate-spin`} /> : <UpdateGlyph className="w-4 h-4" />}
                label={updating ? 'Updating…' : updateAvailable ? 'Update' : 'Updates'}
                tip={
                  updating
                    ? 'Manifexus is installing an update.'
                    : updateAvailable
                      ? 'A new version of Manifexus is ready to install.'
                      : 'Check for and install new versions of Manifexus.'
                }
                tone={updateAvailable || updating ? 'blue' : 'default'}
                onClick={onOpenUpdates}
              />
            )}
            <ToolButton
              icon={<Settings className={iconCls} />}
              label="Settings"
              tip="Host address, stack folder, refresh rate and automation privileges."
              onClick={onOpenSettings}
              align="end"
            />
          </nav>
        </div>

        {/* Status */}
        <div
          className="mt-5 pt-4 flex flex-wrap items-center justify-between gap-3"
          style={{ borderTop: '0.5px solid rgba(255,255,255,0.09)' }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Chip
              label="Build"
              tone={updateAvailable ? 'blue' : 'default'}
              tip={
                updateAvailable
                  ? 'The version you are running. A newer one is available. Click to open Updates.'
                  : 'The version of Manifexus you are running. Click to open Updates.'
              }
              onClick={onOpenUpdates}
            >
              <span className="font-mono text-[12px] font-semibold text-white">{build || '…'}</span>
              {updateAvailable && <span className="w-1.5 h-1.5 rounded-full" style={{ background: ios.blue }} />}
            </Chip>

            <Chip
              label="Docker Socket"
              tip={
                socketOn
                  ? 'Connected. Manifexus can see and manage your containers.'
                  : 'Not connected. Manifexus cannot see or manage containers.'
              }
            >
              <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: socketOn ? ios.green : ios.red }}>
                <span
                  className="w-[7px] h-[7px] rounded-full"
                  style={{ background: 'currentColor', boxShadow: '0 0 8px currentColor' }}
                />
                {socketOn ? 'On' : 'Off'}
              </span>
            </Chip>

            <Chip label="Port" tip="The port this dashboard is served on. Open it as http://your-server:port.">
              <span className="text-[14px] font-semibold text-white tabular-nums tracking-wide">{port}</span>
            </Chip>

            <Chip label="Stacks" tip="How many Docker Compose stacks your apps are grouped into.">
              <span className="text-[14px] font-semibold text-white tabular-nums">{stackCount ?? '…'}</span>
            </Chip>
          </div>

          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh"
            className="group relative inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[13px] font-medium transition-colors hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]"
            style={{ color: ios.blue }}
          >
            <RefreshCw className={`${iconCls} ${isRefreshing ? 'animate-spin' : ''}`} />
            {isRefreshing ? 'Refreshing…' : 'Refresh'}
            <Tip text="Reload apps, stacks and status from Docker now." align="end" />
          </button>
        </div>
      </div>
    </section>
  );
};
