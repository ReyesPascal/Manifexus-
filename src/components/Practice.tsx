import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, LinkButton, MenuButton, ios } from './ui/ios';
import { panelStyle, displayFont } from './Shelf';

/**
 * Practice: a pretend server that has grown messy, to tidy up with the same moves as the real dashboard
 * (New Stack, drag an app onto a stack, rename, delete, and undo with Restore). Nothing here touches the
 * real server. Each step says what to do and moves on when it's done.
 */

type AppId = 'plex' | 'sonarr' | 'radarr' | 'qbit' | 'nextcloud' | 'hass';
const APPS: Record<AppId, { name: string; color: string; letter: string; note?: string }> = {
  plex: { name: 'Plex', color: '#E5A00D', letter: 'P' },
  sonarr: { name: 'Sonarr', color: '#35C5F4', letter: 'S' },
  radarr: { name: 'Radarr', color: '#FFC230', letter: 'R' },
  qbit: { name: 'qBittorrent', color: '#2F67BA', letter: 'q' },
  nextcloud: { name: 'Nextcloud', color: '#0082C9', letter: 'N', note: 'with its database' },
  hass: { name: 'Home Assistant', color: '#18BCF2', letter: 'H' },
};
const MEDIA: AppId[] = ['plex', 'sonarr', 'radarr', 'qbit'];

interface Stack {
  id: string;
  name: string;
  apps: AppId[];
}
interface World {
  stacks: Stack[];
  loose: AppId[];
}
interface Change {
  id: number;
  title: string;
  before: World;
}

const START: World = {
  stacks: [
    { id: 'stuff', name: 'stuff', apps: ['nextcloud', 'hass'] },
    { id: 'test', name: 'test', apps: [] },
  ],
  loose: ['plex', 'sonarr', 'qbit', 'radarr'],
};

type StepId = 'mess' | 'new' | 'move' | 'rename' | 'delete' | 'restore' | 'done';
const STEPS: StepId[] = ['mess', 'new', 'move', 'rename', 'delete', 'restore', 'done'];

const DRAG = 'application/x-manifexus-practice';

const AppTile: React.FC<{ id: AppId; size?: number }> = ({ id, size = 40 }) => (
  <span
    className="flex-shrink-0 rounded-[11px] flex items-center justify-center font-semibold text-white"
    style={{ width: size, height: size, fontSize: size * 0.42, background: `linear-gradient(160deg, ${APPS[id].color}, ${APPS[id].color}AA)`, boxShadow: 'inset 0 0.5px 0 rgba(255,255,255,0.35)' }}
    aria-hidden
  >
    {APPS[id].letter}
  </span>
);

