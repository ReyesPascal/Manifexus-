import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { enter } from '../motion';
import { ShieldCheck, Layers, History, Search } from 'lucide-react';
import { AutomationPrivileges, ManifexusConfig } from '../types';
import { BackButton, Button, FieldRow, Group, IconTile, LinkButton, Row, SectionFooter, SectionHeader, Segmented, Sheet, Switch, ios } from './ui/ios';
import { Step, StepMark, turnOnServerChanges } from './HostAutomationModal';

/**
 * Getting Started: the first time Manifexus runs, a short setup (the few settings that matter, including
 * Server Changes), then an interactive tour of the real dashboard. Run it again anytime from Settings.
 */

type Page = 'welcome' | 'address' | 'stacks' | 'changes' | 'look' | 'done';
const PAGES: Page[] = ['welcome', 'address', 'stacks', 'changes', 'look', 'done'];

interface SetupProps {
  open: boolean;
  config: ManifexusConfig | null;
  onSaveConfig: (updated: Partial<ManifexusConfig>) => Promise<void>;
  privileges: AutomationPrivileges | null;
  onRefreshPrivileges: () => Promise<void>;
  /** The folder Manifexus would use for new stacks if none is set */
  detectedStacksDir?: string;
  /** Finished or skipped; `tour` when they chose to take the tour */
  onClose: (tour: boolean) => void;
}

const Feature: React.FC<{ color: string; icon: React.ReactNode; title: string; text: string }> = ({ color, icon, title, text }) => (
  <Row leading={<IconTile color={color}>{icon}</IconTile>} title={title} subtitle={text} />
);

