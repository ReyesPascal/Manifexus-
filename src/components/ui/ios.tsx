/**
 * Apple-style building blocks (dark appearance) shared by the Move apps sheet and the
 * Delete stack dialog: inset grouped lists, rows, switches, alerts and section text.
 *
 * Colors follow Apple's dark-mode system palette so the pieces read as one family.
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

export const ios = {
  sheet: '#1c1c1e',
  group: '#2c2c2e',
  groupPressed: '#3a3a3c',
  label: '#ffffff',
  secondary: 'rgba(235,235,245,0.6)',
  tertiary: 'rgba(235,235,245,0.3)',
  separator: 'rgba(84,84,88,0.65)',
  fill: 'rgba(118,118,128,0.24)',
  blue: '#0A84FF',
  green: '#30D158',
  red: '#FF453A',
  orange: '#FF9F0A',
  purple: '#BF5AF2',
  font: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Plus Jakarta Sans", system-ui, sans-serif',
};

/** Rounded group of rows with inset hairline separators. */
export const Group: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`ios-group rounded-[12px] overflow-hidden ${className}`} style={{ background: ios.group }}>
    {children}
  </div>
);

export const SectionHeader: React.FC<{ children: React.ReactNode; action?: React.ReactNode }> = ({ children, action }) => (
  <div className="flex items-baseline justify-between px-4 pb-1.5 pt-1">
    <h4 className="text-[13px] font-normal" style={{ color: ios.secondary }}>
      {children}
    </h4>
    {action}
  </div>
);

export const SectionFooter: React.FC<{ children: React.ReactNode; tone?: 'default' | 'danger' }> = ({ children, tone = 'default' }) => (
  <div className="px-4 pt-1.5 text-[13px] leading-[18px]" style={{ color: tone === 'danger' ? ios.red : ios.secondary }}>
    {children}
  </div>
);

/** Text button in the system tint, like "Select All" or "Turn On Backup". */
export const LinkButton: React.FC<{
  onClick: () => void;
  children: React.ReactNode;
  tone?: 'blue' | 'red';
  className?: string;
}> = ({ onClick, children, tone = 'blue', className = '' }) => (
  <button
    type="button"
    onClick={onClick}
    className={`text-[13px] font-medium rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0A84FF] hover:opacity-80 ${className}`}
    style={{ color: tone === 'red' ? ios.red : ios.blue }}
  >
    {children}
  </button>
);

