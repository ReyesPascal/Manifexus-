import yaml from 'yaml';
import { isHostPortFree } from './hostFsService';

export interface ExtractedPort {
  service: string;
  hostPort?: number;
  containerPort: number;
  protocol: 'tcp' | 'udp';
  hostIp?: string;
  originalRaw?: string | number | Record<string, unknown>;
  portIndex?: number;
}

export interface RemappedPort {
  service: string;
  originalHostPort: number;
  allocatedHostPort: number;
  containerPort: number;
  protocol: 'tcp' | 'udp';
  hostIp?: string;
  reason: string;
}

export interface PortCollisionResult {
  hasCollisions: boolean;
  remappedPorts: RemappedPort[];
  resolvedYaml: string;
  extractedPorts: ExtractedPort[];
  allAllocatedHostPorts: number[];
}

export class PortCollisionResultObject implements PortCollisionResult, PromiseLike<string> {
  hasCollisions: boolean;
  remappedPorts: RemappedPort[];
  resolvedYaml: string;
  extractedPorts: ExtractedPort[];
  allAllocatedHostPorts: number[];

  constructor(data: PortCollisionResult) {
    this.hasCollisions = data.hasCollisions;
    this.remappedPorts = data.remappedPorts;
    this.resolvedYaml = data.resolvedYaml;
    this.extractedPorts = data.extractedPorts;
    this.allAllocatedHostPorts = data.allAllocatedHostPorts;
  }

  toString(): string {
    return this.resolvedYaml;
  }

  then<TResult1 = string, TResult2 = never>(
    onfulfilled?: ((value: string) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.resolvedYaml).then(onfulfilled, onrejected);
  }
}

/**
 * Extracts structured port definitions from a Compose YAML string.
 */