export const GettingStartedSheet: React.FC<SetupProps> = ({ open, config, onSaveConfig, privileges, onRefreshPrivileges, detectedStacksDir, onClose }) => {
  const [page, setPage] = useState<Page>('welcome');
  const [address, setAddress] = useState('');
  const [stacksDir, setStacksDir] = useState('');
  const [mode, setMode] = useState<'simple' | 'advanced'>('simple');
  const [steps, setSteps] = useState<Step[]>([]);
  const [turning, setTurning] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPage('welcome');
    // What the browser used to reach Manifexus is almost always the right address for app links
    const here = typeof window !== 'undefined' ? window.location.hostname : '';
    setAddress(config?.hostAddress && config.hostAddress !== 'localhost' ? config.hostAddress : here || 'localhost');
    setStacksDir(config?.stacksDir || detectedStacksDir || '');
    setMode(config?.experienceMode === 'advanced' ? 'advanced' : 'simple');
    setSteps([]);
    setProblem(undefined);
    void onRefreshPrivileges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const at = PAGES.indexOf(page);
  const on = Boolean(privileges?.allowChanges);
  const dirOk = !stacksDir.trim() || stacksDir.trim().startsWith('/');

  const finish = async (tour: boolean) => {
    await onSaveConfig({ onboardingDone: true }).catch(() => undefined);
    onClose(tour);
  };

  // Each page saves as you go, so leaving halfway keeps what was chosen
  const next = async () => {
    setSaving(true);
    try {
      if (page === 'address') await onSaveConfig({ hostAddress: address.trim() || 'localhost' });
      if (page === 'stacks' && dirOk) await onSaveConfig({ stacksDir: stacksDir.trim().replace(/\/+$/, '') });
      if (page === 'look') await onSaveConfig({ experienceMode: mode, showCommands: mode === 'advanced' });
    } catch {
      // the setting stays as it was; Settings can change it later
    } finally {
      setSaving(false);
    }
    setPage(PAGES[Math.min(PAGES.length - 1, at + 1)]);
  };

  const turnOn = async () => {
    setTurning(true);
    setSteps([]);
    setProblem(undefined);
    try {
      const ok = await turnOnServerChanges((s) => setSteps((prev) => (prev.some((p) => p.id === s.id) ? prev.map((p) => (p.id === s.id ? s : p)) : [...prev, s])));
      if (!ok) setProblem('Server Changes stays off until this works. You can turn it on later in Settings.');
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      await onRefreshPrivileges();
      setTurning(false);
    }
  };

  let body: React.ReactNode;
  let footer: React.ReactNode;
  const primary = (label: string, go: () => void, disabled = false) => (
    <div className="flex justify-end">
      <Button onClick={go} disabled={disabled || saving || turning} className="flex-1 sm:flex-none sm:min-w-[170px]">
        {label}
      </Button>
    </div>
  );

  if (page === 'welcome') {
    body = (
      <div className="space-y-7">
        <div className="flex flex-col items-center text-center pt-4">
          <div className="w-[76px] h-[76px] rounded-[19px] flex items-center justify-center" style={{ background: 'linear-gradient(145deg, #3d8bff, #6a5cff)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.35), 0 12px 28px -10px rgba(40,90,255,0.6)' }}>
            <Layers className="w-9 h-9 text-white" />
          </div>
          <h3 className="mt-4 text-[28px] font-semibold text-white tracking-[-0.02em]">Welcome to Manifexus</h3>
          <p className="mt-1.5 text-[15px] leading-[21px] max-w-[440px]" style={{ color: ios.secondary }}>
            All your Docker apps in one place. A minute of setup, then a quick tour of where everything is.
          </p>
        </div>
        <Group className="ios-inset-icon">
          <Feature color={ios.blue} icon={<Search className="w-[17px] h-[17px]" />} title="See every app" text="What's running, what stopped, and a link to open each one." />
          <Feature color="#5E5CE6" icon={<Layers className="w-[17px] h-[17px]" />} title="Organize them into stacks" text="Drag apps between stacks. They fit together on their own." />
          <Feature color={ios.green} icon={<History className="w-[17px] h-[17px]" />} title="Change things safely" text="Every change is backed up first, and you can undo it from Restore." />
        </Group>
      </div>
    );
    footer = (
      <div className="flex items-center justify-between gap-3">
        <LinkButton onClick={() => void finish(false)}>Skip Setup</LinkButton>
        <Button onClick={() => setPage('address')} className="flex-1 sm:flex-none sm:min-w-[170px]">
          Get Started
        </Button>
      </div>
    );
  } else if (page === 'address') {
    body = (
      <div className="space-y-6">
        <Intro title="How do you reach this server?" text="Manifexus uses this address for the Open links on your apps." />
        <section>
          <Group>
            <FieldRow id="gs-address" label="Address" value={address} onChange={setAddress} placeholder="localhost" autoFocus />
          </Group>
          <SectionFooter>
            Apps open at addresses like <span className="font-mono text-[13px]" style={{ color: 'rgba(235,235,245,0.85)' }}>http://{address.trim() || 'localhost'}:8080</span>. This is filled in with the address you used to open Manifexus.
          </SectionFooter>
        </section>
      </div>
    );
    footer = primary('Continue', () => void next());
  } else if (page === 'stacks') {
    body = (
      <div className="space-y-6">
        <Intro title="Where should new stacks go?" text="Each stack is a folder on your server. New ones are made here." />
        <section>
          <Group>
            <FieldRow id="gs-stacks" label="Location" value={stacksDir} onChange={setStacksDir} placeholder={detectedStacksDir || '/home/you'} mono invalid={!dirOk} />
          </Group>
          <SectionFooter tone={dirOk ? 'default' : 'danger'}>
            {dirOk ? 'Your existing stacks stay where they are. You can change this anytime in Settings.' : 'Use a full path starting with /, like /home/you.'}
          </SectionFooter>
        </section>
      </div>
    );
    footer = primary('Continue', () => void next(), !dirOk);
  } else if (page === 'changes') {
    const docker = privileges ? privileges.isDockerConnected : true;
    body = (
      <div className="space-y-6">
        <Intro title="Let Manifexus make changes?" text="Off, Manifexus only shows your apps and starts, stops or restarts them. On, it can move apps, make and delete stacks, restore backups, clean up and fix problems." />
        <section>
          <Group className="ios-inset-icon">
            <Row
              leading={
                <IconTile color={on ? ios.green : 'rgba(120,120,128,0.55)'}>
                  <ShieldCheck className="w-[17px] h-[17px]" />
                </IconTile>
              }
              title="Server Changes"
              subtitle={turning ? 'Getting your server ready…' : on ? 'On' : 'Off'}
              trailing={
                <span className={turning || on || !docker ? 'opacity-40 pointer-events-none' : ''}>
                  <Switch checked={on || turning} onChange={(v) => v && void turnOn()} label="Server Changes" />
                </span>
              }
            />
          </Group>
          <SectionFooter>{!docker ? 'Manifexus can’t reach Docker yet, so this can wait. Turn it on later in Settings.' : 'Everything is backed up before it’s changed. You can turn this off anytime in Settings.'}</SectionFooter>
        </section>
        {steps.length > 0 && (
          <section>
            <SectionHeader>Getting Your Server Ready</SectionHeader>
            <Group className="ios-inset-icon">
              {steps.map((s) => (
                <Row key={s.id} leading={<StepMark status={s.status} />} title={s.title} subtitle={s.detail} />
              ))}
            </Group>
            {problem ? <SectionFooter tone="danger">{problem}</SectionFooter> : on && !turning ? <SectionFooter>All set. Server Changes is on.</SectionFooter> : null}
          </section>
        )}
      </div>
    );
    footer = primary(on ? 'Continue' : 'Not Now', () => void next());
  } else if (page === 'look') {
    body = (
      <div className="space-y-6">
        <Intro title="How much do you want to see?" text="Choose how much of the technical side Manifexus shows. Switch anytime in Settings." />
        <Segmented label="Experience" value={mode} onChange={(v) => setMode(v)} options={[{ value: 'simple', label: 'Simple' }, { value: 'advanced', label: 'Advanced' }]} />
        <Group>
          <Row
            title={mode === 'simple' ? 'Simple' : 'Advanced'}
            subtitle={
              mode === 'simple'
                ? 'Clean screens with plain words. Best if you’re new to servers.'
                : 'Also shows the command behind every step, each explained, so you can learn how it’s done or do it yourself.'
            }
          />
        </Group>
      </div>
    );
    footer = primary('Continue', () => void next());
  } else {
    body = (
      <div className="flex flex-col items-center text-center pt-8">
        <span className="w-16 h-16 rounded-full flex items-center justify-center" style={{ background: ios.green }}>
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          </svg>
        </span>
        <h3 className="mt-4 text-[22px] font-semibold text-white"><BlurIn text="You’re All Set" /></h3>
        <p className="mt-1.5 text-[15px] leading-[21px] max-w-[420px]" style={{ color: ios.secondary }}>
          Next, practice on a pretend server that’s gotten messy: tidy it up and undo a change, safely. Then a quick look around your real dashboard. You can do this again anytime from Settings.
        </p>
      </div>
    );
    footer = (
      <div className="flex items-center justify-end gap-2">
        <Button tone="gray" onClick={() => void finish(false)} className="sm:min-w-[120px]">
          Done
        </Button>
        <Button onClick={() => void finish(true)} className="flex-1 sm:flex-none sm:min-w-[170px]">
          Start Practice
        </Button>
      </div>
    );
  }

  const stepNo = at >= 1 && at <= 4 ? at : 0;
  return (
    <Sheet
      open={open}
      title="Getting Started"
      subtitle={stepNo ? <Steps at={stepNo} of={4} /> : undefined}
      onClose={() => void finish(false)}
      closeLabel={page === 'done' ? 'Done' : 'Skip'}
      leftAction={at > 0 && page !== 'done' ? <BackButton label="Back" onClick={() => setPage(PAGES[at - 1])} /> : undefined}
      footer={footer}
      zIndex={75}
    >
      {body}
    </Sheet>
  );
};

