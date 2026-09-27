import React from 'react';
import { Layers, FolderKanban, FolderPlus, SlidersHorizontal } from 'lucide-react';
import { ios } from './ui/ios';

interface ViewBarProps {
  viewMode: 'groups' | 'compose';
  onViewModeChange: (mode: 'groups' | 'compose') => void;
  onOpenGroupManager: () => void;
  onOpenCreateStack?: () => void;
}

/** How the app list is arranged (by stack or by your own groups), plus the actions for each. */
export const ViewBar: React.FC<ViewBarProps> = ({ viewMode, onViewModeChange, onOpenGroupManager, onOpenCreateStack }) => {
  const seg = (active: boolean) =>
    `relative inline-flex items-center gap-1.5 h-7 px-3 rounded-[7px] text-[13px] font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF] ${
      active ? 'text-white' : 'hover:text-white'
    }`;
  const segStyle = (active: boolean): React.CSSProperties =>
    active
      ? { background: 'rgba(99,99,102,0.9)', boxShadow: '0 1px 3px rgba(0,0,0,0.35), inset 0 0.5px 0 rgba(255,255,255,0.12)' }
      : { color: ios.secondary };
  const action =
    'inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[13px] font-medium transition-colors hover:bg-white/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A84FF]';

  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3" style={{ fontFamily: ios.font }}>
      <div
        role="tablist"
        aria-label="Arrange apps"
        className="inline-flex p-[2px] rounded-[9px]"
        style={{ background: 'rgba(118,118,128,0.2)', boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.06)' }}
      >
        <button
          role="tab"
          aria-selected={viewMode === 'compose'}
          onClick={() => onViewModeChange('compose')}
          className={seg(viewMode === 'compose')}
          style={segStyle(viewMode === 'compose')}
          title="Arrange apps by their Docker Compose stack"
        >
          <Layers className="w-3.5 h-3.5" />
          Stacks
        </button>
        <button
          role="tab"
          aria-selected={viewMode === 'groups'}
          onClick={() => onViewModeChange('groups')}
          className={seg(viewMode === 'groups')}
          style={segStyle(viewMode === 'groups')}
          title="Arrange apps by groups you create"
        >
          <FolderKanban className="w-3.5 h-3.5" />
          My Groups
        </button>
      </div>

      <div className="flex items-center gap-1">
        <button type="button" onClick={onOpenGroupManager} className={action} style={{ color: 'rgba(255,255,255,0.88)' }} title="Create, rename and fill your own app groups">
          <SlidersHorizontal className="w-[15px] h-[15px]" />
          Manage Groups
        </button>
        {onOpenCreateStack && (
          <button
            type="button"
            onClick={onOpenCreateStack}
            className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-full text-[13px] font-semibold text-white transition-all hover:brightness-110 active:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-black focus-visible:ring-[#0A84FF]"
            style={{ background: ios.blue, boxShadow: '0 4px 14px -4px rgba(10,132,255,0.6), inset 0 0.5px 0 rgba(255,255,255,0.25)' }}
            title="Create a new, empty Compose stack folder"
          >
            <FolderPlus className="w-[15px] h-[15px]" />
            New Stack
          </button>
        )}
      </div>
    </div>
  );
};
