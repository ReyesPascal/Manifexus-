import React from 'react';
import { Button, Group, IconTile, Row, SectionFooter, SectionHeader, Switch, Checkmark, ios } from './ui/ios';
import { ACCESS, ACTIVE_DL, Access, AssistantIcon, CatalogEntry, FREEDOM, Freedom, Status, fmtGB, fmtLeft, fmtSecs } from './aiShared';

/**
 * First-time setup for Ask Manifexus, shown when Ask or Fix with AI is opened before the AI is ready.
 * Six short pages: what it is, which models (the download starts right there and keeps going), what
 * it may do, what it may look at, how it thinks, and a summary that becomes the start button once the
 * everyday model is ready. Every choice saves as it's made and can be changed later in AI Settings.
 */

export const SETUP_PAGES = ['Welcome', 'Models', 'What It May Do', 'What It May Look At', 'How It Thinks', 'Ready'];

export interface ModelChoice {
  quick?: string;
  /** '' = no separate fixer: the quick helper does everything */
  fixer?: string;
}

interface Props {
  status: Status;
  page: number;
  go: (page: number) => void;
  choice: ModelChoice;
  setChoice: (c: ModelChoice) => void;
  /** The one-pipeline progress card for the models being set up */
  pipeline: React.ReactNode;
  bundleError?: string;
  startDownload: (items: { model: string; role: 'quick' | 'fixer' | 'both' }[]) => Promise<boolean>;
  setting: (patch: Record<string, unknown>) => void;
  finish: () => void;
  /** Opened from Fix with AI (or with a question): what it will do first once it's ready */
  firstQuestion?: string;
}