/** A row inside a Group. `leading` is the icon, `trailing` the accessory on the right. */
export const Row: React.FC<{
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  chevron?: boolean;
  titleColor?: string;
  ariaPressed?: boolean;
  role?: string;
  ariaChecked?: boolean;
}> = ({ title, subtitle, leading, trailing, onClick, disabled, chevron, titleColor, ariaPressed, role, ariaChecked }) => {
  const content = (
    <>
      {leading && <span className="flex-shrink-0 flex items-center">{leading}</span>}
      <span className="min-w-0 flex-1 py-[11px]">
        <span className="block text-[15px] leading-[20px] truncate" style={{ color: titleColor || ios.label }}>
          {title}
        </span>
        {subtitle && (
          <span className="block text-[13px] leading-[18px] mt-0.5 break-words" style={{ color: ios.secondary }}>
            {subtitle}
          </span>
        )}
      </span>
      {trailing && <span className="flex-shrink-0 flex items-center gap-2 text-[15px]" style={{ color: ios.secondary }}>{trailing}</span>}
      {chevron && (
        <svg width="8" height="13" viewBox="0 0 8 13" aria-hidden="true" className="flex-shrink-0">
          <path d="M1.5 1.5 6.5 6.5 1.5 11.5" fill="none" stroke={ios.tertiary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </>
  );
  const cls = 'ios-row relative w-full flex items-center gap-3 pl-4 pr-4 min-h-[44px] text-left';
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-pressed={ariaPressed}
        role={role}
        aria-checked={ariaChecked}
        className={`${cls} transition-colors enabled:hover:bg-white/[0.04] enabled:active:bg-white/[0.08] disabled:cursor-default focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0A84FF] ${
          disabled ? 'opacity-40' : ''
        }`}
      >
        {content}
      </button>
    );
  }
  return <div className={cls}>{content}</div>;
};

/** iOS-style switch. */
export const Switch: React.FC<{ checked: boolean; onChange: (v: boolean) => void; label: string }> = ({ checked, onChange, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={() => onChange(!checked)}
    className="relative w-[51px] h-[31px] rounded-full transition-colors duration-200 flex-shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0A84FF]"
    style={{ background: checked ? ios.green : 'rgba(120,120,128,0.32)' }}
  >
    <span
      className="absolute top-[2px] left-[2px] w-[27px] h-[27px] rounded-full bg-white transition-transform duration-200 motion-reduce:transition-none"
      style={{ transform: checked ? 'translateX(20px)' : 'translateX(0)', boxShadow: '0 3px 8px rgba(0,0,0,0.15), 0 3px 1px rgba(0,0,0,0.06)' }}
    />
  </button>
);

/** Selection circle used in multi-select lists (like Mail's edit mode). */
export const SelectCircle: React.FC<{ on: boolean }> = ({ on }) => (
  <span
    aria-hidden="true"
    className="w-[22px] h-[22px] rounded-full flex items-center justify-center transition-colors"
    style={on ? { background: ios.blue } : { boxShadow: `inset 0 0 0 1.5px ${ios.tertiary}` }}
  >
    {on && (
      <svg width="12" height="10" viewBox="0 0 12 10">
        <path d="M1.5 5.2 4.4 8 10.5 1.8" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )}
  </span>
);

export const Checkmark: React.FC = () => (
  <svg width="15" height="12" viewBox="0 0 15 12" aria-hidden="true">
    <path d="M1.5 6.5 5.5 10.5 13.5 1.5" fill="none" stroke={ios.blue} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Rounded-square glyph tile, like the icons in iOS Settings. */
export const IconTile: React.FC<{ color: string; children: React.ReactNode; size?: number }> = ({ color, children, size = 29 }) => (
  <span
    aria-hidden="true"
    className="inline-flex items-center justify-center text-white flex-shrink-0"
    style={{ width: size, height: size, borderRadius: size * 0.24, background: color }}
  >
    {children}
  </span>
);

// No reds/pinks: in a delete dialog a red app icon would read as a warning
const TILE_COLORS = ['#0A84FF', '#30D158', '#FF9F0A', '#BF5AF2', '#64D2FF', '#5E5CE6', '#AC8E68', '#32ADE6'];

/** App icon: the app's own icon on a neutral tile, or its initials on a colored tile. */
export const AppTile: React.FC<{ name: string; iconUrl?: string; size?: number }> = ({ name, iconUrl, size = 29 }) => {
  const [failed, setFailed] = React.useState(false);
  const clean = name.replace(/^\//, '');
  let h = 0;
  for (let i = 0; i < clean.length; i++) h = (h * 31 + clean.charCodeAt(i)) >>> 0;
  if (iconUrl && !failed) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center flex-shrink-0 overflow-hidden bg-white/[0.08]"
        style={{ width: size, height: size, borderRadius: size * 0.24 }}
      >
        <img src={iconUrl} alt="" className="w-[74%] h-[74%] object-contain" onError={() => setFailed(true)} />
      </span>
    );
  }
  return (
    <IconTile color={TILE_COLORS[h % TILE_COLORS.length]} size={size}>
      <span className="font-semibold" style={{ fontSize: size * 0.4 }}>
        {clean.slice(0, 1).toUpperCase()}
      </span>
    </IconTile>
  );
};

export const StackGlyph: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m12 3 9 5-9 5-9-5 9-5Z" />
    <path d="m3 13 9 5 9-5" />
  </svg>
);

/** Filled button. `tone` picks the color; `variant: 'tinted'` gives the softer tinted style. */
export const Button: React.FC<{
  onClick: () => void;
  children: React.ReactNode;
  tone?: 'blue' | 'red' | 'gray';
  variant?: 'filled' | 'tinted';
  disabled?: boolean;
  className?: string;
  autoFocus?: boolean;
}> = ({ onClick, children, tone = 'blue', variant = 'filled', disabled, className = '', autoFocus }) => {
  const color = tone === 'red' ? ios.red : tone === 'gray' ? '#8e8e93' : ios.blue;
  const style =
    tone === 'gray'
      ? { background: 'rgba(118,118,128,0.24)', color: ios.label }
      : variant === 'tinted'
        ? { background: `${color}26`, color }
        : { background: color, color: '#fff' };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      autoFocus={autoFocus}
      className={`h-[44px] px-5 rounded-[12px] text-[15px] font-semibold transition-opacity enabled:hover:opacity-90 enabled:active:opacity-75 disabled:opacity-35 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0A84FF] inline-flex items-center justify-center gap-2 ${className}`}
      style={style}
    >
      {children}
    </button>
  );
};

