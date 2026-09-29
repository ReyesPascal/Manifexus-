import React, { useMemo } from 'react';
import { DeepContainerMetadata } from '../types';
import { AppIcon } from './AppCard';
import { AppTile, Group, Row, SectionFooter, SectionHeader, Sheet, ios } from './ui/ios';

interface PortsSheetProps {
  open: boolean;
  onClose: () => void;
  /** Apps as shown on the dashboard, plus Manifexus itself (its port is in use too) */
  containers: DeepContainerMetadata[];
  hostAddress: string;
}

interface PortEntry {
  hostPort: number;
  containerPort: number;
  protocols: Set<string>;
  app: DeepContainerMetadata;
  role?: string;
  label?: string;
  localOnly: boolean;
}

const appName = (a: DeepContainerMetadata) => (a.customName || a.friendlyName || a.cleanName || '').replace(/^\//, '');

const ROLE_TEXT: Record<string, string> = {
  p2p: 'Peer traffic',
  dns: 'DNS',
  database: 'Database',
};

/** One row per host port + app, with TCP/UDP merged and IPv4/IPv6 duplicates folded together. */
function collect(apps: DeepContainerMetadata[]): PortEntry[] {
  const map = new Map<string, PortEntry>();
  for (const app of apps) {
    for (const p of app.ports || []) {
      if (!p.publicPort) continue;
      const key = `${app.id}:${p.publicPort}`;
      const localOnly = Boolean(p.ip && (p.ip.startsWith('127.') || p.ip === '::1'));
      const existing = map.get(key);
      if (existing) {
        existing.protocols.add(p.type.toUpperCase());
        if (!existing.label && p.label) existing.label = p.label;
        existing.localOnly = existing.localOnly && localOnly;
      } else {
        map.set(key, {
          hostPort: p.publicPort,
          containerPort: p.privatePort,
          protocols: new Set([p.type.toUpperCase()]),
          app,
          role: p.suggestedRole,
          label: p.label,
          localOnly,
        });
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => a.hostPort - b.hostPort);
}

const ExternalGlyph: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
);

/**
 * Ports screen: which host ports are taken and by what, which ones open a web page,
 * what stopped apps have reserved, and which apps only listen inside Docker.
 */
export const PortsSheet: React.FC<PortsSheetProps> = ({ open, onClose, containers, hostAddress }) => {
  const running = useMemo(() => containers.filter((c) => c.state === 'running'), [containers]);
  const stopped = useMemo(() => containers.filter((c) => c.state !== 'running'), [containers]);

  const inUse = useMemo(() => collect(running), [running]);
  const isSelf = (a: DeepContainerMetadata) => /manifexus/i.test(`${a.cleanName} ${a.image}`);
  const web = inUse.filter((e) => (e.role === 'web' || isSelf(e.app)) && e.protocols.has('TCP'));
  const other = inUse.filter((e) => !web.includes(e));
  const reserved = useMemo(() => collect(stopped), [stopped]);

  // Apps listening only inside Docker (no host port at all)
  const internalOnly = useMemo(
    () =>
      running
        .filter((a) => (a.ports || []).length > 0 && !(a.ports || []).some((p) => p.publicPort))
        .map((a) => ({
          app: a,
          ports: Array.from(new Set((a.ports || []).map((p) => `${p.privatePort}/${p.type}`))),
        })),
    [running]
  );

  const uniquePorts = new Set(inUse.map((e) => e.hostPort)).size;
  const host = hostAddress || 'localhost';
  const urlFor = (port: number, containerPort: number) =>
    `${containerPort === 443 || port === 443 || port === 8443 || port === 9443 ? 'https' : 'http'}://${host}:${port}`;

  const protocolText = (e: PortEntry) => Array.from(e.protocols).sort().join(' + ');
  /** Web rows only say something when it's useful: a different container port, or local-only */
  const describeWeb = (e: PortEntry) => {
    const parts: string[] = [];
    if (e.containerPort !== e.hostPort) parts.push(`Container port ${e.containerPort}`);
    if (e.localOnly) parts.push('Only reachable from this server');
    return parts.length ? parts.join(' · ') : undefined;
  };
  const describe = (e: PortEntry) => {
    const parts: string[] = [];
    parts.push(e.containerPort === e.hostPort ? protocolText(e) : `${protocolText(e)} · container port ${e.containerPort}`);
    const roleText = e.role && ROLE_TEXT[e.role];
    if (roleText) parts.unshift(roleText);
    else if (e.label && e.role !== 'web' && e.label !== 'High Service Port' && e.label !== 'HTTP / TCP') parts.unshift(e.label);
    if (e.localOnly) parts.push('only reachable from this server');
    return parts.join(' · ');
  };

  const portText = (n: number) => <span className="font-mono text-[15px] tabular-nums" style={{ color: ios.label }}>{n}</span>;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Ports"
      subtitle={`${uniquePorts} ${uniquePorts === 1 ? 'port' : 'ports'} in use on ${host}`}
    >
      <div className="space-y-7">
        {web.length > 0 && (
          <section>
            <SectionHeader>Web Pages</SectionHeader>
            <Group className="ios-inset-icon">
              {web.map((e) => (
                <Row
                  key={`${e.app.id}-${e.hostPort}`}
                  onClick={() => window.open(urlFor(e.hostPort, e.containerPort), '_blank', 'noopener')}
                  leading={<AppIcon container={e.app} size={29} />}
                  title={appName(e.app)}
                  subtitle={describeWeb(e)}
                  trailing={
                    <>
                      {portText(e.hostPort)}
                      <span style={{ color: ios.blue }}>
                        <ExternalGlyph />
                      </span>
                    </>
                  }
                />
              ))}
            </Group>
            <SectionFooter>Opens {host}:port in a new tab. Change the address in Settings.</SectionFooter>
          </section>
        )}

        {other.length > 0 && (
          <section>
            <SectionHeader>Other Ports</SectionHeader>
            <Group className="ios-inset-icon">
              {other.map((e) => (
                <Row
                  key={`${e.app.id}-${e.hostPort}`}
                  leading={<AppIcon container={e.app} size={29} />}
                  title={appName(e.app)}
                  subtitle={describe(e)}
                  trailing={portText(e.hostPort)}
                />
              ))}
            </Group>
          </section>
        )}

        {inUse.length === 0 && (
          <p className="text-[15px] text-center py-10" style={{ color: ios.secondary }}>
            No running app publishes a port on this server.
          </p>
        )}

        {reserved.length > 0 && (
          <section>
            <SectionHeader>Reserved by Stopped Apps</SectionHeader>
            <Group className="ios-inset-icon">
              {reserved.map((e) => (
                <Row
                  key={`${e.app.id}-${e.hostPort}`}
                  leading={<AppIcon container={e.app} size={29} />}
                  title={appName(e.app)}
                  subtitle={describe(e)}
                  trailing={<span className="font-mono text-[15px] tabular-nums" style={{ color: ios.tertiary }}>{e.hostPort}</span>}
                />
              ))}
            </Group>
            <SectionFooter>These apps take these ports again when they start. Another app using one of them will stop them from starting.</SectionFooter>
          </section>
        )}

        {internalOnly.length > 0 && (
          <section>
            <SectionHeader>Inside Docker Only</SectionHeader>
            <Group className="ios-inset-icon">
              {internalOnly.map(({ app, ports }) => (
                <Row
                  key={app.id}
                  leading={<AppIcon container={app} size={29} />}
                  title={appName(app)}
                  trailing={<span className="font-mono text-[13px]">{ports.join(', ')}</span>}
                />
              ))}
            </Group>
            <SectionFooter>Not published on the server. Only other apps on the same Docker network can reach them.</SectionFooter>
          </section>
        )}
      </div>
    </Sheet>
  );
};