export const Practice: React.FC<{ open: boolean; onClose: (thenTour: boolean) => void }> = ({ open, onClose }) => {
  const [world, setWorld] = useState<World>(START);
  const [history, setHistory] = useState<Change[]>([]);
  const [step, setStep] = useState<StepId>('mess');
  const [naming, setNaming] = useState<string | null>(null); // a new stack's name being typed
  const [renaming, setRenaming] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [over, setOver] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const nextId = useRef(1);

  useEffect(() => {
    if (!open) return;
    setWorld(START);
    setHistory([]);
    setStep('mess');
    setNaming(null);
    setRenaming(null);
    setDetails(null);
    setRestoreOpen(false);
  }, [open]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  // Every change is recorded with how things were before it, like the real Restore
  const change = (title: string, next: (w: World) => World, note?: string) => {
    const id = nextId.current++;
    setHistory((h) => [{ id, title, before: world }, ...h]);
    setWorld(next(world));
    if (note) setToast(note);
  };

  const media = world.stacks.find((s) => s.id.startsWith('new-'));
  const inMedia = media ? MEDIA.filter((a) => media.apps.includes(a)).length : 0;
  const stuff = world.stacks.find((s) => s.id === 'stuff');
  const testGone = !world.stacks.some((s) => s.id === 'test');
  const [didRestore, setDidRestore] = useState(false);

  // What counts as done for each step
  const done: Record<StepId, boolean> = {
    mess: true,
    new: Boolean(media),
    move: inMedia === MEDIA.length,
    rename: Boolean(stuff && stuff.name.trim().toLowerCase() !== 'stuff'),
    delete: testGone,
    restore: didRestore,
    done: true,
  };
  useEffect(() => setDidRestore(false), [open]);

  // Moves on by itself a moment after a step is done, so you see what you did
  useEffect(() => {
    if (!open || step === 'mess' || step === 'done' || !done[step]) return;
    const t = setTimeout(() => setStep(STEPS[STEPS.indexOf(step) + 1]), 1100);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, done.new, done.move, done.rename, done.delete, didRestore]);

  const moveApp = (app: AppId, to: string) => {
    const from = world.stacks.find((s) => s.apps.includes(app))?.id || 'loose';
    if (from === to) return;
    const toName = to === 'loose' ? 'Not in a Stack' : world.stacks.find((s) => s.id === to)?.name || 'a stack';
    change(
      `Moved ${APPS[app].name} to ${toName}`,
      (w) => ({
        stacks: w.stacks.map((s) => ({ ...s, apps: s.id === to ? [...s.apps.filter((a) => a !== app), app] : s.apps.filter((a) => a !== app) })),
        loose: to === 'loose' ? [...w.loose.filter((a) => a !== app), app] : w.loose.filter((a) => a !== app),
      }),
      app === 'nextcloud' ? 'Nextcloud’s database went with it: an app’s database always moves with the app.' : `Backed up, then moved. On your server, this happens in the background.`
    );
    setFlash(to);
    setTimeout(() => setFlash((f) => (f === to ? null : f)), 1200);
  };

  const create = (name: string) => {
    const n = name.trim();
    setNaming(null);
    if (!n) return;
    const id = `new-${Date.now()}`;
    change(`Made ${n}`, (w) => ({ ...w, stacks: [{ id, name: n, apps: [] }, ...w.stacks] }), `${n} is ready. Now drag apps onto it.`);
  };

  const rename = (id: string, name: string) => {
    const n = name.trim();
    setRenaming(null);
    const s = world.stacks.find((x) => x.id === id);
    if (!s || !n || n === s.name) return;
    change(`Renamed ${s.name} to ${n}`, (w) => ({ ...w, stacks: w.stacks.map((x) => (x.id === id ? { ...x, name: n } : x)) }), 'Only the name on the dashboard changes. The folder stays where it is.');
  };

  const remove = (id: string) => {
    const s = world.stacks.find((x) => x.id === id);
    if (!s) return;
    change(`Deleted ${s.name}`, (w) => ({ ...w, stacks: w.stacks.filter((x) => x.id !== id) }), `${s.name} was deleted, with a full backup in Restore.`);
  };

  const restore = (c: Change) => {
    const undone = history.filter((h) => h.id >= c.id).length;
    setWorld(c.before);
    setHistory((h) => h.filter((x) => x.id < c.id));
    setRestoreOpen(false);
    setDidRestore(true);
    setToast(undone > 1 ? `Back to before “${c.title}” (and the ${undone - 1} newer change${undone - 1 === 1 ? '' : 's'} after it).` : `Back to before “${c.title}”.`);
  };

  const moveTargets = (app: AppId) => [
    ...world.stacks.filter((s) => !s.apps.includes(app)).map((s) => ({ key: s.id, label: s.name, onSelect: () => moveApp(app, s.id) })),
    ...(world.loose.includes(app) ? [] : [{ key: 'loose', label: 'Not in a Stack', onSelect: () => moveApp(app, 'loose') }]),
  ];

  const coach = useMemo(() => {
    const at = STEPS.indexOf(step);
    const c: Record<StepId, { title: string; text: string; task?: string }> = {
      mess: {
        title: 'A server that grew messy',
        text: 'This is pretend, so try anything. Like many servers, it has apps that aren’t in any stack, a stack with a name that says nothing (“stuff”), and a leftover empty stack (“test”). Let’s tidy it the way you would in Manifexus.',
      },
      new: { title: 'Make a stack for your media', text: 'A stack is a folder of apps that belong together.', task: 'Click New Stack, type “Media” and press Return' },
      move: { title: `Move your media apps into ${media?.name || 'it'}`, text: `Drag each one onto ${media?.name || 'the new stack'}. On a phone, tap ⇄ on the app instead.`, task: `Move Plex, Sonarr, Radarr and qBittorrent (${inMedia} of 4)` },
      rename: { title: 'Give “stuff” a clear name', text: 'It holds Nextcloud and Home Assistant. Names only change what the dashboard shows.', task: 'Click ⓘ on “stuff”, then Rename' },
      delete: { title: 'Remove the empty stack', text: 'Deleting keeps a full backup first, so nothing is ever lost.', task: 'Click ⓘ on “test”, then Delete Stack' },
      restore: { title: 'Changed your mind? Undo it', text: 'Every change keeps a backup. Restore lists them, newest first, and takes you back to before any of them.', task: 'Click Restore and bring something back' },
      done: { title: 'Tidy, and nothing to fear', text: 'That’s all it takes: make stacks, drag apps where they belong, and undo anything from Restore. Next, a quick look at the real dashboard.' },
    };
    return { ...c[step], at };
  }, [step, inMedia, media?.name]);

  if (!open) return null;

  // A stack (or Not in a Stack) as on the dashboard; a plain function, so typing a name isn't interrupted
  const panel = (id: string, title: string, apps: AppId[], loose = false) => (
    <React.Fragment key={id}>
    <section
      aria-label={`Practice ${title}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG)) return;
        e.preventDefault();
        if (over !== id) setOver(id);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver((o) => (o === id ? null : o))}
      onDrop={(e) => {
        e.preventDefault();
        setOver(null);
        const a = e.dataTransfer.getData(DRAG) as AppId;
        if (a) moveApp(a, id);
      }}
      className={`rounded-[20px] p-3 sm:p-3.5 transition-shadow duration-200 ${loose ? 'w-full' : 'flex-1 min-w-[240px]'}`}
      style={{
        ...panelStyle,
        ...(over === id || flash === id ? { boxShadow: `${panelStyle.boxShadow}, inset 0 0 0 2px rgba(100,181,255,0.85), 0 0 30px rgba(10,132,255,0.3)` } : null),
      }}
    >
      <header className="flex items-center gap-2 px-1 pb-2.5">
        {renaming === id ? (
          <input
            autoFocus
            defaultValue={title}
            aria-label="New name"
            onKeyDown={(e) => {
              if (e.key === 'Enter') rename(id, e.currentTarget.value);
              if (e.key === 'Escape') setRenaming(null);
            }}
            onBlur={(e) => rename(id, e.currentTarget.value)}
            className="flex-1 min-w-0 h-8 px-2 rounded-lg bg-white/10 text-white text-[17px] font-semibold outline-none focus:ring-2 focus:ring-[#0A84FF]"
          />
        ) : (
          <h4 className="flex-1 min-w-0 truncate text-[17px] font-semibold text-white" style={{ fontFamily: displayFont, letterSpacing: '-0.02em' }}>
            {title}
            <span className="ml-2 text-[13px] font-normal" style={{ color: ios.secondary }}>
              {apps.length ? `${apps.length} app${apps.length === 1 ? '' : 's'}` : 'Empty'}
            </span>
          </h4>
        )}
        {!loose && (
          <button
            type="button"
            onClick={() => setDetails(id)}
            aria-label={`Details for ${title}`}
            data-tip="Details: rename or delete"
            className={`w-8 h-8 rounded-full inline-flex items-center justify-center text-white/90 hover:brightness-125 ${(step === 'rename' && id === 'stuff') || (step === 'delete' && id === 'test') ? 'mfx-practice-pulse' : ''}`}
            style={{ background: 'rgba(118,118,128,0.16)' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v5.5M12 7.6v.01" strokeWidth="2.6" />
            </svg>
          </button>
        )}
      </header>
      <div className={`grid gap-2 ${loose ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4' : 'grid-cols-1'}`}>
        {apps.map((a) => (
          <div
            key={a}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG, a);
              e.dataTransfer.effectAllowed = 'move';
            }}
            aria-label={APPS[a].name}
            className={`flex items-center gap-3 p-2.5 rounded-[14px] bg-white/[0.07] hover:bg-white/[0.1] cursor-grab active:cursor-grabbing ${step === 'move' && MEDIA.includes(a) && !media?.apps.includes(a) ? 'mfx-practice-pulse' : ''}`}
          >
            <AppTile id={a} />
            <span className="flex-1 min-w-0">
              <span className="block text-[15px] font-semibold text-white truncate">{APPS[a].name}</span>
              <span className="flex items-center gap-1.5 text-[13px]" style={{ color: ios.secondary }}>
                <span className="w-[7px] h-[7px] rounded-full" style={{ background: ios.green }} />
                Running{APPS[a].note ? ` · ${APPS[a].note}` : ''}
              </span>
            </span>
            <MenuButton
              look="bare"
              ariaLabel={`Move ${APPS[a].name}`}
              title="Move to another stack"
              label={
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M4 8h13m0 0-3.5-3.5M17 8l-3.5 3.5M20 16H7m0 0 3.5-3.5M7 16l3.5 3.5" />
                </svg>
              }
              items={[{ key: 'h', label: 'Move to', header: true, onSelect: () => undefined }, ...moveTargets(a)]}
              className="w-8 h-8 rounded-full inline-flex items-center justify-center text-white/70 hover:text-white hover:bg-white/[0.08]"
            />
          </div>
        ))}
        {!apps.length && (
          <p className="px-2 py-3 text-[13px] text-center" style={{ color: ios.secondary }}>
            {loose ? 'Every app is in a stack.' : 'No apps yet. Drag one here.'}
          </p>
        )}
      </div>
    </section>
    </React.Fragment>
  );

  const detailStack = world.stacks.find((s) => s.id === details);

  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto" style={{ background: '#0a0f1d', fontFamily: ios.font }} role="dialog" aria-label="Practice">
      <style>{`@keyframes mfx-practice-pulse{0%,100%{box-shadow:0 0 0 0 rgba(100,181,255,0)}50%{box-shadow:0 0 0 3px rgba(100,181,255,0.65)}} .mfx-practice-pulse{animation:mfx-practice-pulse 1.6s ease-in-out infinite} @media (prefers-reduced-motion: reduce){.mfx-practice-pulse{animation:none;box-shadow:0 0 0 2px rgba(100,181,255,0.65)}}`}</style>
      <div aria-hidden className="fixed inset-0 pointer-events-none">
        <div className="absolute -top-[10%] -left-[10%] w-[60vw] h-[60vw] rounded-full blur-3xl" style={{ background: 'radial-gradient(circle, rgba(10,132,255,0.16), transparent 62%)' }} />
        <div className="absolute top-[30%] -right-[15%] w-[55vw] h-[55vw] rounded-full blur-3xl" style={{ background: 'radial-gradient(circle, rgba(94,92,230,0.14), transparent 62%)' }} />
      </div>

      <div className="relative max-w-5xl mx-auto px-4 sm:px-6 py-5 sm:py-8">
        {/* Where you are */}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12px] font-semibold uppercase tracking-[0.08em]" style={{ color: ios.secondary }}>
              Practice · Step {Math.min(coach.at + 1, STEPS.length)} of {STEPS.length}
            </div>
            <div className="text-[13px]" style={{ color: ios.secondary }}>
              A pretend server. Nothing here touches yours.
            </div>
          </div>
          <LinkButton onClick={() => onClose(false)}>Exit Practice</LinkButton>
        </div>

        {/* What to do now */}
        <div className="mt-4 sticky top-3 z-10 rounded-[20px] p-4 sm:p-5" style={{ ...panelStyle, background: 'rgba(28,36,62,0.9)' }} aria-live="polite">
          <div className="flex gap-1.5 mb-3" aria-hidden>
            {STEPS.map((s, i) => (
              <span key={s} className="h-1 flex-1 rounded-full transition-colors" style={{ background: i < coach.at || (i === coach.at && done[s] && s !== 'mess' && s !== 'done') ? ios.green : i === coach.at ? ios.blue : 'rgba(255,255,255,0.12)' }} />
            ))}
          </div>
          <h3 className="text-[20px] font-semibold text-white tracking-[-0.01em]">{coach.title}</h3>
          <p className="mt-1 text-[15px] leading-[21px] max-w-[640px]" style={{ color: 'rgba(235,235,245,0.8)' }}>
            {coach.text}
          </p>
          {coach.task && (
            <p className="mt-3 inline-flex items-center gap-2 text-[15px] font-medium px-3 py-1.5 rounded-full" style={{ background: done[step] ? 'rgba(48,209,88,0.16)' : 'rgba(10,132,255,0.16)', color: done[step] ? '#4ADE80' : '#64B5FF' }}>
              {done[step] ? '✓ Nice!' : coach.task}
            </p>
          )}
          {step === 'mess' && (
            <ul className="mt-3 space-y-1.5 text-[15px]" style={{ color: 'rgba(235,235,245,0.8)' }}>
              <li className="flex items-center gap-2"><span className="w-2 h-2 rounded-full" style={{ background: ios.orange }} />4 apps aren’t in any stack</li>
              <li className="flex items-center gap-2"><span className="w-2 h-2 rounded-full" style={{ background: ios.orange }} />“stuff” doesn’t say what’s in it</li>
              <li className="flex items-center gap-2"><span className="w-2 h-2 rounded-full" style={{ background: ios.orange }} />“test” is empty and left over</li>
            </ul>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {step === 'mess' && <Button onClick={() => setStep('new')}>Let’s Tidy It</Button>}
            {step === 'done' && (
              <>
                <Button onClick={() => onClose(true)}>Show Me the Real Dashboard</Button>
                <Button tone="gray" onClick={() => onClose(false)}>
                  Done
                </Button>
              </>
            )}
            {step !== 'mess' && step !== 'done' && !done[step] && (
              <LinkButton onClick={() => setStep(STEPS[STEPS.indexOf(step) + 1])}>Skip this step</LinkButton>
            )}
          </div>
        </div>

        {/* The pretend dashboard */}
        <div className="mt-6 flex items-center gap-2">
          <span className="text-[12px] font-semibold uppercase tracking-[0.08em]" style={{ color: 'rgba(235,235,245,0.6)' }}>
            Your Stacks
          </span>
          <span className="flex-1 h-px" style={{ background: 'linear-gradient(90deg, rgba(255,255,255,0.14), transparent)' }} />
          <button
            type="button"
            onClick={() => setRestoreOpen(true)}
            className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[13px] font-medium text-white/90 hover:bg-white/[0.08] ${step === 'restore' ? 'mfx-practice-pulse' : ''}`}
            style={{ background: 'rgba(255,255,255,0.075)' }}
          >
            Restore{history.length ? ` · ${history.length}` : ''}
          </button>
          <button
            type="button"
            onClick={() => setNaming('')}
            className={`inline-flex items-center gap-1.5 h-8 pl-3 pr-3.5 rounded-full text-[13px] font-semibold ${step === 'new' ? 'mfx-practice-pulse' : ''}`}
            style={{ background: 'rgba(10,132,255,0.22)', boxShadow: 'inset 0 0 0 1px rgba(10,132,255,0.35)', color: '#64B5FF' }}
          >
            + New Stack
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-3">
          {naming !== null && (
            <section className="flex-1 min-w-[240px] rounded-[20px] p-3.5" style={panelStyle}>
              <input
                autoFocus
                placeholder="Name your stack"
                aria-label="Name your stack"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') create(e.currentTarget.value);
                  if (e.key === 'Escape') setNaming(null);
                }}
                onBlur={(e) => (e.currentTarget.value.trim() ? create(e.currentTarget.value) : setNaming(null))}
                className="w-full h-9 px-2.5 rounded-lg bg-white/10 text-white text-[17px] font-semibold outline-none focus:ring-2 focus:ring-[#0A84FF] placeholder:text-white/45"
              />
              <p className="mt-2 px-1 text-[13px]" style={{ color: ios.secondary }}>
                Type a name and press Return.
              </p>
            </section>
          )}
          {world.stacks.map((s) => panel(s.id, s.name, s.apps))}
        </div>
        <div className="mt-3">
          {panel('loose', 'Not in a Stack', world.loose, true)}
        </div>
      </div>

      {/* A short note about what just happened */}
      {toast && (
        <div role="status" className="fixed z-[90] left-1/2 bottom-6 -translate-x-1/2 w-max max-w-[min(92vw,560px)] px-4 py-2.5 rounded-[18px] text-[15px] leading-[19px] text-center text-white" style={{ background: 'rgba(22,30,54,0.85)', backdropFilter: 'blur(24px)', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.1), 0 20px 40px -20px rgba(0,0,0,0.8)' }}>
          {toast}
        </div>
      )}

      {/* Stack details, like the real one: rename or delete */}
      {detailStack && (
        <div className="fixed inset-0 z-[88] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={() => setDetails(null)}>
          <div className="w-full max-w-[380px] rounded-[18px] overflow-hidden" style={{ background: ios.sheet, boxShadow: '0 30px 60px -20px rgba(0,0,0,0.8)' }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Stack Details">
            <div className="flex items-center justify-between px-4 h-12" style={{ borderBottom: `0.5px solid ${ios.separator}` }}>
              <span className="w-12" />
              <span className="text-[16px] font-semibold text-white">Stack Details</span>
              <LinkButton onClick={() => setDetails(null)}>Done</LinkButton>
            </div>
            <div className="p-4 space-y-3">
              <div className="text-center">
                <div className="text-[20px] font-semibold text-white">{detailStack.name}</div>
                <div className="text-[13px]" style={{ color: ios.secondary }}>
                  {detailStack.apps.length ? detailStack.apps.map((a) => APPS[a].name).join(', ') : 'No apps'}
                </div>
              </div>
              <div className="rounded-[12px] overflow-hidden" style={{ background: ios.group }}>
                <button type="button" className={`w-full text-left px-4 h-11 text-[16px] ${step === 'rename' ? 'mfx-practice-pulse' : ''}`} style={{ color: ios.link, borderBottom: `0.5px solid ${ios.separator}` }} onClick={() => { setRenaming(detailStack.id); setDetails(null); }}>
                  Rename
                </button>
                <button type="button" className={`w-full text-left px-4 h-11 text-[16px] ${step === 'delete' ? 'mfx-practice-pulse' : ''}`} style={{ color: ios.redText }} onClick={() => { setConfirmDelete(detailStack.id); setDetails(null); }}>
                  Delete Stack…
                </button>
              </div>
              <p className="px-1 text-[13px]" style={{ color: ios.secondary }}>
                On your server, this screen also has Start, Restart and Stop for all its apps, its compose file, and where it lives.
              </p>
            </div>
          </div>
        </div>
      )}

      <Alert
        open={Boolean(confirmDelete)}
        title={`Delete ${world.stacks.find((s) => s.id === confirmDelete)?.name || 'this stack'}?`}
        message="A full backup is kept first, so you can bring it back from Restore."
        confirmLabel="Delete"
        destructive
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) remove(confirmDelete);
          setConfirmDelete(null);
        }}
      />

      {/* Restore, like the real one: every change, newest first */}
      {restoreOpen && (
        <div className="fixed inset-0 z-[88] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={() => setRestoreOpen(false)}>
          <div className="w-full max-w-[460px] rounded-[18px] overflow-hidden" style={{ background: ios.sheet, boxShadow: '0 30px 60px -20px rgba(0,0,0,0.8)' }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Restore">
            <div className="flex items-center justify-between px-4 h-12" style={{ borderBottom: `0.5px solid ${ios.separator}` }}>
              <span className="w-12" />
              <span className="text-[16px] font-semibold text-white">Restore</span>
              <LinkButton onClick={() => setRestoreOpen(false)}>Done</LinkButton>
            </div>
            <div className="p-4">
              {!history.length ? (
                <p className="py-6 text-center text-[15px]" style={{ color: ios.secondary }}>
                  No changes yet. Each one you make shows up here, with its backup.
                </p>
              ) : (
                <div className="rounded-[12px] overflow-hidden" style={{ background: ios.group }}>
                  {history.map((h, i) => (
                    <div key={h.id} className="flex items-center gap-3 px-4 py-2.5" style={i ? { borderTop: `0.5px solid ${ios.separator}` } : undefined}>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[15px] text-white truncate">{h.title}</span>
                        <span className="block text-[13px]" style={{ color: ios.secondary }}>
                          {i === 0 ? 'Just now' : `${i} change${i === 1 ? '' : 's'} ago`} · backed up
                        </span>
                      </span>
                      <button type="button" onClick={() => restore(h)} className="h-8 px-3 rounded-full text-[13px] font-semibold" style={{ background: 'rgba(10,132,255,0.2)', color: '#64B5FF' }}>
                        Restore
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-3 px-1 text-[13px] leading-[17px]" style={{ color: ios.secondary }}>
                Restoring a change also undoes the newer changes to the same stacks, so everything fits together.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
