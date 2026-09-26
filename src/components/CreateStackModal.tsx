import React, { useState, useId } from 'react';
import {
  X,
  Layers,
  FolderPlus,
  FileCode,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Terminal,
} from 'lucide-react';
import { EmptyComposeStack } from '../types';

interface CreateStackModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (newStack: EmptyComposeStack) => void;
  defaultBaseDir?: string;
}

export const CreateStackModal: React.FC<CreateStackModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  defaultBaseDir = '/home/ubuntu/docker',
}) => {
  const stackNameInputId = useId();
  const baseDirInputId = useId();
  const [rawStackName, setRawStackName] = useState('');
  const [customBaseDir, setCustomBaseDir] = useState(defaultBaseDir);
  const [showAdvancedDir, setShowAdvancedDir] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  // Real-time sanitized slug
  const sanitizedSlug = rawStackName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '');

  const targetHostDir = `${customBaseDir.replace(/\/$/, '')}/${sanitizedSlug || 'your-stack-name'}`;
  const targetComposePath = `${targetHostDir}/docker-compose.yml`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sanitizedSlug || sanitizedSlug.length < 2) {
      setErrorMessage('Please enter a stack name with at least 2 alphanumeric characters.');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const response = await fetch('/api/stacks/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stackName: sanitizedSlug,
          baseDir: showAdvancedDir ? customBaseDir : undefined,
        }),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to provision stack directory');
      }

      onSuccess(data.stack);
      onClose();
      setRawStackName('');
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage((err as Error).message || 'An unexpected error occurred.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fadeIn">
      <div className="relative w-full max-w-lg overflow-hidden rounded-2xl bg-[#090d16] border border-cyan-500/30 shadow-[0_0_50px_rgba(6,182,212,0.15)] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-800 bg-[#0c1220]">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-cyan-950/80 border border-cyan-500/40 text-cyan-400 shadow-[0_0_15px_rgba(6,182,212,0.2)]">
              <FolderPlus className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold font-mono text-white tracking-tight flex items-center gap-2">
                <span>Create New Compose Stack</span>
                <span className="px-2 py-0.5 rounded text-[10px] uppercase font-mono tracking-wider bg-cyan-950/80 text-cyan-300 border border-cyan-500/40">
                  Provision
                </span>
              </h2>
              <p className="text-xs text-slate-400 font-mono mt-0.5">
                Provisions empty stack directory with baseline docker-compose.yml
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Form */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {errorMessage && (
            <div className="p-3 rounded-xl bg-red-950/40 border border-red-500/40 text-red-300 text-xs font-mono flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Stack Name Input */}
          <div className="space-y-1.5">
            <label htmlFor={stackNameInputId} className="block text-xs font-mono font-medium text-slate-300">
              Stack Project Name <span className="text-cyan-400">*</span>
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                <Layers className="w-4 h-4" />
              </div>
              <input
                id={stackNameInputId}
                type="text"
                autoFocus
                placeholder="e.g. observability, media-suite, home-hub"
                value={rawStackName}
                onChange={(e) => setRawStackName(e.target.value)}
                className="w-full pl-9 pr-3 py-2.5 bg-slate-900/90 border border-slate-700/80 rounded-xl text-sm font-mono text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition-all shadow-inner"
              />
            </div>
            {sanitizedSlug && (
              <div className="text-[11px] font-mono text-slate-400 flex items-center gap-1.5 mt-1">
                <span className="text-slate-500">Sanitized slug:</span>
                <span className="px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300 border border-slate-700">
                  {sanitizedSlug}
                </span>
              </div>
            )}
          </div>

          {/* Target Host Directory Preview */}
          <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-medium text-slate-400 flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5 text-cyan-400" />
                <span>Host Filesystem Target</span>
              </span>
              <button
                type="button"
                onClick={() => setShowAdvancedDir(!showAdvancedDir)}
                className="text-[11px] font-mono text-cyan-400 hover:text-cyan-300 transition-colors underline"
              >
                {showAdvancedDir ? 'Use Default Parent Dir' : 'Customize Parent Dir'}
              </button>
            </div>

            {showAdvancedDir && (
              <div className="pt-1">
                <label htmlFor={baseDirInputId} className="block text-[11px] font-mono text-slate-400 mb-1">
                  Parent Base Directory:
                </label>
                <input
                  id={baseDirInputId}
                  type="text"
                  value={customBaseDir}
                  onChange={(e) => setCustomBaseDir(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-400"
                />
              </div>
            )}

            <div className="text-xs font-mono text-slate-300 break-all bg-slate-900/80 p-2 rounded-lg border border-slate-800/80">
              <div className="text-slate-500 text-[10px] uppercase tracking-wider mb-0.5">Directory Path:</div>
              <div className="text-cyan-300">{targetHostDir}</div>
              <div className="text-slate-500 text-[10px] uppercase tracking-wider mt-1.5 mb-0.5">Generated File:</div>
              <div className="text-emerald-400">{targetComposePath}</div>
            </div>
          </div>

          {/* Baseline Template Preview */}
          <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 space-y-1.5">
            <span className="text-xs font-mono font-medium text-slate-400 flex items-center gap-1.5">
              <FileCode className="w-3.5 h-3.5 text-purple-400" />
              <span>Initial Compose Template (Baseline)</span>
            </span>
            <pre className="text-[11px] font-mono bg-slate-900 p-2.5 rounded-lg border border-slate-800 text-purple-300 leading-relaxed overflow-x-auto">
{`services: {}`}
            </pre>
            <p className="text-[11px] font-mono text-slate-400">
              Once provisioned, you can merge existing standalone containers into this stack or edit it at any time.
            </p>
          </div>

          {/* Buttons */}
          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-800">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 rounded-xl text-xs font-mono text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !sanitizedSlug}
              className="px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-mono font-bold text-slate-950 transition-all flex items-center gap-2 shadow-[0_0_20px_rgba(6,182,212,0.3)] cursor-pointer"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-slate-950" />
                  <span>Provisioning Stack...</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  <span>Provision Empty Stack</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