const FREEDOM_MORE: Record<Freedom, { example: string; icon: string; color: string }> = {
  look: { example: 'Ask “Why did Sonarr stop?” and it explains the cause and what you could change. It never changes anything.', icon: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', color: '#64D2FF' },
  ask: { example: 'It finds the fix and shows you a before/after of every file. Nothing happens until you tap Make Changes.', icon: 'M9 12l2 2 4-4M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3Z', color: '#30D158' },
  routine: { example: 'If restarting or starting an app is the fix, it just does it. Changes to files still wait for you.', icon: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v4.5h-4.5', color: '#FF9F0A' },
  expert: { example: 'Like Ask Before Changes, and it may also propose commands to run on your server. Each is shown first; commands can’t be undone.', icon: 'M4 6l5 5-5 5M11 17h9', color: '#FF453A' },
};

const Glyph: React.FC<{ d: string; color: string; size?: number }> = ({ d, color, size = 30 }) => (
  <IconTile color={color} size={size}>
    <svg width={size * 0.58} height={size * 0.58} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  </IconTile>
);

const Header: React.FC<{ title: string; sub: React.ReactNode; icon?: React.ReactNode }> = ({ title, sub, icon }) => (
  <div className="flex flex-col items-center text-center pt-1">
    {icon || <AssistantIcon size={60} />}
    <h3 className="mt-3.5 text-[22px] leading-[27px] font-semibold text-white">{title}</h3>
    <p className="mt-1.5 text-[14px] leading-[20px] max-w-[470px]" style={{ color: ios.secondary }}>
      {sub}
    </p>
  </div>
);

const Dots: React.FC<{ page: number }> = ({ page }) => (
  <div className="flex justify-center gap-1.5 pt-1" aria-hidden="true">
    {SETUP_PAGES.map((_, i) => (
      <span key={i} className="h-[6px] rounded-full transition-all duration-200" style={{ width: i === page ? 18 : 6, background: i <= page ? ios.blue : 'rgba(118,118,128,0.4)' }} />
    ))}
  </div>
);

const Badge: React.FC<{ children: React.ReactNode; color?: string; bg?: string }> = ({ children, color = '#64B5FF', bg = 'rgba(10,132,255,0.16)' }) => (
  <span className="text-[11px] font-semibold px-1.5 py-px rounded" style={{ background: bg, color }}>
    {children}
  </span>
);

/** How the downloads are doing, for the footer of the pages after the model choice */
function downloadLine(status: Status): string | undefined {
  const active = status.downloads.filter((d) => ACTIVE_DL.includes(d.status));
  if (!active.length) return undefined;
  const total = active.reduce((n, d) => n + (d.total || 0), 0);
  const done = active.reduce((n, d) => n + (d.status === 'verifying' ? d.total : d.completed), 0);
  const speed = active.find((d) => d.status === 'downloading')?.speed;
  const left = Math.max(0, total - done);
  if (!left) return 'Downloaded · testing it on your server';
  return `Downloading in the background · ${Math.round((done / Math.max(1, total)) * 100)}%${speed ? ` · ~${fmtLeft(left / speed)} left` : ''}`;
}

export function setupWizard(p: Props): { title: string; subtitle?: string; body: React.ReactNode; footer: React.ReactNode } {
  const { status, page, go, choice } = p;
  const byId = new Map(status.catalog.map((m) => [m.id, m]));
  const quick = choice.quick ? byId.get(choice.quick) : undefined;
  const fixer = choice.fixer ? byId.get(choice.fixer) : undefined;
  const access: Access = { logs: true, files: true, history: true, server: true, ...(status.settings.access || {}) };
  const freedom = status.settings.freedom;
  const auto = status.settings.auto !== false;
  const bg = downloadLine(status);
  const next = (label = 'Continue') => (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12.5px] tabular-nums min-w-0 truncate" style={{ color: ios.secondary }}>
        {bg || ''}
      </span>
      <Button onClick={() => go(page + 1)} className="sm:min-w-[170px] flex-shrink-0">
        {label}
      </Button>
    </div>
  );
  const subtitle = page > 0 ? `Step ${page} of ${SETUP_PAGES.length - 1}` : undefined;
  let body: React.ReactNode = null;
  let footer: React.ReactNode = null;

  if (page === 0) {
    // ------------------------------------------------------------ Welcome
    body = (
      <div className="space-y-7">
        <Header title="Set Up Ask Manifexus" sub="A private assistant that can look into problems with your apps and fix them with your OK. Setting it up takes a minute; the download keeps going while you choose the rest." />
        {p.firstQuestion && (
          <Group>
            <Row
              leading={<AssistantIcon size={30} />}
              title="Your question is saved"
              subtitle={<span className="whitespace-normal">When it’s ready, it starts on: “{p.firstQuestion.length > 110 ? `${p.firstQuestion.slice(0, 109)}…` : p.firstQuestion}”</span>}
            />
          </Group>
        )}
        <Group className="ios-inset-icon">
          <Row leading={<Glyph d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3Z" color="#30D158" />} title="Private and free" subtitle="It runs on your own server. Nothing leaves your network, and there are no accounts, keys or costs." />
          <Row leading={<Glyph d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" color="#64D2FF" />} title="Looks before it answers" subtitle="Your apps, their logs, settings files and history: only what you allow. Passwords and keys are always hidden from it." />
          <Row leading={<Glyph d="M9 12l2 2 4-4M4 12a8 8 0 1 0 16 0 8 8 0 0 0-16 0" color="#0A84FF" />} title="You stay in control" subtitle="Every change is shown to you first, backed up, and can be undone from Restore." />
        </Group>
        <SectionFooter>Next: choose the AI models, what it may do, what it may look at, and how hard it thinks. You can change any of it later in AI Settings.</SectionFooter>
      </div>
    );
    footer = (
      <div className="flex justify-end">
        <Button onClick={() => go(1)} className="flex-1 sm:flex-none sm:min-w-[200px]">
          Get Started
        </Button>
      </div>
    );
  } else if (page === 1) {
    // ------------------------------------------------------------ Models
    const s = status.specs;
    const pick = (role: 'quick' | 'fixer', m: CatalogEntry) => {
      const on = (role === 'quick' ? choice.quick : choice.fixer) === m.id;
      const rec = (role === 'quick' ? status.recommended.quick : status.recommended.fixer) === m.id;
      return (
        <Row
          key={`${role}-${m.id}`}
          role="radio"
          ariaChecked={on}
          onClick={m.fit === 'no' ? undefined : () => p.setChoice(role === 'quick' ? { ...choice, quick: m.id } : { ...choice, fixer: m.id })}
          title={
            <span className="flex items-center gap-2 flex-wrap" style={{ opacity: m.fit === 'no' ? 0.45 : 1 }}>
              {m.name}
              {rec && <Badge>Recommended</Badge>}
              {m.installed && <Badge color={ios.green} bg="rgba(48,209,88,0.15)">Downloaded</Badge>}
              {m.moe && <Badge color="#D69CFA" bg="rgba(191,90,242,0.18)">Efficient</Badge>}
            </span>
          }
          subtitle={
            <span className="block" style={{ opacity: m.fit === 'no' ? 0.55 : 1 }}>
              {m.blurb}
              <span className="block mt-0.5 tabular-nums" style={{ color: m.fit === 'no' ? ios.red : m.fit === 'tight' ? ios.orange : ios.tertiary }}>
                {fmtGB(m.downloadBytes)} · answers in {fmtSecs(m.seconds)}
                {m.why ? ` · ${m.why}` : ''}
              </span>
            </span>
          }
          trailing={<span className="w-[15px] flex justify-center">{on && <Checkmark />}</span>}
        />
      );
    };
    const fixers = status.catalog.filter((m) => m.role === 'fixer');
    const chosen = [quick, fixer && fixer.id !== quick?.id ? fixer : undefined].filter(Boolean) as CatalogEntry[];
    const toGet = chosen.filter((m) => !m.installed);
    const size = toGet.reduce((n, m) => n + m.downloadBytes, 0);
    body = (
      <div className="space-y-7">
        <Dots page={page} />
        <Header
          title="Pick the AI Models"
          sub="Two work best: a quick helper for most things, and a fixer for tricky problems. These are picked for your server; the fixer only runs when there’s memory free."
        />
        <section>
          <SectionHeader>Your Server</SectionHeader>
          <Group>
            <Row
              title="Processor"
              trailing={<span className="text-[14px] truncate max-w-[55vw] sm:max-w-[400px]">{s.cpu.model.replace(/\(R\)|\(TM\)|CPU|Processor/g, '').replace(/\s+/g, ' ').trim()} · {s.cpu.physicalCores || s.cpu.cores} cores</span>}
            />
            <Row title="Memory" trailing={<span className="text-[14px] tabular-nums">{fmtGB(s.memory.availableBytes)} free of {fmtGB(s.memory.totalBytes)}</span>} />
            <Row title="Graphics" trailing={<span className="text-[14px]">{s.gpus.length ? s.gpus.map((g) => g.name).join(', ') : 'None'}</span>} />
            <Row title="Disk" trailing={<span className="text-[14px] tabular-nums">{fmtGB(s.disk.freeBytes)} free</span>} />
          </Group>
          <SectionFooter>{s.gpuUsable ? 'The AI can use your graphics card, so it answers quickly.' : `The AI runs on the processor and keeps up to ${fmtGB(status.budgetBytes)} of memory for itself, so your apps never run short.`}</SectionFooter>
        </section>
        <section>
          <SectionHeader>Quick Helper</SectionHeader>
          <Group>{status.catalog.filter((m) => m.role === 'quick').map((m) => pick('quick', m))}</Group>
          <SectionFooter>Does most of the work: questions, lookups and simple fixes.</SectionFooter>
        </section>
        <section>
          <SectionHeader>Fixer</SectionHeader>
          <Group>
            {fixers.map((m) => pick('fixer', m))}
            <Row
              role="radio"
              ariaChecked={!choice.fixer}
              onClick={() => p.setChoice({ ...choice, fixer: '' })}
              title="None"
              subtitle="The quick helper does everything. Smaller download, weaker on tricky problems."
              trailing={<span className="w-[15px] flex justify-center">{!choice.fixer && <Checkmark />}</span>}
            />
          </Group>
          <SectionFooter>Takes tricky problems, and steps in when the quick helper gets stuck. “Efficient” models are large but only use part of themselves per word, so they’re quick without a graphics card.</SectionFooter>
        </section>
      </div>
    );
    footer = (
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12.5px] min-w-0" style={{ color: p.bundleError ? ios.orange : ios.secondary }}>
          {p.bundleError || (size ? `${fmtGB(size)} to download · ${fmtGB(s.disk.freeBytes)} free` : quick ? 'Already downloaded' : 'Choose a quick helper')}
        </span>
        <Button
          disabled={!quick || !status.engine.included}
          onClick={async () => {
            const items: { model: string; role: 'quick' | 'fixer' | 'both' }[] = [{ model: quick!.id, role: fixer && fixer.id !== quick!.id ? 'quick' : 'both' }];
            if (fixer && fixer.id !== quick!.id) items.push({ model: fixer.id, role: 'fixer' });
            if (await p.startDownload(items)) go(2);
          }}
          className="sm:min-w-[200px] flex-shrink-0"
        >
          {size ? 'Download and Continue' : 'Continue'}
        </Button>
      </div>
    );
  } else if (page === 2) {
    // ------------------------------------------------------------ What it may do
    body = (
      <div className="space-y-7">
        <Dots page={page} />
        <Header title="What It May Do" sub="How much it can do by itself. Whatever you choose, every change is backed up first and can be undone from Restore (except commands)." />
        <div className="space-y-2.5" role="radiogroup" aria-label="What it may do">
          {FREEDOM.map((f) => {
            const more = FREEDOM_MORE[f.value];
            const on = freedom === f.value;
            return (
              <button
                key={f.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => p.setting({ freedom: f.value })}
                className="w-full text-left rounded-[14px] px-4 py-3.5 flex gap-3.5 items-start transition-colors"
                style={{ background: ios.group, boxShadow: on ? `0 0 0 2px ${ios.blue}` : '0 0 0 0.5px rgba(255,255,255,0.06)' }}
              >
                <Glyph d={more.icon} color={more.color} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-[16px] font-semibold text-white">
                    {f.title}
                    {f.value === 'ask' && <Badge>Recommended</Badge>}
                  </span>
                  <span className="block mt-0.5 text-[13.5px] leading-[19px]" style={{ color: ios.secondary }}>
                    {more.example}
                  </span>
                </span>
                <span className="w-[18px] flex justify-center pt-1">{on && <Checkmark />}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
    footer = next();
  } else if (page === 3) {
    // ------------------------------------------------------------ What it may look at
    body = (
      <div className="space-y-7">
        <Dots page={page} />
        <Header title="What It May Look At" sub="The more it can see, the better it finds causes. Turn off anything you’d rather it didn’t read." />
        <section>
          <Group>
            <Row title="Apps, Stacks and Diagnostics" subtitle="Which apps you have, whether they’re running, and Manifexus’s health checks. Always on: it’s what it’s for." trailing={<span className="text-[13px]" style={{ color: ios.tertiary }}>Always</span>} />
            {ACCESS.map((a) => (
              <Row key={a.key} title={a.title} subtitle={a.sub} trailing={<Switch checked={access[a.key]} onChange={(v) => p.setting({ access: { [a.key]: v } })} label={a.title} />} />
            ))}
          </Group>
          <SectionFooter>
            Passwords, tokens and keys are always replaced with •••••• before it sees anything, whatever you choose.
            {!access.files && freedom !== 'look' ? ' Without files, it can’t fix settings stored in files; it will explain the change for you to make instead.' : ''}
          </SectionFooter>
        </section>
      </div>
    );
    footer = next();
  } else if (page === 4) {
    // ------------------------------------------------------------ How it thinks
    const q = quick?.name || 'The quick helper';
    const f = fixer && fixer.id !== quick?.id ? fixer : undefined;
    const rows: [string, string, string][] = f
      ? [
          ['A quick question', `${q}, answering straight away`, fmtSecs(quick?.seconds || 60)],
          ['A fix Diagnostics found', `${q}; thinks harder only to correct itself, and ${f.name} steps in if it gets stuck`, 'usually one pass'],
          ['A tricky problem', `${f.name}, thinking it through, when there’s memory free`, fmtSecs((f.seconds || 90) * 1.6)],
        ]
      : [
          ['A quick question', `${q}, answering straight away`, fmtSecs(quick?.seconds || 60)],
          ['A tricky problem', `${q}, thinking it through first`, 'takes longer'],
        ];
    body = (
      <div className="space-y-7">
        <Dots page={page} />
        <Header title="How It Thinks" sub="Thinking harder gives better answers on tricky problems, but takes longer without a graphics card. Manifexus can choose for each question." />
        <section>
          <Group>
            <Row
              title="Choose Automatically"
              subtitle="Picks the model, how much it thinks and what to look up first, for each question."
              trailing={<Switch checked={auto} onChange={(v) => p.setting({ auto: v })} label="Choose automatically" />}
            />
          </Group>
        </section>
        {auto ? (
          <section>
            <SectionHeader>What That Looks Like</SectionHeader>
            <Group>
              {rows.map(([when, what, time]) => (
                <Row key={when} title={when} subtitle={what} trailing={<span className="text-[13px] tabular-nums" style={{ color: ios.tertiary }}>{time}</span>} />
              ))}
            </Group>
            <SectionFooter>Each answer shows which model worked on it, what it looked at and how long each step took.</SectionFooter>
          </section>
        ) : (
          <SectionFooter>Off: every question goes to {f?.name || q}, with the same settings each time.</SectionFooter>
        )}
      </div>
    );
    footer = next('Continue');
  } else {
    // ------------------------------------------------------------ Ready
    const ready = status.ready;
    const allowed = ACCESS.filter((a) => access[a.key]).map((a) => a.title.toLowerCase());
    const seeing = allowed.length === ACCESS.length ? 'Everything it needs' : allowed.length ? `Apps and ${allowed.join(', ')}` : 'Only your apps and Diagnostics';
    const models = [quick?.name, fixer && fixer.id !== quick?.id ? fixer.name : undefined].filter(Boolean).join(' + ') || 'Not chosen';
    const active = status.downloads.some((d) => ACTIVE_DL.includes(d.status));
    body = (
      <div className="space-y-7">
        <Dots page={page} />
        <Header
          icon={
            ready ? (
              <IconTile color={ios.green} size={60}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
              </IconTile>
            ) : undefined
          }
          title={ready ? (active ? 'Ready to Go' : 'All Set') : 'Almost Ready'}
          sub={
            ready
              ? active
                ? 'The quick helper is ready, so you can start now. The fixer finishes in the background.'
                : 'Everything is downloaded and tested on your server.'
              : 'It’s downloading, testing and loading the models on your server, so every question can use the right one. You can close this: it keeps going, and your settings are saved.'
          }
        />
        {p.pipeline}
        <section>
          <SectionHeader>Your Choices</SectionHeader>
          <Group>
            <Row onClick={() => go(1)} title="Models" trailing={<span className="text-[14px] truncate max-w-[50vw] sm:max-w-[360px]">{models}</span>} chevron />
            <Row onClick={() => go(2)} title="May Do" trailing={<span className="text-[14px]">{FREEDOM.find((f) => f.value === freedom)?.title}</span>} chevron />
            <Row onClick={() => go(3)} title="May Look At" trailing={<span className="text-[14px] truncate max-w-[50vw] sm:max-w-[360px]">{seeing}</span>} chevron />
            <Row onClick={() => go(4)} title="Thinking" trailing={<span className="text-[14px]">{auto ? 'Chooses automatically' : 'Always the fixer'}</span>} chevron />
          </Group>
          <SectionFooter>You can change any of these later: the gear in Ask opens AI Settings.</SectionFooter>
        </section>
      </div>
    );
    footer = (
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12.5px] tabular-nums min-w-0 truncate" style={{ color: ios.secondary }}>
          {!ready ? status.setupBusy || bg || 'Getting it ready…' : ''}
        </span>
        <Button disabled={!ready} onClick={p.finish} className="sm:min-w-[200px] flex-shrink-0">
          {!ready ? 'Finishing Setup…' : p.firstQuestion ? 'Start on My Question' : 'Start Asking'}
        </Button>
      </div>
    );
  }

  return { title: page === 0 ? 'Built-in AI' : SETUP_PAGES[page], subtitle, body, footer };
}