/** Where you are in setup (React Bits' Stepper): done steps green, this one blue and wider */
const Steps: React.FC<{ at: number; of: number }> = ({ at, of }) => (
  <span className="inline-flex items-center gap-1.5 align-middle" role="img" aria-label={`Step ${at} of ${of}`}>
    {Array.from({ length: of }, (_, i) => (
      <span
        key={i}
        className="h-[6px] rounded-full transition-all duration-300 ease-out motion-reduce:transition-none"
        style={{ width: i + 1 === at ? 20 : 6, background: i + 1 < at ? ios.green : i + 1 === at ? ios.blue : 'rgba(235,235,245,0.3)' }}
      />
    ))}
  </span>
);

/** Letters that come into focus one after another (React Bits' BlurText) */
export const BlurIn: React.FC<{ text: string; className?: string; style?: React.CSSProperties }> = ({ text, className = '', style }) => (
  <span ref={enter('blur')} className={className} style={style} aria-label={text}>
    {Array.from(text).map((ch, i) => (
      <span key={i} aria-hidden style={{ display: 'inline-block', whiteSpace: 'pre' }}>
        {ch}
      </span>
    ))}
  </span>
);

const Intro: React.FC<{ title: string; text: string }> = ({ title, text }) => (
  <div className="text-center pt-2">
    <h3 className="text-[22px] font-semibold text-white tracking-[-0.01em]">{title}</h3>
    <p className="mt-1.5 text-[15px] leading-[21px] max-w-[460px] mx-auto" style={{ color: ios.secondary }}>
      {text}
    </p>
  </div>
);

