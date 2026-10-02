import { tipProps } from './ui/Tooltip';
import React, { useState } from 'react';
import { Activity, History, Stethoscope, Settings, RefreshCw, Sparkles, Eraser, ShieldCheck } from 'lucide-react';
import { DeepContainerMetadata, SystemStatus } from '../types';
import { ManifexusAppIcon, UpdateGlyph } from './SoftwareUpdateSheet';
import { ios } from './ui/ios';
import { LiquidGlass } from './ui/LiquidGlass';
import { BlurIn } from './GettingStarted';
import { enter } from '../motion';

interface ManifexusHeroHeaderProps {
  container?: DeepContainerMetadata;
  systemStatus: SystemStatus | null;
  onInspectContainer?: (container: DeepContainerMetadata) => void;
  versionLabel?: string;
  updateAvailable?: boolean;
  /** An update is being installed right now */
  updating?: boolean;
  onOpenUpdates?: () => void;
  onOpenActivity: () => void;
  /** Something failed since Activity was last opened */
  activityAlert?: boolean;
  /** Opens Restore */
  onOpenRestore?: () => void;
  /** Opens Backups, and its status in plain words (the button's dot: blue while backing up, orange when it needs you) */
  onOpenBackups?: () => void;
  backupsStatus?: { tone: 'ok' | 'busy' | 'attention' | 'off'; title: string; detail: string } | null;
  /** Opens Server Cleanup */
  onOpenCleanup?: () => void;
  /** Ask Manifexus (the built-in AI) */
  onOpenAssistant?: () => void;
  onOpenSettings: () => void;
  /** No longer shown: the dashboard refreshes itself */
  onRefresh?: () => void;
  isRefreshing?: boolean;
  /** Search apps, beside New Stack under the toolbar */
  search?: string;
  onSearch?: (q: string) => void;
  onNewStack?: () => void;
  /** Older backups being moved into the backup store, shown live (and briefly when it finishes) */
  backupUpgrade?: { running: boolean; total: number; done: number; failed: number; savedBytes: number; finishedAt?: string } | null;
}

function fmtSize(b: number): string {
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** Status capsule: older backups moving into the backup store. Opens Restore. */
const BackupUpgradeStatus: React.FC<{ s: NonNullable<ManifexusHeroHeaderProps['backupUpgrade']>; onOpen?: () => void }> = ({ s, onOpen }) => {
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  const ok = s.done - s.failed;
  return (
    <div ref={enter('rise')} className="mt-3 max-w-[30rem]">
      <LiquidGlass className="rounded-full">
        <button
          type="button"
          onClick={onOpen}
          title={
            s.running
              ? 'Older backups are moving into the backup store, which keeps only one copy of what’s the same in every backup. Each one is checked before its old copy is removed. You can keep using Manifexus.'
              : 'Older backups are now in the backup store. Click to open Restore.'
          }
          aria-label={s.running ? `Updating older backups: ${s.done} of ${s.total}` : 'Older backups updated'}
          className="relative w-full flex items-center gap-2.5 h-8 pl-3 pr-3.5 rounded-full text-[13px] overflow-hidden transition-colors hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]"
        >
          {s.running ? (
            <span className="w-3.5 h-3.5 flex-shrink-0 rounded-full border-2 border-[rgba(235,235,245,0.25)] border-t-[#64B5FF] animate-spin motion-reduce:animate-none" aria-hidden />
          ) : (
            <span className="w-3.5 h-3.5 flex-shrink-0 rounded-full flex items-center justify-center" style={{ background: s.failed ? ios.orange : ios.green }} aria-hidden>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                {s.failed ? <path d="M12 7v6M12 17h.01" /> : <path ref={enter('draw')} d="M5 12.5l4.5 4.5L19 7.5" />}
              </svg>
            </span>
          )}
          <span className={`font-medium whitespace-nowrap ${s.running ? 'mfx-shimmer' : ''}`} style={{ color: ios.label }}>
            {s.running ? 'Updating older backups' : 'Older backups updated'}
          </span>
          <span className="tabular-nums whitespace-nowrap truncate" style={{ color: ios.secondary }}>
            {s.running ? `${s.done} of ${s.total}` : s.failed ? `${ok} of ${s.total} · ${s.failed} try again later` : `${s.total}`}
            {s.savedBytes > 0 ? ` · ${fmtSize(s.savedBytes)} freed` : ''}
          </span>
          {s.running && (
            <span className="absolute left-3 right-3.5 bottom-[3px] h-[2px] rounded-full" style={{ background: 'rgba(118,118,128,0.3)' }} aria-hidden>
              <span className="block h-full rounded-full transition-[width] duration-500 ease-out" style={{ width: `${Math.max(4, pct)}%`, background: ios.blue }} />
            </span>
          )}
        </button>
      </LiquidGlass>
    </div>
  );
};

const SearchGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </svg>
);

