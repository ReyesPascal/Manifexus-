import React, { useEffect, useState } from 'react';
import { DeepContainerMetadata } from '../types';
import { AppIcon } from './AppCard';
import { helperKind } from '../appHelpers';
import { Health, InlineName, displayFont } from './Shelf';
import { StackIcon, StackIconChoice, StackIconPicker } from '../stackIcons';
import { copyText } from './ActivitySheet';
import { Button, Group, MenuItem, Row, SectionFooter, SectionHeader, Sheet, ios } from './ui/ios';

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
  helpersOf?: Map<string, DeepContainerMetadata[]>;
  workingDir?: string;
  composeFile?: string;
  onClose: () => void;
  onOpenApp: (c: DeepContainerMetadata) => void;
  onAddApp: () => void;
  onEditCompose?: () => void;
  onOpenRestore: () => void;
  onDelete?: () => void;
  /** The name you gave it on the dashboard */
  displayName?: string;
  /** The icon you picked, if any */
  iconChoice?: StackIconChoice;
  onChooseIcon?: (choice: StackIconChoice | undefined) => void;
  /** Give it a name on the dashboard (empty goes back to the folder's name) */
  onRename?: (name: string) => void;
  /** Start, Restart and Stop for all its apps */
  actions?: MenuItem[];
  /** For apps not in a stack: their own icon, a note under the health, and what the main button says */
  icon?: React.ReactNode;
  note?: string;
  addLabel?: string;
}> = ({ project, apps, helpersOf, workingDir, composeFile, onClose, onOpenApp, onAddApp, onEditCompose, onOpenRestore, onDelete, displayName, iconChoice, onChooseIcon, onRename, actions = [], icon, note, addLabel = 'Add App' }) => {
  const [picking, setPicking] = useState(false);
  const [renaming, setRenaming] = useState(false);
  useEffect(() => setRenaming(false), [project]);
  if (!project) return null;
  return (
    <Sheet open title={icon ? "Details" : "Stack Details"} onClose={onClose} zIndex={55}>
      <div className="space-y-7">
        <div className="flex flex-col items-center text-center pt-2">
          <button
            type="button"
            onClick={onChooseIcon ? () => setPicking(true) : undefined}
            className="group flex flex-col items-center gap-1.5 rounded-[18px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]"
            aria-label="Choose an icon for this stack"
          >
            {icon || <StackIcon name={displayName || project} apps={apps} choice={iconChoice} size={72} />}
            {onChooseIcon && (
              <span className="text-[13px] font-medium group-hover:opacity-80" style={{ color: ios.link }}>
                Edit Icon
              </span>
            )}
          </button>
          {onChooseIcon && (
            <StackIconPicker
              open={picking}
              name={displayName || project}
              current={iconChoice}
              onClose={() => setPicking(false)}
              onChoose={(c) => {
                onChooseIcon(c);
                setPicking(false);
              }}
            />
          )}
          {renaming && onRename ? (
            <InlineName
              value={displayName && displayName !== project ? displayName : ''}
              original={project}
              onSave={(n) => {
                setRenaming(false);
                onRename(n);
              }}
              onCancel={() => setRenaming(false)}
              className="mt-3.5 text-[22px] leading-[29px] h-[36px] font-semibold text-center max-w-[320px]"
              style={{ fontFamily: displayFont, letterSpacing: '-0.02em' }}
            />
          ) : (
            <h3 className="mt-3.5 text-[22px] leading-[29px] font-semibold text-white" style={{ fontFamily: displayFont, letterSpacing: '-0.02em' }}>
              {displayName || project}
            </h3>
          )}
          {displayName && displayName !== project && (
            <div className="mt-0.5 text-[13px] font-mono" style={{ color: ios.secondary }}>
              {project}
            </div>
          )}
          <div className="mt-1 text-[15px]" style={{ color: ios.secondary }}>
            <Health apps={apps} alsoCheck={apps.flatMap((a) => helpersOf?.get(a.id) || [])} />
            {note && ` · ${note}`}
          </div>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button onClick={onAddApp} variant="tinted" className="!h-[36px] !px-4 !text-[15px]">
              {addLabel}
            </Button>
            {onRename && !renaming && (
              <Button onClick={() => setRenaming(true)} tone="gray" className="!h-[36px] !px-4 !text-[15px]">
                Rename
              </Button>
            )}
            {onEditCompose && (
              <Button onClick={onEditCompose} tone="gray" className="!h-[36px] !px-4 !text-[15px]">
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
                    {(helpersOf?.get(c.id) || []).length > 0 && ` · ${helpersOf!.get(c.id)!.map((h) => `${helperKind(h)} linked`).join(', ')}`}
                  </span>
                }
                chevron
              />
            ))}
          </Group>
          {actions.length > 0 && (
            <Group className="mt-3">
              {actions.map((a) => (
                <Row key={a.key} onClick={a.onSelect} title={<span style={{ color: a.destructive ? ios.red : ios.blue }}>{a.label}</span>} />
              ))}
            </Group>
          )}
        </section>

        {(workingDir || composeFile) && (
        <section>
          <SectionHeader>Where It Lives</SectionHeader>
          <Group>
            {workingDir && <CopyRow title="Folder" value={workingDir} />}
            {composeFile && <CopyRow title="Compose File" value={composeFile} />}
          </Group>
          <SectionFooter>Tap a path to copy it.</SectionFooter>
        </section>
        )}

        <section>
          <Group>
            <Row onClick={onOpenRestore} title="Restore" subtitle="Go back to before any change to this stack" chevron />
            {onDelete && <Row onClick={onDelete} title={<span style={{ color: ios.redText }}>Delete Stack…</span>} />}
          </Group>
          {onDelete && <SectionFooter>Deleting keeps a full backup first, so it can be undone from Restore.</SectionFooter>}
        </section>
      </div>
    </Sheet>
  );
};
