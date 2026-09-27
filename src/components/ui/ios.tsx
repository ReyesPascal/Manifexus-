/**
 * Apple-style building blocks (dark appearance) shared by the Move apps sheet and the
 * Delete stack dialog: inset grouped lists, rows, switches, alerts and section text.
 *
 * Colors follow Apple's dark-mode system palette so the pieces read as one family.
 */
import React, { useEffect, useRef } from 'react';

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
}> = ({ label, value, onChange, placeholder, autoFocus, mono, invalid, id }) => (
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
      className={`flex-1 min-w-0 bg-transparent py-[11px] text-right focus:outline-none placeholder:text-[rgba(235,235,245,0.3)] ${
        mono ? 'text-[13px] font-mono' : 'text-[15px]'
      }`}
      style={{ color: invalid ? ios.orange : ios.label }}
    />
  </label>
);

/** Open sheets, bottom to top, so Escape only closes the top one. */
const openSheets: symbol[] = [];

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
  width?: number;
  /** Extra content under the title bar that doesn't scroll (filters, segmented controls) */
  toolbar?: React.ReactNode;
  children: React.ReactNode;
  bodyRef?: React.Ref<HTMLDivElement>;
  /** Stacking order; raise it for sheets that open on top of other screens */
  zIndex?: number;
}> = ({ open, title, subtitle, onClose, closeLabel = 'Done', rightAction, leftAction, footer, width = 600, toolbar, children, bodyRef, zIndex = 50 }) => {
  // Escape closes only the sheet on top, not every open sheet underneath it
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const id = Symbol('sheet');
    openSheets.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && openSheets[openSheets.length - 1] === id) closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = openSheets.indexOf(id);
      if (i >= 0) openSheets.splice(i, 1);
    };
  }, [open]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 flex items-end sm:items-center justify-center sm:p-6 bg-black/55"
      style={{ fontFamily: ios.font, zIndex }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full h-[94vh] sm:h-[min(760px,88vh)] flex flex-col rounded-t-[14px] sm:rounded-[14px] overflow-hidden motion-safe:animate-[ios-sheet-in_220ms_ease-out]"
        style={{ maxWidth: width, background: ios.sheet, boxShadow: '0 30px 80px rgba(0,0,0,0.55)', WebkitFontSmoothing: 'antialiased' }}
      >
        <div className="relative px-4 pt-3.5 pb-3" style={{ borderBottom: `0.5px solid ${ios.separator}` }}>
          <div className="h-[28px] flex items-center justify-between">
            <span className="flex items-center min-w-[70px]">{leftAction}</span>
            <span className="flex items-center justify-end min-w-[70px]">
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
        <div ref={bodyRef} className="flex-1 overflow-y-auto px-4 sm:px-5 pt-5 pb-8">{children}</div>
        {footer && (
          <div className="px-4 sm:px-5 py-3" style={{ borderTop: `0.5px solid ${ios.separator}` }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

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
