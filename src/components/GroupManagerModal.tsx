import React, { useState } from 'react';
import { X, Plus, Trash2, FolderKanban, Check } from 'lucide-react';
import { UserGroup } from '../types';

interface GroupManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  groups: UserGroup[];
  onSaveGroup: (group: Partial<UserGroup> & { id: string; name: string }) => Promise<void>;
  onDeleteGroup: (groupId: string) => Promise<void>;
}

const PRESET_COLORS = [
  '#06b6d4', // cyan
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#10b981', // emerald
  '#eab308', // amber
  '#f97316', // orange
  '#3b82f6', // blue
  '#64748b', // slate
];

export const GroupManagerModal: React.FC<GroupManagerModalProps> = ({
  isOpen,
  onClose,
  groups,
  onSaveGroup,
  onDeleteGroup,
}) => {
  if (!isOpen) return null;

  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupColor, setNewGroupColor] = useState(PRESET_COLORS[0]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleAddGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGroupName.trim()) return;

    const id = newGroupName.toLowerCase().replace(/[^a-z0-9]/g, '-');
    setIsSubmitting(true);
    try {
      await onSaveGroup({
        id,
        name: newGroupName.trim(),
        color: newGroupColor,
        icon: 'Folder',
      });
      setNewGroupName('');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="w-full max-w-lg bg-[#0b0f19] border border-slate-800 rounded-2xl shadow-2xl overflow-hidden font-mono text-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/50">
          <div className="flex items-center gap-2">
            <FolderKanban className="w-5 h-5 text-cyan-400" />
            <h2 className="text-base font-bold text-white">Manage Custom Categories</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5 text-xs">
          {/* Add New Group Form */}
          <form onSubmit={handleAddGroup} className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
            <div className="text-slate-300 font-bold">Create New Category</div>
            <div className="flex gap-2">
              <input
                type="text"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="e.g. AI & Machine Learning, Finance..."
                className="flex-1 px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
              />
              <button
                type="submit"
                disabled={isSubmitting || !newGroupName.trim()}
                className="px-3 py-2 rounded-lg bg-cyan-500 text-slate-950 font-bold hover:bg-cyan-400 transition-colors flex items-center gap-1 disabled:opacity-50"
              >
                <Plus className="w-4 h-4" />
                <span>Add</span>
              </button>
            </div>

            {/* Color selection */}
            <div className="flex items-center gap-2 pt-1">
              <span className="text-[11px] text-slate-400">Accent:</span>
              <div className="flex items-center gap-1.5">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setNewGroupColor(c)}
                    className="w-5 h-5 rounded-full border border-slate-700 flex items-center justify-center transition-transform hover:scale-110"
                    style={{ backgroundColor: c }}
                  >
                    {newGroupColor === c && <Check className="w-3 h-3 text-slate-950 stroke-[3]" />}
                  </button>
                ))}
              </div>
            </div>
          </form>

          {/* Current Groups List */}
          <div className="space-y-2">
            <div className="text-slate-400 font-semibold uppercase tracking-wider text-[11px]">
              Configured Categories ({groups.length})
            </div>

            <div className="max-h-60 overflow-y-auto space-y-1.5 pr-1">
              {groups.map((g) => (
                <div
                  key={g.id}
                  className="flex items-center justify-between p-2.5 rounded-xl bg-slate-900/60 border border-slate-800"
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className="w-3 h-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: g.color }}
                    ></span>
                    <div>
                      <span className="font-bold text-slate-200">{g.name}</span>
                      {g.description && (
                        <p className="text-[11px] text-slate-400 truncate max-w-xs">
                          {g.description}
                        </p>
                      )}
                    </div>
                  </div>

                  <button
                    onClick={() => onDeleteGroup(g.id)}
                    className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-950/40 transition-colors"
                    title="Delete Category"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-800 bg-slate-950/50 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