// ---------------------------------------------------------------------------------------------------------
// The tour: highlights each part of the real dashboard with a short note. Some steps ask you to try it,
// and move on when you do.
// ---------------------------------------------------------------------------------------------------------

interface TourStep {
  /** CSS selector of what to point at (the first one found) */
  target: string;
  title: string;
  text: string;
  /** Try it: what to do, and what counts as done */
  tryIt?: { hint: string; on: 'click' | 'hover' | 'input' };
}

const TOUR: TourStep[] = [
  { target: 'button[aria-label*="to Docker"]', title: 'Connected to Docker', text: 'The light on the logo shows Manifexus can reach Docker: green means all is well.', tryIt: { hint: 'Point at the logo to see details', on: 'hover' } },
  { target: 'label:has(input[aria-label="Search apps"])', title: 'Find any app', text: 'Search by name, port or stack.', tryIt: { hint: 'Type a letter to try it', on: 'input' } },
  { target: '[role="group"][aria-label="Your apps"]', title: 'Running, Stopped and Ports', text: 'Tap Running or Stopped to show only those apps. Tap it again to show everything. Ports shows which app uses each port.', tryIt: { hint: 'Tap Running or Stopped', on: 'click' } },
  { target: 'section[aria-label]:not([aria-label="Not in a Stack"])', title: 'Stacks', text: 'A stack is a folder of apps that belong together. Tap its name to fold it away, + to add an app, and ⓘ for its details: rename it, start or stop all its apps, edit its compose file, or delete it.' },
  { target: '[data-flip^="app:"]', title: 'Your apps', text: 'Open, Restart and Stop are right on each card. Tap a card for its details: health, logs, storage and more.' },
  { target: '[data-flip^="app:"]', title: 'Move apps by dragging', text: 'Just like in practice: drag an app onto another stack (or use ⇄ on the card). It moves right away; the real move runs in the background, backed up first.' },
  { target: 'button', title: 'New Stack', text: 'Make a stack in one click: type its name and press Return. Then drag apps onto it.' },
  { target: 'button[aria-label^="Activity"]', title: 'Activity', text: 'A record of everything Manifexus does, with the reason when something goes wrong.' },
  { target: 'button[aria-label="Restore"]', title: 'Restore', text: 'Every move, delete and fix is listed here, newest first, each with its backup. Restore one to go back to before it, like you did in practice. Pin the ones you want to keep for good.' },
  { target: 'button[aria-label="Clean Up"]', title: 'Clean Up', text: 'Finds folders no app uses anymore, and deletes the ones you pick (backed up first).' },
  { target: 'button[aria-label="Diagnostics"]', title: 'Diagnostics', text: 'Health checks in plain words, with a fix for anything that’s wrong.' },
  { target: 'button[aria-label^="Updat"]', title: 'Updates', text: 'New versions with what’s new in each. You can always go back to an earlier one.' },
  { target: 'button[aria-label="Settings"]', title: 'Settings', text: 'Everything from setup: your server’s address, where new stacks go, Server Changes (whether Manifexus may change your server), Simple or Advanced, and Getting Started to practice and take this tour again.' },
];

/** Finds a step's target; New Stack is matched by its words, as it has no label of its own */
function findTarget(step: TourStep): HTMLElement | null {
  if (step.title === 'New Stack') {
    return (Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'New Stack') as HTMLElement) || null;
  }
  try {
    const all = Array.from(document.querySelectorAll<HTMLElement>(step.target));
    return all.find((el) => el.getBoundingClientRect().width > 0) || null;
  } catch {
    return null;
  }
}

