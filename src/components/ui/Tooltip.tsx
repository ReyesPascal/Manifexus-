import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ios } from './ios';

/**
 * Tooltips, for the whole app, always on top.
 *
 * Every tooltip is drawn in one layer on the page itself (never inside a panel), so no glass, stack, sheet
 * or zoomed area can cover or clip it, and it's kept inside the window (flipping above or below to fit).
 *
 *   - Plain text: just give the element a `title` (or `data-tip`). The layer picks it up automatically and
 *     shows it in the app's style instead of the browser's plain box.
 *   - Richer content: spread `tipProps(<content />)` onto the element.
 *
 * Don't build tooltips out of absolutely positioned elements inside a component: whatever sits above that
 * component (a search field, the next stack) will cover them.
 */

type Tip = { el: Element; content: React.ReactNode; wide?: boolean };
let current: Tip | null = null;
const listeners = new Set<(t: Tip | null) => void>();
const set = (t: Tip | null) => {
  current = t;
  listeners.forEach((l) => l(t));
};

let showTimer: ReturnType<typeof setTimeout> | undefined;
const SHOW_DELAY = 350;

function schedule(t: Tip, now = false) {
  clearTimeout(showTimer);
  // Moving from one tooltip straight to the next shows it at once, like macOS
  if (now || current) set(t);
  else showTimer = setTimeout(() => set(t), SHOW_DELAY);
}
function hide(el?: Element) {
  clearTimeout(showTimer);
  if (!el || current?.el === el) set(null);
}

/** Rich tooltip content for one element (spread onto it) */
export function tipProps(content: React.ReactNode, opts: { wide?: boolean } = {}) {
  return {
    onPointerEnter: (e: React.PointerEvent) => e.pointerType !== 'touch' && schedule({ el: e.currentTarget, content, wide: opts.wide }),
    onPointerLeave: (e: React.PointerEvent) => hide(e.currentTarget),
    onFocus: (e: React.FocusEvent) => e.currentTarget.matches(':focus-visible') && schedule({ el: e.currentTarget, content, wide: opts.wide }, true),
    onBlur: (e: React.FocusEvent) => hide(e.currentTarget),
    'data-rich-tip': '',
  };
}

/** Turns a native `title` into ours (keeping it as the accessible name when the element has none) */
function textTipFor(start: EventTarget | null): { el: Element; text: string } | null {
  if (!(start instanceof Element)) return null;
  const el = start.closest('[title],[data-tip]');
  if (!el || el instanceof HTMLIFrameElement || el.closest('[data-rich-tip]')) return null;
  const title = el.getAttribute('title');
  if (title !== null) {
    el.removeAttribute('title');
    if (title.trim()) {
      el.setAttribute('data-tip', title);
      if (!el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !(el.textContent || '').trim()) el.setAttribute('aria-label', title);
    }
  }
  const text = el.getAttribute('data-tip') || '';
  return text.trim() ? { el, text } : null;
}

const GAP = 8;
const EDGE = 8;

/** Mount once, at the top of the app */
export const TooltipLayer: React.FC = () => {
  const [tip, setTip] = useState<Tip | null>(current);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listeners.add(setTip);
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const t = textTipFor(e.target);
      if (t) {
        if (current?.el !== t.el) schedule({ el: t.el, content: t.text });
      } else if (current && !(current.el as Element).contains(e.target as Node) && !current.el.hasAttribute('data-rich-tip')) {
        hide();
      }
    };
    const out = (e: PointerEvent) => {
      if (current && !current.el.hasAttribute('data-rich-tip') && !current.el.contains(e.relatedTarget as Node)) hide(current.el);
      else if (!current) clearTimeout(showTimer);
    };
    const focusIn = (e: FocusEvent) => {
      const target = e.target as Element;
      if (!target?.matches?.(':focus-visible')) return;
      const t = textTipFor(target);
      if (t && t.el === target) schedule({ el: t.el, content: t.text }, true);
    };
    const focusOut = (e: FocusEvent) => current && current.el === e.target && !current.el.hasAttribute('data-rich-tip') && hide();
    const away = () => hide();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && current && hide();
    document.addEventListener('pointerover', over, true);
    document.addEventListener('pointerout', out, true);
    document.addEventListener('focusin', focusIn, true);
    document.addEventListener('focusout', focusOut, true);
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => {
      listeners.delete(setTip);
      document.removeEventListener('pointerover', over, true);
      document.removeEventListener('pointerout', out, true);
      document.removeEventListener('focusin', focusIn, true);
      document.removeEventListener('focusout', focusOut, true);
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, []);

  // Place it under what it's about (or above when there's no room), inside the window
  useLayoutEffect(() => {
    setPos(null);
    if (!tip) return;
    const measure = () => {
      if (!box.current || !tip.el.isConnected) return setTip(null);
      const r = tip.el.getBoundingClientRect();
      const b = box.current.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const above = r.bottom + GAP + b.height > vh - EDGE && r.top - GAP - b.height >= EDGE;
      const left = Math.min(Math.max(EDGE, r.left + r.width / 2 - b.width / 2), vw - EDGE - b.width);
      setPos({ left, top: above ? r.top - GAP - b.height : r.bottom + GAP, above });
    };
    measure();
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={box}
      role="tooltip"
      className="fixed pointer-events-none rounded-[10px] px-2.5 py-1.5 text-[12px] leading-snug text-left"
      style={{
        zIndex: 2147483000,
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? 'visible' : 'hidden',
        maxWidth: tip.wide ? 280 : 240,
        width: 'max-content',
        background: 'rgba(30,40,70,0.96)',
        color: 'rgba(235,235,245,0.86)',
        boxShadow: '0 0 0 0.5px rgba(255,255,255,0.12), 0 10px 30px rgba(0,0,0,0.55)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        fontFamily: ios.font,
        animation: pos ? `mfx-tip-in 140ms ease-out` : undefined,
        transformOrigin: pos?.above ? 'bottom center' : 'top center',
      }}
    >
      <style>{`@keyframes mfx-tip-in{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:none}}`}</style>
      {tip.content}
    </div>,
    document.body,
  );
};
