import React, { useState } from 'react';
import { DeepContainerMetadata } from '../types';
import { AppIcon } from './AppCard';
import { FolderIcon, Health, displayFont } from './Shelf';
import { copyText } from './ActivitySheet';
import { Button, Group, Row, SectionFooter, SectionHeader, Sheet, ios } from './ui/ios';

const STATE: Record<string, string> = {
  running: 'Running',
  restarting: 'Keeps restarting',
  paused: 'Paused',
  created: 'Not started',
  exited: 'Stopped',
  dead: 'Stopped',
};

const CopyRow: React.FC<{ title: string; value: string }> = ({ title, value }) => {
  const [copied, setCopied] = useState(false);
  return (
    <Row
      onClick={async () => {
        if (await copyText(value)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }
      }}
      title={title}
      trailing={
        <span className="block truncate max-w-[52vw] sm:max-w-[420px] font-mono text-[13px]" style={{ color: copied ? ios.green : undefined, direction: copied ? undefined : 'rtl' }}>
          {copied ? 'Copied' : <bdi>{value}</bdi>}
        </span>
      }
    />
  );
};

/** One stack: its apps, where it lives, and what you can do with it */
export const StackDetailsSheet: React.FC<{
  project: string | null;
  apps: DeepContainerMetadata[];
  workingDir?: string;
  composeFile?: string;
  onClose: () => void;
  onOpenApp: (c: DeepContainerMetadata) => void;
  onAddApp: () => void;
  onEditCompose?: () => void;
  onOpenRestore: () => void;
  onDelete?: () => void;
}> = ({ project, apps, workingDir, composeFile, onClose, onOpenApp, onAddApp, onEditCompose, onOpenRestore, onDelete }) => {
  if (!project) return null;
  return (
    <Sheet open title="Stack Details" onClose={onClose} zIndex={55}>
      <div className="space-y-7">
        <div className="flex flex-col items-center text-center pt-2">
          <FolderIcon apps={apps} size={72} />
          <h3 className="mt-3.5 text-[24px] leading-[29px] font-semibold text-white" style={{ fontFamily: displayFont, letterSpacing: '-0.02em' }}>
            {project}
          </h3>
          <div className="mt-1 text-[14px]" style={{ color: ios.secondary }}>
            <Health apps={apps} />
          </div>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button onClick={onAddApp} variant="tinted" className="!h-[36px] !px-4 !text-[14px]">
              Add App
            </Button>
            {onEditCompose && (
              <Button onClick={onEditCompose} tone="gray" className="!h-[36px] !px-4 !text-[14px]">
                Edit Compose File
              </Button>
            )}
          </div>
        </div>

        <section>
          <SectionHeader>Apps</SectionHeader>
          <Group className="ios-inset-icon">
            {apps.length === 0 && <Row title={<span style={{ color: ios.secondary }}>No apps yet</span>} />}
            {apps.map((c) => (
              <Row
                key={c.id}
                onClick={() => onOpenApp(c)}
                leading={<AppIcon container={c} size={29} />}
                title={c.customName || c.friendlyName || c.cleanName}
                subtitle={
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-[7px] h-[7px] rounded-full" style={{ background: c.state === 'running' ? ios.green : c.state === 'restarting' ? ios.red : '#8E8E93' }} />
                    {STATE[c.state] || c.state}
                  </span>
                }
                chevron
              />
            ))}
          </Group>
        </section>

        <section>
          <SectionHeader>Where It Lives</SectionHeader>
          <Group>
            {workingDir && <CopyRow title="Folder" value={workingDir} />}
            {composeFile && <CopyRow title="Compose File" value={composeFile} />}
          </Group>
          <SectionFooter>Tap a path to copy it.</SectionFooter>
        </section>

        <section>
          <Group>
            <Row onClick={onOpenRestore} title="Restore" subtitle="Go back to before any change to this stack" chevron />
            {onDelete && <Row onClick={onDelete} title={<span style={{ color: ios.red }}>Delete Stack…</span>} />}
          </Group>
          {onDelete && <SectionFooter>Deleting keeps a full backup first, so it can be undone from Restore.</SectionFooter>}
        </section>
      </div>
    </Sheet>
  );
};