/**
 * Confirmation alert (iOS style): title, message and two side-by-side buttons.
 * Focus starts on the safe choice; Escape cancels.
 */
export const Alert: React.FC<{
  open: boolean;
  title: string;
  message: string;
  cancelLabel?: string;
  confirmLabel: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ open, title, message, cancelLabel = 'Cancel', confirmLabel, destructive, onCancel, onConfirm }) => {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-6 bg-black/40" style={{ fontFamily: ios.font }}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ios-alert-title"
        aria-describedby="ios-alert-msg"
        className="w-[300px] rounded-[14px] overflow-hidden backdrop-blur-xl motion-safe:animate-[ios-pop_180ms_ease-out]"
        style={{ background: 'rgba(44,44,46,0.96)', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}
      >
        <div className="px-4 pt-5 pb-4 text-center">
          <h3 id="ios-alert-title" className="text-[17px] font-semibold text-white">
            {title}
          </h3>
          <p id="ios-alert-msg" className="mt-1 text-[13px] leading-[18px]" style={{ color: ios.label }}>
            {message}
          </p>
        </div>
        <div className="grid grid-cols-2" style={{ borderTop: `0.5px solid ${ios.separator}` }}>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="h-[44px] text-[17px] font-semibold hover:bg-white/[0.05] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0A84FF]"
            style={{ color: ios.blue, borderRight: `0.5px solid ${ios.separator}` }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="h-[44px] text-[17px] hover:bg-white/[0.05] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0A84FF]"
            style={{ color: destructive ? ios.red : ios.blue }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

/** Row with a text field on the right, like iOS form rows ("Name   media"). */
export const FieldRow: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  mono?: boolean;
  invalid?: boolean;
  id: string;
  /** Called when the field is done being edited: Enter, or leaving the field */
  onCommit?: () => void;
  /** Shown after the field, e.g. a "saved" checkmark */
  trailing?: React.ReactNode;
}> = ({ label, value, onChange, placeholder, autoFocus, mono, invalid, id, onCommit, trailing }) => (
  <label htmlFor={id} className="ios-row relative flex items-center gap-3 px-4 min-h-[44px] cursor-text">
    <span className="text-[15px] w-[76px] flex-shrink-0" style={{ color: ios.label }}>
      {label}
    </span>
    <input
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      autoComplete="off"
      spellCheck={false}
      aria-invalid={invalid || undefined}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && onCommit) {
          e.preventDefault();
          onCommit();
        }
      }}
      className={`flex-1 min-w-0 bg-transparent py-[11px] text-right focus:outline-none placeholder:text-[rgba(235,235,245,0.3)] ${
        mono ? 'text-[13px] font-mono' : 'text-[15px]'
      }`}
      style={{ color: invalid ? ios.orange : ios.label }}
    />
    {trailing}
  </label>
);

/** Open sheets, bottom to top, so Escape only closes the top one. */
const openSheets: symbol[] = [];

/**
 * The one size every Manifexus screen uses: fixed width and height on desktop, full screen on a phone.
 * Screens don't choose their own size, so everything opened from the dashboard feels like one app.
 * Custom-built sheets use these classes on their outer layers instead of their own sizes.
 */
export const SHEET_WIDTH = 760;
export const sheetBackdropClass = 'fixed inset-0 flex items-stretch sm:items-center justify-center sm:p-6 bg-black/55';
// Height uses the visible window (dvh), so the bottom of the sheet and its buttons are always on screen,
// even with browser toolbars; the body scrolls, the footer stays put.
export const sheetPanelClass =
  'w-full sm:max-w-[760px] h-[100dvh] sm:h-[min(760px,calc(100dvh-112px))] flex flex-col sm:rounded-[16px] overflow-hidden motion-safe:animate-[ios-sheet-in_220ms_ease-out]';