export function extractPortsFromCompose(composeYaml: string): ExtractedPort[] {
  const extracted: ExtractedPort[] = [];
  try {
    const doc = yaml.parse(composeYaml);
    if (!doc || !doc.services || typeof doc.services !== 'object') {
      return extracted;
    }

    for (const [serviceName, serviceDef] of Object.entries(doc.services)) {
      if (!serviceDef || typeof serviceDef !== 'object') continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = serviceDef as any;
      if (!Array.isArray(svc.ports)) continue;

      for (let i = 0; i < svc.ports.length; i++) {
        const portItem = svc.ports[i];
        if (typeof portItem === 'string' || typeof portItem === 'number') {
          const str = String(portItem).trim();
          let protocol: 'tcp' | 'udp' = 'tcp';
          let body = str;
          if (str.includes('/')) {
            const [pBody, proto] = str.split('/');
            body = pBody;
            if (proto.toLowerCase() === 'udp') protocol = 'udp';
          }

          const parts = body.split(':');
          if (parts.length === 1) {
            // Container port only, e.g. "80"
            const cp = parseInt(parts[0], 10);
            if (!isNaN(cp)) {
              extracted.push({
                service: serviceName,
                containerPort: cp,
                protocol,
                originalRaw: portItem,
                portIndex: i,
              });
            }
          } else if (parts.length === 2) {
            // host:container, e.g. "8080:80" or "8080-8082:80-82"
            const hostPart = parts[0];
            const contPart = parts[1];
            const hostMatch = hostPart.match(/^(\d+)(?:-(\d+))?/);
            const contMatch = contPart.match(/^(\d+)(?:-(\d+))?/);
            if (hostMatch && contMatch) {
              const hStart = parseInt(hostMatch[1], 10);
              const hEnd = hostMatch[2] ? parseInt(hostMatch[2], 10) : hStart;
              const cStart = parseInt(contMatch[1], 10);
              const count = hEnd - hStart;
              for (let offset = 0; offset <= count; offset++) {
                extracted.push({
                  service: serviceName,
                  hostPort: hStart + offset,
                  containerPort: cStart + offset,
                  protocol,
                  originalRaw: portItem,
                  portIndex: i,
                });
              }
            }
          } else if (parts.length >= 3) {
            // ip:host:container, e.g. "127.0.0.1:8080:80"
            const hostIp = parts[0];
            const hostPart = parts[1];
            const contPart = parts[2];
            const hostMatch = hostPart.match(/^(\d+)(?:-(\d+))?/);
            const contMatch = contPart.match(/^(\d+)(?:-(\d+))?/);
            if (hostMatch && contMatch) {
              const hStart = parseInt(hostMatch[1], 10);
              const hEnd = hostMatch[2] ? parseInt(hostMatch[2], 10) : hStart;
              const cStart = parseInt(contMatch[1], 10);
              const count = hEnd - hStart;
              for (let offset = 0; offset <= count; offset++) {
                extracted.push({
                  service: serviceName,
                  hostIp,
                  hostPort: hStart + offset,
                  containerPort: cStart + offset,
                  protocol,
                  originalRaw: portItem,
                  portIndex: i,
                });
              }
            }
          }
        } else if (typeof portItem === 'object' && portItem !== null) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pObj = portItem as any;
          const containerPort = typeof pObj.target === 'number' ? pObj.target : parseInt(pObj.target, 10);
          const hostPort = pObj.published ? parseInt(String(pObj.published), 10) : undefined;
          const protocol = pObj.protocol?.toLowerCase() === 'udp' ? 'udp' : 'tcp';
          const hostIp = pObj.host_ip ? String(pObj.host_ip) : undefined;
          if (!isNaN(containerPort)) {
            extracted.push({
              service: serviceName,
              hostPort: typeof hostPort === 'number' && !isNaN(hostPort) ? hostPort : undefined,
              containerPort,
              protocol,
              hostIp,
              originalRaw: portItem,
              portIndex: i,
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn('[PortCollisionService] Error extracting ports from compose:', err);
  }
  return extracted;
}

/**
 * Extracts all published host ports from a Compose YAML string.
 */
export function extractPublishedPorts(composeYaml: string): number[] {
  const ports: number[] = [];
  try {
    const extracted = extractPortsFromCompose(composeYaml);
    for (const ep of extracted) {
      if (ep.hostPort && !ports.includes(ep.hostPort)) {
        ports.push(ep.hostPort);
      }
    }
  } catch (err) {
    console.warn('[PortCollisionService] Error extracting ports:', err);
  }
  return ports;
}

/**
 * Directive 1: Immutable Existing Stacks & Collision Resolution
 * Resolves port collisions strictly on the INCOMING Compose YAML.
 * The existing YAML is only parsed to reserve its ports, ensuring it is never mutated.
 * Supports both Set/array of occupied ports and existing stack YAML string.
 */
export function resolvePortCollisions(
  incomingYaml: string,
  occupiedPorts?: Set<number> | number[],
  log?: (msg: string) => void
): PortCollisionResult;
export function resolvePortCollisions(
  incomingYaml: string,
  existingYaml?: string,
  log?: (msg: string) => void
): Promise<string> & PortCollisionResult;
export function resolvePortCollisions(
  incomingYaml: string,
  occupiedOrExisting?: Set<number> | number[] | string,
  existingYamlOrLog?: string | ((msg: string) => void),
  logFn?: (msg: string) => void
): PortCollisionResultObject {
  const log = typeof existingYamlOrLog === 'function' ? existingYamlOrLog : logFn;
  const reservedPorts = new Set<number>();

  if (occupiedOrExisting instanceof Set) {
    for (const p of occupiedOrExisting) reservedPorts.add(p);
  } else if (Array.isArray(occupiedOrExisting)) {
    for (const p of occupiedOrExisting) reservedPorts.add(p);
  } else if (typeof occupiedOrExisting === 'string' && occupiedOrExisting.trim().length > 0) {
    const existingPorts = extractPublishedPorts(occupiedOrExisting);
    existingPorts.forEach((p) => reservedPorts.add(p));
  }

  if (typeof existingYamlOrLog === 'string' && existingYamlOrLog.trim().length > 0) {
    const existingPorts = extractPublishedPorts(existingYamlOrLog);
    existingPorts.forEach((p) => reservedPorts.add(p));
  }

  const extractedPorts = extractPortsFromCompose(incomingYaml);
  const remappedPorts: RemappedPort[] = [];
  const allAllocatedHostPorts: number[] = [];

  // Parse incoming YAML AST for mutation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let doc: any;
  try {
    doc = yaml.parseDocument(incomingYaml);
    if (!doc || !doc.has || !doc.has('services')) {
      return new PortCollisionResultObject({
        hasCollisions: false,
        remappedPorts: [],
        resolvedYaml: incomingYaml,
        extractedPorts,
        allAllocatedHostPorts: [],
      });
    }
  } catch {
    return new PortCollisionResultObject({
      hasCollisions: false,
      remappedPorts: [],
      resolvedYaml: incomingYaml,
      extractedPorts,
      allAllocatedHostPorts: [],
    });
  }

  const servicesNode = doc.get('services');
  if (!servicesNode || typeof servicesNode.items === 'undefined') {
    return new PortCollisionResultObject({
      hasCollisions: false,
      remappedPorts: [],
      resolvedYaml: incomingYaml,
      extractedPorts,
      allAllocatedHostPorts: [],
    });
  }

  let hasMutated = false;

  for (const servicePair of servicesNode.items) {
    const svcName = servicePair.key?.value || String(servicePair.key);
    const svcNode = servicePair.value;

    if (!svcNode || !svcNode.has || !svcNode.has('ports')) continue;

    const portsSeq = svcNode.get('ports');
    if (!portsSeq || !portsSeq.items) continue;

    for (let i = 0; i < portsSeq.items.length; i++) {
      const portNode = portsSeq.items[i];
      let portString = portNode?.value ?? String(portNode);

      if (typeof portString !== 'string' && typeof portString !== 'number') continue;
      portString = String(portString);

      const parts = portString.split(':');
      let hostPortIndex = 0;
      if (parts.length >= 3) {
        hostPortIndex = 1; // IP:HOST:CONTAINER
      } else if (parts.length === 2) {
        hostPortIndex = 0; // HOST:CONTAINER
      } else {
        // Container-only port
        continue;
      }

      const hostPortMatch = parts[hostPortIndex].match(/^(\d+)(?:-(\d+))?/);
      if (!hostPortMatch) continue;

      const originalHostPort = parseInt(hostPortMatch[1], 10);
      const currentHostPort = originalHostPort;

      const contPart = parts[parts.length - 1];
      const contMatch = contPart.match(/^(\d+)/);
      const containerPort = contMatch ? parseInt(contMatch[1], 10) : originalHostPort;
      const protocol: 'tcp' | 'udp' = portString.toLowerCase().includes('/udp') ? 'udp' : 'tcp';
      const hostIp = parts.length >= 3 ? parts[0] : undefined;

      if (reservedPorts.has(currentHostPort)) {
        if (log) {
          log(`Port Collision Detected: Port ${currentHostPort} for service "${svcName}" is already in use.`);
        }

        let nextPort = Math.max(8000, currentHostPort + 1);
        while (reservedPorts.has(nextPort)) {
          nextPort++;
        }

        if (log) {
          log(`Mutating service "${svcName}" port: ${currentHostPort} -> ${nextPort}`);
        }

        parts[hostPortIndex] = parts[hostPortIndex].replace(originalHostPort.toString(), nextPort.toString());
        const newPortString = parts.join(':');
        if (typeof portNode === 'object' && portNode !== null && 'value' in portNode) {
          portNode.value = newPortString;
        } else {
          portsSeq.items[i] = newPortString;
        }

        remappedPorts.push({
          service: svcName,
          originalHostPort,
          allocatedHostPort: nextPort,
          containerPort,
          protocol,
          hostIp,
          reason: `Host port ${originalHostPort} occupied by existing stack or bound system port`,
        });

        reservedPorts.add(nextPort);
        allAllocatedHostPorts.push(nextPort);
        hasMutated = true;
      } else {
        reservedPorts.add(currentHostPort);
        allAllocatedHostPorts.push(currentHostPort);
      }
    }
  }

  const resolvedYaml = hasMutated ? doc.toString() : incomingYaml;

  return new PortCollisionResultObject({
    hasCollisions: remappedPorts.length > 0,
    remappedPorts,
    resolvedYaml,
    extractedPorts,
    allAllocatedHostPorts,
  });
}
