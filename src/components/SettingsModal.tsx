import React, { useEffect, useState } from 'react';
import { Button, FieldRow, Group, Row, SectionFooter, SectionHeader, Segmented, Sheet, ios } from './ui/ios';
import { ManifexusConfig, AutomationPrivileges } from '../types';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: ManifexusConfig | null;
  onSaveConfig: (updated: Partial<ManifexusConfig>) => Promise<void>;
  /** The folder Manifexus would use if no location is saved (shown as the placeholder) */
  detectedStacksDir?: string;
  privileges?: AutomationPrivileges | null;
  /** Opens the Host Automation & Privileges window */
  onOpenAutomationModal?: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  config,
  onSaveConfig,
  detectedStacksDir,
  privileges,
  onOpenAutomationModal,
}) => {
  // Hooks must run on every render, so they come before the early return
  const [hostAddress, setHostAddress] = useState(config?.hostAddress || 'localhost');
  const [refreshInterval, setRefreshInterval] = useState(config?.refreshIntervalSeconds || 10);
  const [stacksDir, setStacksDir] = useState(config?.stacksDir || '');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setHostAddress(config?.hostAddress || 'localhost');
      setRefreshInterval(config?.refreshIntervalSeconds || 10);
      setStacksDir(config?.stacksDir || '');
      setSaveError(null);
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const isElevated = privileges?.mode === 'elevated';

  const handleSubmit = async () => {
    const dir = stacksDir.trim().replace(/\/+$/, '');
    if (dir && !dir.startsWith('/')) {
      setSaveError('The stack location must be a full path starting with /, like /home/you/stacks.');
      return;
    }
    setIsSaving(true);
    try {
      await onSaveConfig({
        hostAddress: hostAddress.trim() || 'localhost',
        refreshIntervalSeconds: Number(refreshInterval) || 10,
        stacksDir: dir,
      });
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  const refreshOptions = Array.from(new Set([5, 10, 30, 60, Number(refreshInterval) || 10])).sort((a, b) => a - b);

  return (
    <Sheet
      open={isOpen}
      onClose={onClose}
      title="Settings"
      leftAction={
        <button type="button" onClick={onClose} className="text-[17px] rounded hover:opacity-80 focus-visible:outline-2 focus-visible:outline-[#0A84FF]" style={{ color: ios.blue }}>
          Cancel
        </button>
      }
      rightAction={<span />}
      footer={
        <div className="flex justify-end">
          <Button onClick={() => handleSubmit()} disabled={isSaving} className="w-full sm:w-auto sm:min-w-[160px]">
            {isSaving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
        className="space-y-7"
      >
        <section>
          <SectionHeader>Server Address</SectionHeader>
          <Group>
            <FieldRow id="settings-host" label="Address" value={hostAddress} onChange={setHostAddress} placeholder="192.168.1.150 or homelab.local" mono />
          </Group>
          <SectionFooter>
            Used for the links on app cards, like http://{hostAddress || 'localhost'}:8080.
          </SectionFooter>
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
                setSaveError(null);
              }}
              placeholder={detectedStacksDir ? `Automatic (${detectedStacksDir})` : 'Automatic'}
              mono
              invalid={Boolean(saveError)}
            />
          </Group>
          <SectionFooter tone={saveError ? 'danger' : 'default'}>
            {saveError || 'The folder on your server where new stacks are created. Leave it empty to use the folder your stacks are already in.'}
          </SectionFooter>
        </section>

        <section>
          <SectionHeader>Refresh Every</SectionHeader>
          <Segmented
            label="Refresh every"
            value={String(refreshInterval)}
            onChange={(v) => setRefreshInterval(Number(v))}
            options={refreshOptions.map((n) => ({ value: String(n), label: `${n} s` }))}
          />
          <SectionFooter>How often the dashboard checks Docker for new apps and status changes.</SectionFooter>
        </section>

        {onOpenAutomationModal && (
          <section>
            <SectionHeader>Automation</SectionHeader>
            <Group>
              <Row
                onClick={onOpenAutomationModal}
                title="Automation Privileges"
                trailing={
                  <span className="inline-flex items-center gap-1.5" style={{ color: isElevated ? ios.green : ios.secondary }}>
                    <span className="w-[7px] h-[7px] rounded-full" style={{ background: 'currentColor' }} />
                    {isElevated ? 'Full' : 'Limited'}
                  </span>
                }
                chevron
              />
            </Group>
            <SectionFooter>
              {isElevated
                ? 'Manifexus can edit stack files on your server, so moves and restores run in one click.'
                : 'Manifexus can see containers but can’t edit files on your server. Tap to give it full access.'}
            </SectionFooter>
          </section>
        )}

        <p className="text-[12px] text-center" style={{ color: ios.tertiary }}>
          Settings are saved in /data/config.json on your server.
        </p>
        <button type="submit" hidden aria-hidden="true" />
      </form>
    </Sheet>
  );
};