/** Panel look: a hairline edge all the way round so the sheet has a clear bottom, and a soft shadow */
export const sheetPanelStyle: React.CSSProperties = {
  background: ios.sheet,
  boxShadow: '0 0 0 0.5px rgba(255,255,255,0.14), 0 30px 80px rgba(0,0,0,0.6)',
  WebkitFontSmoothing: 'antialiased',
};
/** Scrolling area: content fades out just above the bottom edge instead of being cut off */
export const sheetBodyStyle: React.CSSProperties = {
  maskImage: 'linear-gradient(to bottom, #000 calc(100% - 28px), transparent)',
  WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 28px), transparent)',
};
/** Footer bar for custom sheets: pinned under the scrolling body, clear of a phone's home indicator */
export const sheetFooterClass = 'flex-shrink-0 px-4 sm:px-5 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]';

/**
 * Standard sheet: dimmed backdrop, nav bar with a left action and centered title, scrolling body.
 * Escape and clicking the backdrop close it. Use this for every new full screen.
 */
export const Sheet: React.FC<{
  open: boolean;
  title: string;
  subtitle?: React.ReactNode;
  onClose: () => void;
  closeLabel?: string;
  rightAction?: React.ReactNode;
  /** Replaces the empty left slot, e.g. with a BackButton */
  leftAction?: React.ReactNode;
  footer?: React.ReactNode;
  /** Extra content under the title bar that doesn't scroll (filters, segmented controls) */
  toolbar?: React.ReactNode;
  children: React.ReactNode;
  bodyRef?: React.Ref<HTMLDivElement>;
  /** Stacking order; raise it for sheets that open on top of other screens */
  zIndex?: number;
  /** Shown just before Done, e.g. a settings gear when the left side holds a Back button */
  rightExtra?: React.ReactNode;
  /** Kept open but out of sight while another screen is pushed on top of it (keeps its place and scroll) */
  hidden?: boolean;
}> = ({ open, title, subtitle, onClose, closeLabel = 'Done', rightAction, leftAction, footer, toolbar, children, bodyRef, zIndex = 50, rightExtra, hidden }) => {
  // Focus the sheet itself when it opens (not its first button, which would look selected),
  // and hand focus back to whatever opened it when it closes
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [open]);
  // Escape closes only the sheet on top, not every open sheet underneath it
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const id = Symbol('sheet');
    openSheets.push(id);
    // While a sheet is up, the dashboard behind it stops animating (see index.css): fewer repaints,
    // and no garbled patches when the computer is short on graphics memory (e.g. while the AI loads)
    document.documentElement.classList.add('sheet-open');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && openSheets[openSheets.length - 1] === id) closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = openSheets.indexOf(id);
      if (i >= 0) openSheets.splice(i, 1);
      if (!openSheets.length) document.documentElement.classList.remove('sheet-open');
    };
  }, [open]);
  if (!open) return null;
  return (
    <div
      className={sheetBackdropClass}
      style={{ fontFamily: ios.font, zIndex, display: hidden ? 'none' : undefined }}
      aria-hidden={hidden || undefined}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`${sheetPanelClass} outline-none`}
        style={sheetPanelStyle}
      >
        <div className="relative px-4 pt-3.5 pb-3" style={{ borderBottom: `0.5px solid ${ios.separator}` }}>
          <div className="h-[28px] flex items-center justify-between">
            <span className="flex items-center min-w-[70px]">{leftAction}</span>
            <span className="flex items-center justify-end gap-4 min-w-[70px]">
              {rightExtra}
              {rightAction ?? (
                <button
                  type="button"
                  onClick={onClose}
                  className="text-[17px] font-semibold rounded focus-visible:outline-2 focus-visible:outline-[#0A84FF] hover:opacity-80"
                  style={{ color: ios.blue }}
                >
                  {closeLabel}
                </button>
              )}
            </span>
          </div>
          <h2 className="absolute left-1/2 top-3.5 -translate-x-1/2 h-[28px] flex items-center text-[17px] font-semibold text-white whitespace-nowrap">
            {title}
          </h2>
          {subtitle && (
            <p className="mt-1 text-[13px] text-center truncate px-10" style={{ color: ios.secondary }}>
              {subtitle}
            </p>
          )}
        </div>
        {toolbar && (
          <div className="px-4 sm:px-5 pt-3 pb-3 space-y-3" style={{ borderBottom: `0.5px solid ${ios.separator}` }}>
            {toolbar}
          </div>
        )}
        <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 pt-5 pb-10" style={sheetBodyStyle}>
          {children}
        </div>
        {footer && (
          <div className={sheetFooterClass} style={{ borderTop: `0.5px solid ${ios.separator}` }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

/** Settings gear for a Sheet's title bar (top left, or beside Done when the left holds a Back button). */
export const GearButton: React.FC<{ onClick: () => void; label: string }> = ({ onClick, label }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    title={label}
    className="p-1 -m-1 rounded hover:opacity-80 focus-visible:outline-2 focus-visible:outline-[#0A84FF]"
    style={{ color: ios.blue }}
  >
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  </button>
);

/** "‹ Back" button for the left side of a Sheet's title bar. */
export const BackButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="-ml-1 inline-flex items-center gap-1 text-[17px] rounded focus-visible:outline-2 focus-visible:outline-[#0A84FF] hover:opacity-80"
    style={{ color: ios.blue }}
  >
    <svg width="11" height="18" viewBox="0 0 11 18" aria-hidden="true">
      <path d="M9 2 2 9l7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
    {label}
  </button>
);

/** iOS segmented control. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
}: {
  value: T;
  options: { value: T; label: React.ReactNode }[];
  onChange: (v: T) => void;
  label: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex p-[2px] rounded-[9px] w-full" style={{ background: ios.fill }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`flex-1 rounded-[7px] ${size === 'sm' ? 'h-[26px] text-[12px]' : 'h-[30px] text-[13px]'} font-medium transition-colors focus-visible:outline-2 focus-visible:outline-[#0A84FF] whitespace-nowrap px-2`}
            style={on ? { background: '#636366', color: '#fff', boxShadow: '0 3px 8px rgba(0,0,0,0.12)' } : { color: ios.label }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Rounded filter chip (toggle). */
export const Chip: React.FC<{ on: boolean; onClick: () => void; children: React.ReactNode; tone?: string }> = ({ on, onClick, children, tone }) => (
  <button
    type="button"
    aria-pressed={on}
    onClick={onClick}
    className="h-[28px] px-3 rounded-full text-[13px] font-medium whitespace-nowrap flex-shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-[#0A84FF]"
    style={on ? { background: tone || ios.blue, color: '#fff' } : { background: ios.fill, color: ios.label }}
  >
    {children}
  </button>
);

/** Search field in the iOS style. */
export const SearchField: React.FC<{ value: string; onChange: (v: string) => void; placeholder?: string; label: string }> = ({ value, onChange, placeholder = 'Search', label }) => (
  <div className="relative">
    <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={ios.secondary} strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={label}
      className="w-full h-9 pl-8 pr-8 rounded-[10px] text-[15px] text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF] placeholder:text-[rgba(235,235,245,0.6)]"
      style={{ background: ios.fill }}
    />
    {value && (
      <button
        type="button"
        onClick={() => onChange('')}
        aria-label="Clear search"
        className="absolute right-2 top-1/2 -translate-y-1/2 w-[18px] h-[18px] rounded-full flex items-center justify-center"
        style={{ background: 'rgba(235,235,245,0.3)' }}
      >
        <svg width="8" height="8" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2 2 8" stroke="#1c1c1e" strokeWidth="2" strokeLinecap="round" /></svg>
      </button>
    )}
  </div>
);

// ----------------------------------------------------------------------------
// Pull-down menu
// ----------------------------------------------------------------------------

export interface MenuItem {
  key: string;
  label: React.ReactNode;
  /** Shows a checkmark in the leading column */
  checked?: boolean;
  /** Small colored dot before the label (e.g. red for Problems) */
  dot?: string;
  /** Draws a divider above this item */
  divider?: boolean;
  /** Keep the menu open after choosing (for multi-select) */
  keepOpen?: boolean;
  /** A small caption above the items that follow (not tappable) */
  header?: boolean;
  /** Red text, for actions like Stop */
  destructive?: boolean;
  /** Trailing detail, e.g. ":8081" */
  detail?: React.ReactNode;
  onSelect: () => void;
}

/** Pop-up button chevrons (like chevron.up.chevron.down) */
const PopupChevrons: React.FC = () => (
  <svg width="9" height="13" viewBox="0 0 9 13" aria-hidden="true" className="flex-shrink-0 opacity-80">
    <path d="M1.5 4.5 4.5 1.5l3 3M1.5 8.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * Apple-style pull-down menu: a quiet button that opens a floating list with checkmarks.
 * `look="field"` matches a search field (for toolbars); `look="link"` is plain blue text (for footers).
 * Opens upward when there isn't room below.
 */
export const MenuButton: React.FC<{
  label: React.ReactNode;
  ariaLabel: string;
  items: MenuItem[];
  look?: 'field' | 'link' | 'bare';
  /** Tint the label, e.g. blue when a filter is active */
  tint?: string;
  align?: 'left' | 'right';
  className?: string;
  /** Hover text for the button */
  title?: string;
}> = ({ label, ariaLabel, items, look = 'field', tint, align = 'right', className = '', title }) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left?: number; right?: number; maxHeight: number }>();
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const below = vh - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 260 && above > below;
    const horiz = align === 'right' ? { right: Math.max(8, vw - r.right) } : { left: Math.max(8, r.left) };
    setPos(up ? { bottom: vh - r.top + 6, maxHeight: above - 6, ...horiz } : { top: r.bottom + 6, maxHeight: below - 6, ...horiz });
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    // A tap outside only dismisses the menu (as on iOS); it doesn't also press what's underneath
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
      const swallow = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, true), 400);
    };
    // Capture phase: Escape closes the menu without also closing the sheet underneath
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    const onScroll = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    const onResize = () => setOpen(false);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const anyChecks = items.some((i) => i.checked !== undefined);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={
          look === 'bare'
            ? className
            : look === 'field'
            ? `h-9 pl-3 pr-2.5 rounded-[10px] inline-flex items-center gap-1.5 text-[15px] whitespace-nowrap flex-shrink-0 transition-colors hover:bg-white/[0.06] focus-visible:outline-2 focus-visible:outline-[#0A84FF] ${className}`
            : `inline-flex items-center gap-1 text-[13px] font-medium rounded hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0A84FF] ${className}`
        }
        style={look === 'bare' ? undefined : look === 'field' ? { background: open ? ios.groupPressed : ios.fill, color: tint || ios.label } : { color: tint || ios.blue }}
      >
        {look === 'bare' ? (
          label
        ) : (
          <>
            <span className="truncate">{label}</span>
            <PopupChevrons />
          </>
        )}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={ariaLabel}
          onClick={(e) => e.stopPropagation()}
          className="fixed z-[100] min-w-[230px] max-w-[300px] py-1.5 rounded-[13px] overflow-y-auto"
          style={{
            ...pos,
            visibility: pos ? 'visible' : 'hidden',
            background: 'rgba(40,40,42,0.94)',
            backdropFilter: 'blur(30px) saturate(1.6)',
            WebkitBackdropFilter: 'blur(30px) saturate(1.6)',
            boxShadow: '0 0 0 0.5px rgba(255,255,255,0.12), 0 18px 48px rgba(0,0,0,0.55)',
            fontFamily: ios.font,
          }}
        >
          {items.map((it) => (
            <React.Fragment key={it.key}>
              {it.divider && <div className="my-1.5 h-[6px]" style={{ background: 'rgba(0,0,0,0.28)' }} role="separator" />}
              {it.header ? (
                <div className="px-4 pt-1.5 pb-1 text-[12.5px]" style={{ color: ios.secondary }}>
                  {it.label}
                </div>
              ) : (
              <button
                type="button"
                role={it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
                aria-checked={it.checked}
                onClick={() => {
                  it.onSelect();
                  if (!it.keepOpen) setOpen(false);
                }}
                className="w-full h-[38px] flex items-center gap-2 pr-4 text-left text-[15px] text-white hover:bg-white/[0.08] focus-visible:bg-white/[0.08] focus:outline-none"
                style={{ paddingLeft: anyChecks ? 10 : 16 }}
              >
                {anyChecks && (
                  <span className="w-[16px] flex justify-center flex-shrink-0">
                    {it.checked && (
                      <svg width="13" height="11" viewBox="0 0 14 11" aria-hidden="true">
                        <path d="M1.5 5.8 5.2 9.5 12.5 1.5" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                )}
                {it.dot && <span className="w-[7px] h-[7px] rounded-full flex-shrink-0" style={{ background: it.dot }} />}
                <span className="truncate flex-1" style={it.destructive ? { color: ios.red } : undefined}>
                  {it.label}
                </span>
                {it.detail && (
                  <span className="flex-shrink-0 text-[13px] tabular-nums" style={{ color: ios.secondary }}>
                    {it.detail}
                  </span>
                )}
              </button>
              )}
            </React.Fragment>
          ))}
        </div>
      )}
    </>
  );
};