/** A button inside the glass toolbar. The label hides on narrower screens; the tooltip always explains it. */
const ToolButton: React.FC<{
  icon: React.ReactNode;
  label: string;
  tip: string;
  onClick: () => void;
  tone?: 'default' | 'blue' | 'red';
  align?: 'center' | 'end';
}> = ({ icon, label, tip, onClick, tone = 'default' }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    data-tip={tip}
    className="group relative inline-flex items-center gap-1.5 h-8 px-2.5 xl:px-3 rounded-full text-[13px] font-medium transition-colors hover:bg-white/[0.08] active:bg-white/[0.12] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]"
    style={{
      color: tone === 'blue' ? '#6CB6FF' : tone === 'red' ? '#FF8A80' : 'rgba(255,255,255,0.88)',
      background: tone === 'blue' ? 'rgba(10,132,255,0.18)' : undefined,
    }}
  >
    {icon}
    <span className="hidden xl:inline">{label}</span>
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
  onOpenActivity,
  activityAlert,
  onOpenRestore,
  onOpenBackups,
  backupsStatus,
  onOpenCleanup,
  onOpenAssistant,
  onOpenSettings,
  onRefresh,
  isRefreshing,
  search = '',
  onSearch,
  onNewStack,
  backupUpgrade,
}) => {
  const port = container?.ports?.[0]?.publicPort || 3334;
  const socketOn = !!systemStatus?.dockerConnected;
  // The server labels builds "Version 1.1", "Build <revision>" or "Development build"; show just the number
  const isVersion = Boolean(versionLabel?.startsWith('Version '));
  const build = !versionLabel ? undefined : isVersion ? versionLabel!.slice(8) : versionLabel.startsWith('Build ') ? versionLabel.slice(6) : 'dev';
  const iconCls = 'w-[15px] h-[15px]';
  // The very first time Manifexus opens, its name comes into focus; never again after that
  const [welcome] = useState(() => {
    try {
      const seen = localStorage.getItem('manifexus.welcomed');
      localStorage.setItem('manifexus.welcomed', '1');
      return !seen;
    } catch {
      return false;
    }
  });

  return (
    <section
      // Open: no panel. The name, toolbar and search sit right on the page; the stacks are the glass
      className="relative w-full mb-6"
      style={{ fontFamily: ios.font }}
    >
      <div className="relative px-1 sm:px-2 pt-4 sm:pt-6 pb-2">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-5">
          {/* Identity */}
          <div className="flex items-start sm:items-center gap-4 sm:gap-5 min-w-0">
            <button
              type="button"
              onClick={container && onInspectContainer ? () => onInspectContainer(container) : undefined}
              aria-label={`${socketOn ? 'Connected to Docker' : 'Not connected to Docker'}. Dashboard port ${port}. Open Diagnostics`}
              className="group relative flex-shrink-0 w-12 h-12 sm:w-16 sm:h-16 rounded-[14px] [&_svg.mfx]:w-full [&_svg.mfx]:h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]"
              style={{ filter: 'drop-shadow(0 10px 22px rgba(47,140,255,0.35))' }}
              {...tipProps(
                <span className="block w-[226px] py-1.5 px-1">
                <span className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: socketOn ? ios.green : '#FF6961' }}>
                  <span className="w-2 h-2 rounded-full" style={{ background: 'currentColor', boxShadow: '0 0 8px currentColor' }} />
                  {socketOn ? 'Connected to Docker' : 'Not connected to Docker'}
                </span>
                <span className="block mt-1 text-[13px] leading-[17px]" style={{ color: 'rgba(235,235,245,0.75)' }}>
                  {socketOn ? 'Manifexus can see and manage your apps.' : 'Manifexus can’t see or manage your apps. Check that the Docker socket is mounted.'}
                </span>
                <span className="mt-2.5 pt-2.5 flex items-center justify-between text-[13px]" style={{ borderTop: '0.5px solid rgba(255,255,255,0.1)', color: 'rgba(235,235,245,0.6)' }}>
                  Dashboard port
                  <span className="font-semibold tabular-nums text-white">{port}</span>
                </span>
                <span className="block mt-2 text-[12px]" style={{ color: 'rgba(235,235,245,0.45)' }}>
                  Click for Diagnostics
                </span>
                              </span>,
                { wide: true },
              )}
            >
              <span className="block w-full h-full [&>svg]:w-full [&>svg]:h-full">
                <ManifexusAppIcon size={64} />
              </span>
              {/* The light: Manifexus's connection to Docker */}
              <span
                className={`absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full ${socketOn ? '' : 'motion-safe:animate-pulse'}`}
                style={{ background: socketOn ? ios.green : ios.red, boxShadow: '0 0 0 3px #0e1629' }}
                aria-hidden="true"
              />
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1
                  className="text-[28px] sm:text-[34px] leading-none font-bold"
                  style={{
                    fontFamily: 'var(--mfx-sans)',
                    letterSpacing: '-0.035em',
                    // (While the name comes into focus the first time, plain white: the letters move on their own)
                    ...(welcome
                      ? { color: '#fff' }
                      : { backgroundImage: 'linear-gradient(180deg, #ffffff 0%, #e4e4ea 45%, #9a9aa6 100%)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }),
                  }}
                >
                  {welcome ? <BlurIn text="Manifexus" /> : 'Manifexus'}
                </h1>
                {build && (
                  <button
                    type="button"
                    onClick={onOpenUpdates}
                    title={updateAvailable ? 'A new version is ready. Click to open Updates.' : 'The version you’re running. Click to open Updates.'}
                    className="self-center mt-1 inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-[12px] font-semibold tabular-nums transition-colors hover:brightness-125 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]"
                    style={
                      updateAvailable
                        ? { background: 'rgba(10,132,255,0.18)', color: '#6CB6FF', boxShadow: 'inset 0 0 0 0.5px rgba(10,132,255,0.55)' }
                        : { background: 'rgba(118,118,128,0.16)', color: 'rgba(235,235,245,0.6)' }
                    }
                  >
                    {isVersion ? build : `Build ${build}`}
                    {updateAvailable && (
                      <>
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: ios.blue }} />
                        Update
                      </>
                    )}
                  </button>
                )}
              </div>
              <p className="mt-2 text-[13px] sm:text-[15px] leading-[1.45] max-w-[34rem]" style={{ color: ios.secondary }}>
                All your Docker apps in one place. See what&rsquo;s running, organize apps into stacks, and move them
                safely, with a backup before every change.
              </p>
              {backupUpgrade && <BackupUpgradeStatus s={backupUpgrade} onOpen={onOpenRestore} />}
            </div>
          </div>

          {/* Toolbar (records, then system), and under it search and New Stack */}
          <div className="w-full sm:w-auto sm:self-start lg:self-auto flex-shrink-0 flex flex-col gap-2.5">
          {/* Liquid Glass: the controls float above the page, like Apple's */}
          <LiquidGlass shadow="0 12px 30px -16px rgba(0,0,0,0.7)">
          <nav aria-label="Manifexus" className="flex items-center justify-between sm:justify-start gap-0.5 p-1 rounded-full">
            {onOpenAssistant && (
              <>
                <ToolButton icon={<Sparkles className={iconCls} />} label="Ask" tip="Ask Manifexus: the built-in AI can look at your apps and fix things with your OK." onClick={onOpenAssistant} />
                <Divider />
              </>
            )}
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
            {onOpenBackups && (
              <ToolButton
                icon={
                  <span className="relative flex">
                    <ShieldCheck className={iconCls} />
                    {(backupsStatus?.tone === 'busy' || backupsStatus?.tone === 'attention') && (
                      <span
                        className={`absolute -top-1 -right-1 w-2 h-2 rounded-full ${backupsStatus.tone === 'busy' ? 'motion-safe:animate-pulse' : ''}`}
                        style={{ background: backupsStatus.tone === 'busy' ? ios.blue : ios.orange, boxShadow: '0 0 0 2px #26262a' }}
                      />
                    )}
                  </span>
                }
                label="Backups"
                tip={backupsStatus ? `${backupsStatus.title}. ${backupsStatus.detail}` : 'Every stack, backed up automatically.'}
                onClick={onOpenBackups}
              />
            )}
            {onOpenRestore && (
              <ToolButton
                icon={<History className={iconCls} />}
                label="Restore"
                tip="Go back to before a move or delete. Every change keeps a backup."
                onClick={onOpenRestore}
              />
            )}
            {onOpenCleanup && (
              <ToolButton
                icon={<Eraser className={iconCls} />}
                label="Clean Up"
                tip="Find folders on your server that no app uses anymore, and delete the ones you pick."
                onClick={onOpenCleanup}
              />
            )}
            <Divider />
            {container && onInspectContainer && (
              <ToolButton
                icon={<Stethoscope className={iconCls} />}
                label="Diagnostics"
                tip="Health checks, resources and details for Manifexus."
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
                align="end"
              />
            )}
            <ToolButton
              icon={<Settings className={iconCls} />}
              label="Settings"
              tip="Stacks folder, refresh rate, Server Changes and more."
              onClick={onOpenSettings}
              align="end"
            />
          </nav>
          </LiquidGlass>
          {(onSearch || onNewStack) && (
            <div className="flex items-center gap-2">
              {onSearch && (
                <LiquidGlass className="flex-1 min-w-0 rounded-full focus-within:ring-2 focus-within:ring-[#0A84FF]">
                <label className="flex items-center gap-2 h-9 pl-3.5 pr-2 rounded-full" style={{ color: ios.secondary }}>
                  <SearchGlyph />
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => onSearch(e.target.value)}
                    onKeyDown={(e) => e.key === 'Escape' && onSearch('')}
                    placeholder="Search apps"
                    aria-label="Search apps"
                    className="flex-1 min-w-0 bg-transparent outline-none text-[15px] text-white placeholder:text-[rgba(235,235,245,0.45)] [&::-webkit-search-cancel-button]:hidden"
                  />
                  {search && (
                    <button type="button" onClick={() => onSearch('')} aria-label="Clear search" className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] text-black" style={{ background: 'rgba(235,235,245,0.45)' }}>
                      ✕
                    </button>
                  )}
                </label>
                </LiquidGlass>
              )}
              {onNewStack && (
                <LiquidGlass tint="rgba(10,132,255,0.22)" className="flex-shrink-0">
                <button
                  type="button"
                  onClick={onNewStack}
                  className="inline-flex items-center gap-1.5 h-9 pl-3 pr-4 rounded-full text-[15px] font-semibold transition-all hover:brightness-125 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]"
                  // Blue-tinted glass: the main action, in the same material as everything around it
                  style={{ boxShadow: 'inset 0 0 0 1px rgba(10,132,255,0.35)', color: '#7DBEFF' }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" aria-hidden>
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  New Stack
                </button>
                </LiquidGlass>
              )}
            </div>
          )}
          </div>
        </div>

      </div>
    </section>
  );
};
