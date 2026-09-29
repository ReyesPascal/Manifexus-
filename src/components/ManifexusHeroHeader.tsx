import React from 'react';
import { Activity, History, Stethoscope, Settings, RefreshCw, Sparkles, Eraser } from 'lucide-react';
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
  onOpenActivity: () => void;
  /** Something failed since Activity was last opened */
  activityAlert?: boolean;
  /** Opens Restore */
  onOpenRestore?: () => void;
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
}

const SearchGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </svg>
);

/** Hover/focus tooltip. Wrap it in an element with the `group` class. */
const Tip: React.FC<{ text: string; side?: 'top' | 'bottom'; align?: 'center' | 'end' }> = ({
  text,
  side = 'top',
  align = 'center',
}) => (
  <span
    role="tooltip"
    // Phones have no hover, so tooltips aren't laid out there (they'd widen the page)
    className={`max-sm:hidden pointer-events-none absolute z-30 w-max max-w-[230px] rounded-[10px] px-2.5 py-1.5 text-[11.5px] leading-snug font-normal normal-case tracking-normal whitespace-normal text-left opacity-0 scale-95 transition-all duration-150 delay-200 group-hover:opacity-100 group-hover:scale-100 group-focus-visible:opacity-100 group-focus-visible:scale-100 ${
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
  onOpenActivity,
  activityAlert,
  onOpenRestore,
  onOpenCleanup,
  onOpenAssistant,
  onOpenSettings,
  onRefresh,
  isRefreshing,
  search = '',
  onSearch,
  onNewStack,
}) => {
  const port = container?.ports?.[0]?.publicPort || 3334;
  const socketOn = !!systemStatus?.dockerConnected;
  // The server labels builds "Version 1.1", "Build <revision>" or "Development build"; show just the number
  const isVersion = Boolean(versionLabel?.startsWith('Version '));
  const build = !versionLabel ? undefined : isVersion ? versionLabel!.slice(8) : versionLabel.startsWith('Build ') ? versionLabel.slice(6) : 'dev';
  const iconCls = 'w-[15px] h-[15px]';

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
              {/* What the light means, and where the dashboard lives */}
              <span
                role="tooltip"
                className="max-sm:hidden pointer-events-none absolute z-30 left-0 top-full mt-3 w-[250px] rounded-[12px] px-3.5 py-3 text-left opacity-0 scale-95 origin-top-left transition-all duration-150 delay-150 group-hover:opacity-100 group-hover:scale-100 group-focus-visible:opacity-100 group-focus-visible:scale-100"
                style={{ background: 'rgba(44,44,46,0.97)', boxShadow: '0 0 0 0.5px rgba(255,255,255,0.12), 0 12px 32px rgba(0,0,0,0.55)', fontFamily: ios.font }}
              >
                <span className="flex items-center gap-2 text-[13.5px] font-semibold" style={{ color: socketOn ? ios.green : '#FF6961' }}>
                  <span className="w-2 h-2 rounded-full" style={{ background: 'currentColor', boxShadow: '0 0 8px currentColor' }} />
                  {socketOn ? 'Connected to Docker' : 'Not connected to Docker'}
                </span>
                <span className="block mt-1 text-[12.5px] leading-[17px]" style={{ color: 'rgba(235,235,245,0.75)' }}>
                  {socketOn ? 'Manifexus can see and manage your apps.' : 'Manifexus can’t see or manage your apps. Check that the Docker socket is mounted.'}
                </span>
                <span className="mt-2.5 pt-2.5 flex items-center justify-between text-[12.5px]" style={{ borderTop: '0.5px solid rgba(255,255,255,0.1)', color: 'rgba(235,235,245,0.6)' }}>
                  Dashboard port
                  <span className="font-semibold tabular-nums text-white">{port}</span>
                </span>
                <span className="block mt-2 text-[11.5px]" style={{ color: 'rgba(235,235,245,0.45)' }}>
                  Click for Diagnostics
                </span>
              </span>
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 flex-wrap">
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
              <p className="mt-2 text-[13px] sm:text-[14px] leading-[1.45] max-w-[34rem]" style={{ color: ios.secondary }}>
                All your Docker apps in one place. See what&rsquo;s running, organize apps into stacks, and move them
                safely, with a backup before every change.
              </p>
            </div>
          </div>

          {/* Toolbar (records, then system), and under it search and New Stack */}
          <div className="w-full sm:w-auto sm:self-start lg:self-auto flex-shrink-0 flex flex-col gap-2.5">
          <nav
            aria-label="Manifexus"
            className="flex items-center justify-between sm:justify-start gap-0.5 p-1 rounded-full"
            style={{
              background: 'rgba(255,255,255,0.075)',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.16), inset 0 0 0 1px rgba(255,255,255,0.07)',
              backdropFilter: 'blur(24px) saturate(170%)',
            }}
          >
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
          {(onSearch || onNewStack) && (
            <div className="flex items-center gap-2">
              {onSearch && (
                <label
                  className="flex-1 min-w-0 flex items-center gap-2 h-9 pl-3.5 pr-2 rounded-full transition-shadow focus-within:ring-2 focus-within:ring-[#0A84FF]"
                  style={{ background: 'rgba(255,255,255,0.075)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.16), inset 0 0 0 1px rgba(255,255,255,0.07)', backdropFilter: 'blur(24px) saturate(170%)', color: ios.secondary }}
                >
                  <SearchGlyph />
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => onSearch(e.target.value)}
                    onKeyDown={(e) => e.key === 'Escape' && onSearch('')}
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
              )}
              {onNewStack && (
                <button
                  type="button"
                  onClick={onNewStack}
                  className="flex-shrink-0 inline-flex items-center gap-1.5 h-9 pl-3 pr-4 rounded-full text-[14px] font-semibold transition-all hover:brightness-125 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]"
                  // Blue-tinted glass: the main action, in the same material as everything around it
                  style={{
                    background: 'rgba(10,132,255,0.22)',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 0 0 1px rgba(10,132,255,0.35)',
                    backdropFilter: 'blur(24px) saturate(170%)',
                    color: '#64B5FF',
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" aria-hidden>
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  New Stack
                </button>
              )}
            </div>
          )}
          </div>
        </div>

      </div>
    </section>
  );
};
