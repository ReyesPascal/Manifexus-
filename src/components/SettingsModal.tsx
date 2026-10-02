import React, { useEffect, useRef, useState } from 'react';
import { BackButton, FieldRow, Group, Row, SectionFooter, SectionHeader, Segmented, Sheet, Switch, ios } from './ui/ios';
import { ManifexusConfig, AutomationPrivileges } from '../types';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: ManifexusConfig | null;
  /** Saves the changed settings; throws when the save didn't go through */
  onSaveConfig: (updated: Partial<ManifexusConfig>) => Promise<void>;
  /** The folder Manifexus would use if no location is saved (shown as the placeholder) */
  detectedStacksDir?: string;
  privileges?: AutomationPrivileges | null;
  /** Opens the Host Automation & Privileges window */
  onOpenAutomationModal?: () => void;
  /** Runs Getting Started (setup and tour) again */
  onRunGettingStarted?: () => void;
  /** Opens the built-in AI's settings */
  onOpenAssistant?: () => void;
  /** Opened from another screen (e.g. Diagnostics): shows "‹ label" to go back to it */
  backLabel?: string;
  onBack?: () => void;
}

type Field = 'host' | 'dir' | 'refresh' | 'mode' | 'commands' | 'size' | 'fit';

/** Small green check shown in a row for a moment after it saves */
const SavedCheck: React.FC = () => (
  <svg width="15" height="12" viewBox="0 0 14 11" aria-label="Saved" className="flex-shrink-0 motion-safe:animate-[ios-fade-in_150ms_ease-out]">
    <path d="M1.5 5.8 5.2 9.5 12.5 1.5" fill="none" stroke={ios.green} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * Settings save as you change them, like the iPhone's Settings app: choices save on tap, text
 * fields when you press Enter or leave the field. No Save or Cancel; Done just closes.
 */
export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  config,
  onSaveConfig,
  detectedStacksDir,
  privileges,
  onOpenAutomationModal,
  onRunGettingStarted,
  backLabel,
  onBack,
  onOpenAssistant,
}) => {
  const [hostAddress, setHostAddress] = useState(config?.hostAddress || 'localhost');
  const [refreshInterval, setRefreshInterval] = useState(config?.refreshIntervalSeconds || 10);
  const [stacksDir, setStacksDir] = useState(config?.stacksDir || '');
  const [dirError, setDirError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: 'saving' | 'saved' | 'failed'; field: Field } | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (isOpen) {
      setHostAddress(config?.hostAddress || 'localhost');
      setRefreshInterval(config?.refreshIntervalSeconds || 10);
      setStacksDir(config?.stacksDir || '');
      setDirError(null);
      setStatus(null);
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => clearTimeout(clearTimer.current), []);

  const isElevated = privileges?.mode === 'elevated';

  const save = async (field: Field, patch: Partial<ManifexusConfig>) => {
    clearTimeout(clearTimer.current);
    setStatus({ kind: 'saving', field });
    try {
      await onSaveConfig(patch);
      setStatus({ kind: 'saved', field });
      clearTimer.current = setTimeout(() => setStatus(null), 2200);
    } catch {
      setStatus({ kind: 'failed', field });
    }
  };

  /** Text fields save when they're done being edited, and only if something changed */
  const commitHost = () => {
    const v = hostAddress.trim() || 'localhost';
    if (v !== hostAddress) setHostAddress(v);
    if (v !== (config?.hostAddress || 'localhost')) void save('host', { hostAddress: v });
  };
  const commitDir = () => {
    const dir = stacksDir.trim().replace(/\/+$/, '');
    if (dir && !dir.startsWith('/')) {
      setDirError('The stack location must be a full path starting with /, like /home/you/stacks.');
      return;
    }
    setDirError(null);
    if (dir !== stacksDir) setStacksDir(dir);
    if (dir !== (config?.stacksDir || '')) void save('dir', { stacksDir: dir });
  };

  // Closing (Done, Escape, backdrop) saves anything still being typed
  const close = () => {
    commitHost();
    commitDir();
    onClose();
  };

  const refreshOptions = Array.from(new Set([5, 10, 30, 60, Number(refreshInterval) || 10])).sort((a, b) => a - b);
  const savedIn = (f: Field) => (status?.kind === 'saved' && status.field === f ? <SavedCheck /> : null);

  return (
    <Sheet
      open={isOpen}
      onClose={close}
      title="Settings"
      leftAction={backLabel && onBack ? <BackButton label={backLabel} onClick={() => { commitHost(); commitDir(); onBack(); }} /> : undefined}
      footer={
        <div className="flex items-center justify-between text-[13px] min-h-[20px]" style={{ color: ios.secondary }}>
          <span>Changes save as you make them.</span>
          {status && (
            <span
              key={`${status.kind}-${status.field}`}
              className="inline-flex items-center gap-1.5 font-medium motion-safe:animate-[ios-fade-in_150ms_ease-out]"
              style={{ color: status.kind === 'failed' ? ios.red : status.kind === 'saved' ? ios.green : ios.secondary }}
            >
              {status.kind === 'saved' && <SavedCheck />}
              {status.kind === 'saving' ? 'Saving…' : status.kind === 'saved' ? 'Saved' : 'Couldn’t save. Try again.'}
            </span>
          )}
        </div>
      }
    >
      <div className="space-y-7">
        <section>
          <SectionHeader>Server Address</SectionHeader>
          <Group>
            <FieldRow
              id="settings-host"
              label="Address"
              value={hostAddress}
              onChange={setHostAddress}
              onCommit={commitHost}
              trailing={savedIn('host')}
              placeholder="192.168.1.150 or homelab.local"
              mono
            />
          </Group>
          <SectionFooter>Used for the links on app cards, like http://{hostAddress || 'localhost'}:8080.</SectionFooter>
        </section>

        <section>
          <SectionHeader>New Stacks</SectionHeader>
          <Group>
            <FieldRow
              id="settings-stacks-dir"
              label="Location"
              value={stacksDir}
              onChange={(v) => {
                setStacksDir(v);
                setDirError(null);
              }}
              onCommit={commitDir}
              trailing={savedIn('dir')}
              placeholder={detectedStacksDir ? `Automatic (${detectedStacksDir})` : 'Automatic'}
              mono
              invalid={Boolean(dirError)}
            />
          </Group>
          <SectionFooter tone={dirError ? 'danger' : 'default'}>
            {dirError || 'The folder on your server where new stacks are created. Leave it empty to use the folder your stacks are already in.'}
          </SectionFooter>
        </section>

        <section>
          <SectionHeader>Refresh Every</SectionHeader>
          <Segmented
            label="Refresh every"
            value={String(refreshInterval)}
            onChange={(v) => {
              const n = Number(v);
              setRefreshInterval(n);
              void save('refresh', { refreshIntervalSeconds: n });
            }}
            options={refreshOptions.map((n) => ({ value: String(n), label: `${n} s` }))}
          />
          <SectionFooter>How often the dashboard checks Docker for new apps and status changes.</SectionFooter>
        </section>

        {onRunGettingStarted && (
          <section>
            <Group>
              <Row onClick={onRunGettingStarted} title="Getting Started" trailing={<span style={{ color: ios.blue }}>Run Again</span>} chevron />
            </Group>
            <SectionFooter>The setup and the tour of your dashboard from when you first started Manifexus.</SectionFooter>
          </section>
        )}

        {onOpenAutomationModal && (
          <section>
            <Group>
              <Row
                onClick={onOpenAutomationModal}
                title="Server Changes"
                trailing={
                  <span className="inline-flex items-center gap-1.5" style={{ color: isElevated ? ios.green : ios.secondary }}>
                    <span className="w-[7px] h-[7px] rounded-full" style={{ background: 'currentColor' }} />
                    {privileges?.allowChanges ? 'On' : 'Off'}
                  </span>
                }
                chevron
              />
            </Group>
            <SectionFooter>
              {privileges?.allowChanges
                ? 'Manifexus can move apps, restore backups and fix problems on your server.'
                : 'Manifexus only shows your apps and starts, stops or restarts them.'}
            </SectionFooter>
          </section>
        )}

        <section>
          <SectionHeader>How Manifexus Looks</SectionHeader>
          <Segmented
            label="Experience"
            value={config?.experienceMode === 'advanced' ? 'advanced' : 'simple'}
            // Switching modes sets Show Commands to match (on in Advanced); it can still be changed on its own
            onChange={(v) => void save('mode', { experienceMode: v as 'simple' | 'advanced', showCommands: v === 'advanced' })}
            options={[
              { value: 'simple', label: 'Simple' },
              { value: 'advanced', label: 'Advanced' },
            ]}
          />
          <div className="mt-3">
            <Group>
              <Row
                title="Show Commands"
                subtitle="The command behind each step, explained, with Copy"
                trailing={
                  <span className="flex items-center gap-2">
                    {savedIn('commands')}
                    <Switch
                      checked={config?.showCommands ?? config?.experienceMode === 'advanced'}
                      onChange={(v) => void save('commands', { showCommands: v })}
                      label="Show commands"
                    />
                  </span>
                }
              />
            </Group>
          </div>
          <SectionFooter>
            Simple keeps screens clean. Advanced is for people who like to see how things work: every step shows its command, explained. Either
            way, Show Commands in any activity reveals them, and Activity → Commands lists them all.
          </SectionFooter>
        </section>

        <section>
          <SectionHeader>Size</SectionHeader>
          <Segmented
            label="Card size"
            value={config?.cardSize || 'default'}
            onChange={(v) => void save('size', { cardSize: v as 'small' | 'default' | 'large' | 'larger' })}
            options={[
              { value: 'small', label: 'Small' },
              { value: 'default', label: 'Default' },
              { value: 'large', label: 'Large' },
              { value: 'larger', label: 'Larger' },
            ]}
          />
          <div className="mt-3">
            <Group>
              <Row
                title="Fit All Stacks on Screen"
                subtitle="Shrinks to show every stack at once, but never too small to read"
                trailing={
                  <span className="flex items-center gap-2">
                    {savedIn('fit')}
                    <Switch checked={Boolean(config?.fitAllStacks)} onChange={(v) => void save('fit', { fitAllStacks: v })} label="Fit all stacks on screen" />
                  </span>
                }
              />
            </Group>
          </div>
          <SectionFooter>
            Ctrl + and Ctrl − change the size from the dashboard too (⌘ on a Mac). When you drag an app, the dashboard zooms out to show
            every stack, and comes back once it lands.
          </SectionFooter>
        </section>

        {onOpenAssistant && (
          <section>
            <SectionHeader>Built-in AI</SectionHeader>
            <Group>
              <Row onClick={onOpenAssistant} title="Built-in AI" subtitle="Fixes problems Diagnostics finds: its model, and what it may do" chevron />
            </Group>
          </section>
        )}

        <p className="text-[12px] text-center" style={{ color: ios.tertiary }}>
          Settings are saved in /data/config.json on your server.
        </p>
      </div>
    </Sheet>
  );
};
