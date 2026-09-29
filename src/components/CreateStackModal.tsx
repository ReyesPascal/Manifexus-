import React, { useEffect, useMemo, useState } from 'react';
import { EmptyComposeStack } from '../types';
import { Button, FieldRow, Group, IconTile, LinkButton, Row, SectionFooter, SectionHeader, Sheet, ios } from './ui/ios';
import { IconTileFor, StackIconChoice, StackIconPicker, guessIcon } from '../stackIcons';

/**
 * New Stack: name it, see exactly which folder it becomes, and (optionally) put it somewhere else.
 * The name can be friendly ("Media Server"); the folder gets a safe version of it (media-server).
 * Once it's made, the next step is right there: Add Apps.
 */

interface CreateStackModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The stack was made; `name` is the friendly name typed (shown on the dashboard) */
  onSuccess: (newStack: EmptyComposeStack, name: string, icon?: StackIconChoice) => void;
  /** Open Add Apps for the new stack */
  onAddApps?: (project: string) => void;
  defaultBaseDir?: string;
  /** Stacks that already exist, so a taken name is caught while typing */
  existingProjects?: string[];
}

const slugify = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');


export const CreateStackModal: React.FC<CreateStackModalProps> = ({ isOpen, onClose, onSuccess, onAddApps, defaultBaseDir = '', existingProjects = [] }) => {
  const [name, setName] = useState('');
  const [customDir, setCustomDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ project: string; name: string; dir: string } | null>(null);
  // An icon you picked; until then it follows the name (a guessed symbol and colour)
  const [icon, setIcon] = useState<StackIconChoice | undefined>();
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setName('');
      setCustomDir(null);
      setError(null);
      setMade(null);
      setBusy(false);
      setIcon(undefined);
      setPicking(false);
    }
  }, [isOpen]);

  const slug = slugify(name);
  const base = (customDir ?? defaultBaseDir).trim().replace(/\/+$/, '');
  const folder = `${base || '/'}${base.endsWith('/') ? '' : '/'}${slug || '…'}`;
  const taken = useMemo(() => existingProjects.some((p) => p.toLowerCase() === slug), [existingProjects, slug]);
  const problem = !name.trim()
    ? null
    : slug.length < 2
      ? 'Use at least 2 letters or numbers.'
      : slug === 'manifexus'
        ? 'That name is used by Manifexus itself.'
        : taken
          ? `There’s already a stack called ${slug}.`
          : customDir !== null && !customDir.trim().startsWith('/')
            ? 'The location must be a full path, like /home/you/stacks.'
            : null;
  const ready = Boolean(slug) && slug.length >= 2 && !problem && !busy;
  const shownIcon = icon || guessIcon(name.trim() || 'stack');

  const create = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/stacks/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stackName: slug, baseDir: customDir !== null ? customDir.trim() : undefined }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) {
        throw new Error(r.status === 409 ? `A folder called ${slug} is already there. Choose another name or location.` : j.error || 'The stack couldn’t be made.');
      }
      const label = name.trim();
      onSuccess(j.stack, label, icon);
      setMade({ project: j.stack?.project || slug, name: label, dir: j.stack?.workingDir || folder });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  let body: React.ReactNode;
  let footer: React.ReactNode;

  if (made) {
    // Done: the natural next step is right here
    body = (
      <div className="flex flex-col items-center text-center pt-6">
        <div className="relative">
          <IconTileFor choice={shownIcon} size={72} />
          <span className="absolute -bottom-1.5 -right-1.5 w-7 h-7 rounded-full flex items-center justify-center" style={{ background: ios.green, boxShadow: '0 0 0 3px #1c1c1e' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m5 12.5 4.5 4.5L19 7.5" />
            </svg>
          </span>
        </div>
        <h3 className="mt-4 text-[22px] font-semibold text-white">{made.name} Is Ready</h3>
        <p className="mt-1.5 text-[14px] leading-[20px] max-w-[420px]" style={{ color: ios.secondary }}>
          Its folder is <span className="font-mono text-[13px] text-white/80">{made.dir}</span>. Add apps to it now, or anytime with the + on the stack.
        </p>
      </div>
    );
    footer = (
      <div className="flex items-center justify-end gap-2">
        <Button tone="gray" onClick={onClose} className="sm:min-w-[120px]">
          Done
        </Button>
        {onAddApps && (
          <Button
            onClick={() => {
              onClose();
              onAddApps(made.project);
            }}
            className="flex-1 sm:flex-none sm:min-w-[150px]"
          >
            Add Apps
          </Button>
        )}
      </div>
    );
  } else {
    body = (
      <form
        className="space-y-7"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <button type="submit" hidden aria-hidden tabIndex={-1} />
        <div className="flex flex-col items-center text-center pt-2">
          {/* A live preview of the stack's icon: tap to choose another */}
          <button
            type="button"
            onClick={() => setPicking(true)}
            className="group flex flex-col items-center gap-1.5 rounded-[18px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]"
            aria-label="Choose an icon for this stack"
          >
            <IconTileFor choice={shownIcon} size={72} />
            <span className="text-[13px] font-medium group-hover:opacity-80" style={{ color: ios.blue }}>
              Edit Icon
            </span>
          </button>
          <p className="mt-3 text-[14px] leading-[20px] max-w-[440px]" style={{ color: ios.secondary }}>
            A stack is a folder for apps that belong together, like a media server and its downloaders. It starts empty; you add apps next.
          </p>
        </div>

        <section>
          <Group>
            <FieldRow
              id="new-stack-name"
              label="Name"
              value={name}
              onChange={(v) => {
                setName(v);
                setError(null);
              }}
              placeholder="Media"
              autoFocus
              invalid={Boolean(problem)}
            />
          </Group>
          <SectionFooter tone={problem ? 'danger' : 'default'}>
            {problem ? (
              problem
            ) : (
              <>
                Folder: <span className="font-mono text-[12.5px]" style={{ color: slug ? 'rgba(235,235,245,0.85)' : undefined }}>{folder}</span>
              </>
            )}
          </SectionFooter>
        </section>

        <section>
          <SectionHeader
            action={
              customDir !== null ? (
                <LinkButton onClick={() => setCustomDir(null)}>Use Default</LinkButton>
              ) : undefined
            }
          >
            Location
          </SectionHeader>
          <Group>
            {customDir === null ? (
              <Row
                title="Put It In"
                onClick={() => setCustomDir(defaultBaseDir)}
                trailing={<span className="font-mono text-[13.5px] truncate max-w-[52vw] sm:max-w-[360px]">{defaultBaseDir || '…'}</span>}
                chevron
              />
            ) : (
              <FieldRow id="new-stack-dir" label="Put It In" value={customDir} onChange={setCustomDir} placeholder="/home/you/stacks" mono autoFocus />
            )}
          </Group>
          <SectionFooter>
            {customDir === null ? 'Where your other stacks are. Tap to choose another folder.' : 'The stack’s folder is made inside this one.'}
          </SectionFooter>
        </section>

        {error && (
          <p className="text-[14px] px-1" style={{ color: ios.orange }} role="alert">
            {error}
          </p>
        )}
      </form>
    );
    footer = (
      <div className="flex justify-end">
        <Button onClick={() => void create()} disabled={!ready} className="flex-1 sm:flex-none sm:min-w-[170px]">
          {busy ? 'Creating…' : 'Create Stack'}
        </Button>
      </div>
    );
  }

  return (
    <Sheet
      open={isOpen}
      title={made ? 'Stack Created' : 'New Stack'}
      onClose={onClose}
      leftAction={
        made ? undefined : (
          <button type="button" onClick={onClose} className="text-[17px] rounded hover:opacity-80 focus-visible:outline-2 focus-visible:outline-[#0A84FF]" style={{ color: ios.blue }}>
            Cancel
          </button>
        )
      }
      rightAction={<span />}
      footer={footer}
    >
      {body}
      <StackIconPicker
        open={picking}
        name={name.trim() || 'New Stack'}
        current={icon}
        onClose={() => setPicking(false)}
        onChoose={(c) => {
          setIcon(c);
          setPicking(false);
        }}
      />
    </Sheet>
  );
};
