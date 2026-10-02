import { gsap } from 'gsap';

/**
 * All of Manifexus's motion goes through here, on GSAP: stacks and apps gliding into place, screens
 * opening, rows arriving, numbers counting, marks drawing, the welcome. One feel everywhere: short
 * (0.2-0.35 s, as Apple's guidelines ask), eased out, never in the way. With Reduce Motion on,
 * everything simply appears in place.
 *
 * Endless ambient loops (the shimmer on "Moving…", the light around a busy card) stay in CSS, where the
 * browser runs them without waking the page.
 */

export const EASE = 'power3.out';
export const DUR = { quick: 0.2, base: 0.28, glide: 0.48, far: 0.65 } as const;

gsap.defaults({ ease: EASE, duration: DUR.base, overwrite: 'auto' });

export const reduceMotion = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Something moved: glide it from where it was (dx, dy in its own pixels) to where it is now */
export function glideFrom(el: Element, dx: number, dy: number, opts: { lift?: boolean; far?: boolean } = {}) {
  if (reduceMotion()) return;
  gsap.fromTo(
    el,
    { x: dx, y: dy, scale: opts.lift ? 1.03 : 1, zIndex: opts.lift ? 30 : 1 },
    { x: 0, y: 0, scale: 1, duration: opts.far ? DUR.far : DUR.glide, ease: 'power3.out', clearProps: 'transform,zIndex' }
  );
}

/** Something new appears (a stack, a message): it settles in */
export function popIn(el: Element | null) {
  if (!el || reduceMotion()) return;
  gsap.fromTo(el, { opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1, duration: 0.42, ease: 'back.out(1.6)', clearProps: 'transform,opacity' });
}

/** A screen opens: it rises into place, and its rows arrive one after another */
export function sheetIn(panel: Element | null, backdrop?: Element | null) {
  if (!panel || reduceMotion()) return;
  if (backdrop) gsap.fromTo(backdrop, { backgroundColor: 'rgba(0,0,0,0)' }, { backgroundColor: 'rgba(0,0,0,0.55)', duration: DUR.quick, ease: 'none', clearProps: 'backgroundColor' });
  gsap.fromTo(panel, { y: 18, opacity: 0, scale: 0.985 }, { y: 0, opacity: 1, scale: 1, duration: DUR.base, clearProps: 'transform,opacity' });
  rowsIn(panel);
}

/** The rows of the lists in a screen arrive one after another (only the first dozen wait their turn) */
export function rowsIn(root: Element | null) {
  if (!root || reduceMotion()) return;
  const rows = Array.from(root.querySelectorAll('.ios-group > *')).slice(0, 14);
  if (!rows.length) return;
  gsap.fromTo(rows, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.26, stagger: 0.025, delay: 0.06, clearProps: 'transform,opacity' });
}

/** A number counts to its new value */
export function countTo(from: number, to: number, onUpdate: (v: number) => void): () => void {
  if (reduceMotion() || from === to) {
    onUpdate(to);
    return () => undefined;
  }
  const o = { v: from };
  const t = gsap.to(o, { v: to, duration: Math.min(0.9, 0.22 + Math.abs(to - from) * 0.06), ease: 'power3.out', onUpdate: () => onUpdate(Math.round(o.v)) });
  return () => t.kill();
}

/** A check or mark draws itself in (its path uses pathLength="1") */
export function drawIn(svg: SVGSVGElement | null) {
  if (!svg) return;
  const paths = svg.querySelectorAll('path');
  if (reduceMotion()) return;
  gsap.fromTo(paths, { strokeDasharray: 1, strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.42, ease: 'power2.inOut', delay: 0.08 });
}

/** The finish badge pops in */
export function badgeIn(el: Element | null) {
  if (!el || reduceMotion()) return;
  gsap.fromTo(el, { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.38, ease: 'back.out(1.8)', clearProps: 'transform,opacity' });
}

/** Letters come into focus one after another (the first-time welcome) */
export function blurIn(letters: Element[]) {
  if (!letters.length || reduceMotion()) return;
  gsap.fromTo(letters, { opacity: 0, filter: 'blur(10px)', y: 4 }, { opacity: 1, filter: 'blur(0px)', y: 0, duration: 0.6, stagger: 0.035, clearProps: 'filter,transform,opacity' });
}

export { gsap };

type Enter = 'sheet' | 'push' | 'rise' | 'fade' | 'pop' | 'badge' | 'draw' | 'blur';

/**
 * A callback ref that plays an entrance once, when the element first appears:
 *   <div ref={enter('push')}>   (a view pushed inside a screen)
 * Each element plays it only once, however often it re-renders.
 */
export function enter(kind: Enter) {
  return (el: Element | null) => {
    if (!el || (el as HTMLElement).dataset?.mfxIn) return;
    (el as HTMLElement).dataset.mfxIn = '1';
    if (reduceMotion()) return;
    switch (kind) {
      case 'sheet':
        return sheetIn(el, el.parentElement);
      case 'push':
        gsap.fromTo(el, { x: 24, opacity: 0 }, { x: 0, opacity: 1, duration: DUR.quick, clearProps: 'transform,opacity' });
        return rowsIn(el);
      case 'rise':
        return void gsap.fromTo(el, { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: DUR.base, clearProps: 'transform,opacity' });
      case 'fade':
        return void gsap.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.15, ease: 'none', clearProps: 'opacity' });
      case 'pop':
        return popIn(el);
      case 'badge':
        return badgeIn(el);
      case 'draw':
        return drawIn(el as SVGSVGElement);
      case 'blur':
        return blurIn(Array.from(el.children));
    }
  };
}