export const Tour: React.FC<{ open: boolean; onClose: () => void; onClearSearch?: () => void; onShowAll?: () => void }> = ({ open, onClose, onClearSearch, onShowAll }) => {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [tried, setTried] = useState(false);
  const bubble = useRef<HTMLDivElement>(null);
  const [bubbleH, setBubbleH] = useState(180);
  const step = TOUR[i];

  useEffect(() => {
    if (open) {
      setI(0);
      setTried(false);
    }
  }, [open]);

  // Follow the target as the page scrolls or re-fits
  useEffect(() => {
    if (!open) return;
    const el = findTarget(step);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    let raf = 0;
    const tick = () => {
      const t = findTarget(step);
      setRect(t ? t.getBoundingClientRect() : null);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open, step]);

  useLayoutEffect(() => {
    if (bubble.current) setBubbleH(bubble.current.offsetHeight);
  });

  const go = useCallback(
    (to: number) => {
      // Leave things as they were: an emptied search, every app showing
      if (TOUR[i]?.tryIt?.on === 'input') onClearSearch?.();
      if (TOUR[i]?.tryIt?.on === 'click' && TOUR[i].target.includes('Your apps')) onShowAll?.();
      setTried(false);
      if (to >= TOUR.length) onClose();
      else setI(Math.max(0, to));
    },
    [i, onClose, onClearSearch, onShowAll]
  );

  // Try it: moves on (after a moment to see the result) when you do it
  useEffect(() => {
    if (!open || !step.tryIt) return;
    const el = findTarget(step);
    if (!el) return;
    const done = () => {
      setTried(true);
      setTimeout(() => go(i + 1), step.tryIt!.on === 'click' ? 1400 : 900);
    };
    const ev = step.tryIt.on === 'hover' ? 'mouseenter' : step.tryIt.on === 'input' ? 'input' : 'click';
    el.addEventListener(ev, done, { once: true });
    return () => el.removeEventListener(ev, done);
  }, [open, step, i, go]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') go(i + 1);
      if (e.key === 'ArrowLeft') go(i - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, i, go, onClose]);

  if (!open) return null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pad = 8;
  const bw = Math.min(360, vw - 32);
  // Below the highlight if it fits, otherwise above; kept on screen
  let top = rect ? rect.bottom + 14 : vh / 2 - bubbleH / 2;
  if (rect && top + bubbleH > vh - 16) top = Math.max(16, rect.top - bubbleH - 14);
  const left = rect ? Math.min(Math.max(16, rect.left + rect.width / 2 - bw / 2), vw - bw - 16) : vw / 2 - bw / 2;

  return (
    <div className="fixed inset-0 z-[85] pointer-events-none" style={{ fontFamily: ios.font }} aria-live="polite">
      {/* The highlight: everything else dims, the part being shown stays usable */}
      {rect ? (
        <div
          className="absolute rounded-[18px] transition-all duration-300 ease-out"
          style={{
            left: rect.left - pad,
            top: rect.top - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
            boxShadow: `0 0 0 9999px rgba(4,8,20,0.62), 0 0 0 2px ${tried ? ios.green : 'rgba(100,181,255,0.9)'}, 0 0 30px rgba(10,132,255,0.35)`,
          }}
        />
      ) : (
        <div className="absolute inset-0" style={{ background: 'rgba(4,8,20,0.62)' }} />
      )}
      <div
        ref={bubble}
        role="dialog"
        aria-label={step.title}
        className="absolute pointer-events-auto rounded-[20px] p-4 transition-all duration-300 ease-out"
        style={{
          left,
          top,
          width: bw,
          background: 'rgba(28,36,62,0.82)',
          backdropFilter: 'blur(24px) saturate(170%)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.2), inset 0 0 0 1px rgba(255,255,255,0.1), 0 24px 48px -20px rgba(0,0,0,0.8)',
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[17px] font-semibold text-white">{step.title}</h3>
          <span className="text-[12px] tabular-nums flex-shrink-0" style={{ color: ios.secondary }}>
            {i + 1} of {TOUR.length}
          </span>
        </div>
        <p className="mt-1 text-[15px] leading-[20px]" style={{ color: 'rgba(235,235,245,0.8)' }}>
          {step.text}
        </p>
        {step.tryIt && (
          <p className="mt-2.5 inline-flex items-center gap-2 text-[13px] font-medium px-2.5 py-1 rounded-full" style={{ background: tried ? 'rgba(48,209,88,0.16)' : 'rgba(10,132,255,0.16)', color: tried ? '#4ADE80' : '#64B5FF' }}>
            {tried ? 'Nice!' : `Try it: ${step.tryIt.hint}`}
          </p>
        )}
        <div className="mt-3.5 flex items-center justify-between gap-2">
          <LinkButton onClick={onClose}>End Tour</LinkButton>
          <div className="flex items-center gap-2">
            {i > 0 && (
              <Button tone="gray" onClick={() => go(i - 1)} className="min-w-[80px]">
                Back
              </Button>
            )}
            <Button onClick={() => go(i + 1)} className="min-w-[90px]">
              {i === TOUR.length - 1 ? 'Done' : step.tryIt && !tried ? 'Skip' : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
