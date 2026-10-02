/*
 * Liquid Glass: adapted from GlassSurface in React Bits (https://github.com/DavidHDev/react-bits).
 * Copyright (c) 2026 David Haz. MIT + Commons Clause License Condition v1.0: used here as part of
 * Manifexus; the component itself is not sold or redistributed on its own.
 */
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { countTo } from '../../motion';

/**
 * Apple-style Liquid Glass for the controls that float above the content (the toolbar, search, New Stack,
 * short messages). Like Apple's, it's for the control layer only, never for the content itself.
 *
 * In Chromium browsers (Chrome, Brave, Edge) the glass bends the light at its edges with a little colour
 * fringe, like real glass. Elsewhere it's the frosted glass the rest of the app uses. With Reduce
 * Transparency on, it's a solid surface.
 */

let svgFilters: boolean | null = null;
function supportsSvgBackdrop(): boolean {
  if (svgFilters !== null) return svgFilters;
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const webkitOnly = /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua);
  if (webkitOnly || /Firefox/.test(ua)) return (svgFilters = false);
  const div = document.createElement('div');
  div.style.backdropFilter = 'url(#x)';
  return (svgFilters = div.style.backdropFilter !== '');
}

const reduceTransparency = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-transparency: reduce)').matches;

/** The light and shadow on every glass edge (the hero's look) */
const EDGE = 'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 0 0 1px rgba(255,255,255,0.08), inset 0 -1px 0 rgba(255,255,255,0.04)';

export const LiquidGlass: React.FC<{
  children: React.ReactNode;
  /** Corner radius in px; a capsule by default (half the height) */
  radius?: number;
  /** Tint behind the glass, e.g. blue for the main action */
  tint?: string;
  /** How strongly the edges bend the light (0 = none) */
  strength?: number;
  className?: string;
  style?: React.CSSProperties;
  /** Extra shadow after the glass edge, e.g. a soft drop shadow */
  shadow?: string;
}> = ({ children, radius, tint = 'rgba(255,255,255,0.06)', strength = 1, className = '', style, shadow }) => {
  const id = `mfx-glass-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const ref = useRef<HTMLDivElement>(null);
  const image = useRef<SVGFEImageElement>(null);
  const [svg, setSvg] = useState(false);
  const [solid, setSolid] = useState(false);

  useEffect(() => {
    setSvg(supportsSvgBackdrop() && strength > 0);
    setSolid(reduceTransparency());
  }, [strength]);

  // The displacement map: the edges push the light inward, the middle stays clear
  useLayoutEffect(() => {
    if (!svg || !ref.current) return;
    const el = ref.current;
    const draw = () => {
      const r = el.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      const rx = Math.min(radius ?? h / 2, h / 2, w / 2);
      const edge = Math.min(w, h) * 0.07 * 0.5;
      const map = `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="r" x1="100%" y1="0%" x2="0%" y2="0%"><stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="red"/></linearGradient><linearGradient id="b" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="blue"/></linearGradient></defs><rect width="${w}" height="${h}" fill="black"/><rect width="${w}" height="${h}" rx="${rx}" fill="url(#r)"/><rect width="${w}" height="${h}" rx="${rx}" fill="url(#b)" style="mix-blend-mode:difference"/><rect x="${edge}" y="${edge}" width="${w - edge * 2}" height="${h - edge * 2}" rx="${rx}" fill="hsl(0 0% 50% / 0.93)" style="filter:blur(11px)"/></svg>`;
      image.current?.setAttribute('href', `data:image/svg+xml,${encodeURIComponent(map)}`);
    };
    draw();
    const ro = new ResizeObserver(() => draw());
    ro.observe(el);
    return () => ro.disconnect();
  }, [svg, radius]);

  const scale = -110 * strength;
  const backdrop = solid ? undefined : svg ? `url(#${id}) saturate(1.7)` : 'blur(24px) saturate(170%)';
  return (
    <div
      ref={ref}
      className={`relative isolate ${className}`}
      style={{
        borderRadius: radius ?? 9999,
        background: solid ? '#2a3150' : tint,
        backdropFilter: backdrop,
        WebkitBackdropFilter: svg ? undefined : backdrop,
        boxShadow: shadow ? `${EDGE}, ${shadow}` : EDGE,
        ...style,
      }}
    >
      {svg && (
        <svg aria-hidden className="absolute w-0 h-0 pointer-events-none" focusable="false">
          <defs>
            <filter id={id} colorInterpolationFilters="sRGB" x="0%" y="0%" width="100%" height="100%">
              <feImage ref={image} x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map" />
              <feDisplacementMap in="SourceGraphic" in2="map" scale={scale} xChannelSelector="R" yChannelSelector="G" result="dr" />
              <feColorMatrix in="dr" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="red" />
              <feDisplacementMap in="SourceGraphic" in2="map" scale={scale + 6} xChannelSelector="R" yChannelSelector="G" result="dg" />
              <feColorMatrix in="dg" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="green" />
              <feDisplacementMap in="SourceGraphic" in2="map" scale={scale + 12} xChannelSelector="R" yChannelSelector="G" result="db" />
              <feColorMatrix in="db" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="blue" />
              <feBlend in="red" in2="green" mode="screen" result="rg" />
              <feBlend in="rg" in2="blue" mode="screen" result="out" />
              <feGaussianBlur in="out" stdDeviation="0.7" />
            </filter>
          </defs>
        </svg>
      )}
      {children}
    </div>
  );
};

/**
 * A number that glides to its new value (React Bits' CountUp idea, without the animation library):
 * Running 9 → 10 counts over a moment instead of jumping. Instant with Reduce Motion.
 */
export const CountTo: React.FC<{ value?: number; className?: string; style?: React.CSSProperties }> = ({ value, className, style }) => {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (value === undefined) return setShown(undefined);
    const start = from.current ?? value;
    from.current = value;
    return countTo(start, value, setShown);
  }, [value]);
  return (
    <span className={className} style={style}>
      {shown ?? '…'}
    </span>
  );
};
