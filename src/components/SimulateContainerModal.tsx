import React, { useState } from 'react';
import { X, PlusCircle, Layers, Server } from 'lucide-react';

interface SimulateContainerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSimulate: (data: {
    name: string;
    image: string;
    port: number;
    composeProject?: string;
    serviceName?: string;
  }) => Promise<void>;
}

const TEMPLATES = [
  { name: 'grafana', image: 'grafana/grafana:latest', port: 3000, composeProject: 'observability-stack' },
  { name: 'traefik', image: 'traefik:v3.0', port: 8080, composeProject: 'reverse-proxy' },
  { name: 'immich-server', image: 'ghcr.io/immich-app/immich-server:release', port: 2283, composeProject: 'media-stack' },
  { name: 'mealie', image: 'ghcr.io/mealie-recipes/mealie:latest', port: 9925, composeProject: 'home-suite' },
  { name: 'adguard-home', image: 'adguard/adguardhome:latest', port: 3005, composeProject: 'network-core' },
];

export const SimulateContainerModal: React.FC<SimulateContainerModalProps> = ({
  isOpen,
  onClose,
  onSimulate,
}) => {
  if (!isOpen) return null;

  const [name, setName] = useState('');
  const [image, setImage] = useState('');
  const [port, setPort] = useState<number>(8080);
  const [composeProject, setComposeProject] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleApplyTemplate = (tpl: typeof TEMPLATES[0]) => {
    setName(tpl.name);
    setImage(tpl.image);
    setPort(tpl.port);
    setComposeProject(tpl.composeProject);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setIsSubmitting(true);
    try {
      await onSimulate({
        name: name.trim(),
        image: image.trim() || `${name.trim()}:latest`,
        port: Number(port) || 8080,
        composeProject: composeProject.trim() || undefined,
        serviceName: name.trim(),
      });
      onClose();
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
            <PlusCircle className="w-5 h-5 text-cyan-400" />
            <h2 className="text-base font-bold text-white">Simulate Container Event</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-xs">
          <p className="text-slate-400">
            Trigger an instantaneous container launch event to test auto-discovery, port mappings, and compose stack grouping in real time.
          </p>

          {/* Quick templates */}
          <div className="space-y-1.5">
            <span className="text-[11px] text-slate-400">Quick Self-Hosted Templates:</span>
            <div className="flex flex-wrap gap-1.5">
              {TEMPLATES.map((tpl) => (
                <button
                  key={tpl.name}
                  type="button"
                  onClick={() => handleApplyTemplate(tpl)}
                  className="px-2 py-1 rounded-md bg-slate-900 hover:bg-cyan-950/60 border border-slate-800 hover:border-cyan-500/40 text-slate-300 text-[11px] transition-colors"
                >
                  +{tpl.name} (:{tpl.port})
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-slate-300 font-bold mb-1">Container Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. grafana"
              required
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-300 font-bold mb-1">Image Tag</label>
              <input
                type="text"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="grafana/grafana:latest"
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
              />
            </div>

            <div>
              <label className="block text-slate-300 font-bold mb-1">Exposed Port</label>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                placeholder="3000"
                required
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
              />
            </div>
          </div>

          <div>
            <label className="block text-slate-300 font-bold mb-1">
              Docker Compose Project (Optional)
            </label>
            <input
              type="text"
              value={composeProject}
              onChange={(e) => setComposeProject(e.target.value)}
              placeholder="e.g. media-stack, observability, home-suite"
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
            />
            <span className="text-[10px] text-slate-500">
              Leave empty to simulate a standalone `docker run` container.
            </span>
          </div>

          <div className="pt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !name.trim()}
              className="px-4 py-2 rounded-xl bg-cyan-500 text-slate-950 font-bold hover:bg-cyan-400 transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              <PlusCircle className="w-4 h-4" />
              <span>{isSubmitting ? 'Spawning...' : 'Spawn Container'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
