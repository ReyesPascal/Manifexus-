import yaml from 'yaml';

export interface ExtractedPort {
  service: string;
  hostPort?: number;
  containerPort: number;
  protocol: 'tcp' | 'udp';
  hostIp?: string;
  originalRaw: string | number | Record<string, unknown>;
  portIndex: number;
  isLongSyntax: boolean;
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

export interface PortResolutionResult {
  hasCollisions: boolean;
  remappedPorts: RemappedPort[];
  resolvedYaml: string;
  extractedPorts: ExtractedPort[];
  allAllocatedHostPorts: number[];
}

/**
 * Extracts host port mappings from a docker-compose.yml YAML string
 */
export function extractPortsFromCompose(composeYaml: string): ExtractedPort[] {
  const extracted: ExtractedPort[] = [];
  try {
    const doc = yaml.parse(composeYaml);
    if (!doc || typeof doc !== 'object' || !doc.services || typeof doc.services !== 'object') {
      return [];
    }

    for (const [serviceName, serviceConfig] of Object.entries(doc.services)) {
      if (!serviceConfig || typeof serviceConfig !== 'object') continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ports = (serviceConfig as any).ports;
      if (!Array.isArray(ports)) continue;

      ports.forEach((portEntry, portIndex) => {
        if (typeof portEntry === 'string' || typeof portEntry === 'number') {
          const parsed = parseShortSyntaxPort(String(portEntry));
          if (parsed) {
            extracted.push({
              service: serviceName,
              hostPort: parsed.hostPort,
              containerPort: parsed.containerPort,
              protocol: parsed.protocol,
              hostIp: parsed.hostIp,
              originalRaw: portEntry,
              portIndex,
              isLongSyntax: false,
            });
          }
        } else if (typeof portEntry === 'object' && portEntry !== null) {
          // Long syntax: { target: 80, published: 8080, protocol: 'tcp', mode: 'host' }
          const target = parseInt(String(portEntry.target), 10);
          const published = portEntry.published ? parseInt(String(portEntry.published), 10) : undefined;
          const protocol = (String(portEntry.protocol || 'tcp').toLowerCase() as 'tcp' | 'udp') || 'tcp';
          if (!isNaN(target)) {
            extracted.push({
              service: serviceName,
              hostPort: !isNaN(Number(published)) ? Number(published) : undefined,
              containerPort: target,
              protocol,
              originalRaw: portEntry,
              portIndex,
              isLongSyntax: true,
            });
          }
        }
      });
    }
  } catch (err) {
    console.warn('[PortCollisionService] Error parsing compose for ports:', err);
  }

  return extracted;
}

/**
 * Parses short docker-compose port string e.g. "8080:80", "127.0.0.1:8080:80/tcp", "80"
 */
function parseShortSyntaxPort(raw: string): {
  hostPort?: number;
  containerPort: number;
  protocol: 'tcp' | 'udp';
  hostIp?: string;
} | null {
  const clean = raw.trim();
  let protocol: 'tcp' | 'udp' = 'tcp';
  let portPart = clean;

  if (clean.includes('/')) {
    const [p, proto] = clean.split('/');
    portPart = p;
    protocol = proto.toLowerCase() === 'udp' ? 'udp' : 'tcp';
  }

  const parts = portPart.split(':');
  if (parts.length === 1) {
    // Just a container port "80"
    const cPort = parseInt(parts[0], 10);
    return isNaN(cPort) ? null : { containerPort: cPort, protocol };
  }

  if (parts.length === 2) {
    // "8080:80"
    const hPort = parseInt(parts[0], 10);
    const cPort = parseInt(parts[1], 10);
    if (isNaN(cPort)) return null;
    return {
      hostPort: isNaN(hPort) ? undefined : hPort,
      containerPort: cPort,
      protocol,
    };
  }

  if (parts.length === 3) {
    // "127.0.0.1:8080:80" or "0.0.0.0:8080:80"
    const ip = parts[0];
    const hPort = parseInt(parts[1], 10);
    const cPort = parseInt(parts[2], 10);
    if (isNaN(cPort)) return null;
    return {
      hostIp: ip,
      hostPort: isNaN(hPort) ? undefined : hPort,
      containerPort: cPort,
      protocol,
    };
  }

  return null;
}

/**
 * Directive 3: Intelligent Port Collision Engine
 * Cross-references required ports against occupied host ports and programmatically mutates the AST
 * to map any conflicting container to the next available incremented host port (e.g. 8080 -> 8081).
 */
export function resolvePortCollisions(
  composeYaml: string,
  occupiedPortsInput: Set<number> | number[]
): PortResolutionResult {
  const occupiedSet = new Set<number>(
    Array.isArray(occupiedPortsInput) ? occupiedPortsInput : Array.from(occupiedPortsInput)
  );

  const remappedPorts: RemappedPort[] = [];
  const allAllocatedHostPorts: number[] = [];

  let doc: yaml.Document;
  try {
    doc = yaml.parseDocument(composeYaml);
  } catch (err) {
    throw new Error(`Failed to parse Compose YAML AST for port resolution: ${(err as Error).message}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const servicesNode = doc.get('services') as any;
  if (!servicesNode || typeof servicesNode.items === 'undefined') {
    return {
      hasCollisions: false,
      remappedPorts: [],
      resolvedYaml: composeYaml,
      extractedPorts: [],
      allAllocatedHostPorts: [],
    };
  }

  const extractedPorts = extractPortsFromCompose(composeYaml);

  // Iterate over services in the AST Document
  for (const item of servicesNode.items) {
    const serviceName = String(item.key?.value || item.key);
    const serviceMap = item.value;
    if (!serviceMap || !serviceMap.get) continue;

    const portsSeq = serviceMap.get('ports');
    if (!portsSeq || !Array.isArray(portsSeq.items)) continue;

    portsSeq.items.forEach((portNode: any, idx: number) => {
      const matchingExtracted = extractedPorts.find(
        (p) => p.service === serviceName && p.portIndex === idx
      );

      if (!matchingExtracted || matchingExtracted.hostPort === undefined) {
        return;
      }

      const originalHostPort = matchingExtracted.hostPort;
      let targetHostPort = originalHostPort;
      let collisionDetected = false;

      // Check if original host port is occupied (either on host or by a previously resolved service in this compose)
      if (occupiedSet.has(targetHostPort)) {
        collisionDetected = true;
        // Increment until we find an unoccupied port
        while (occupiedSet.has(targetHostPort)) {
          targetHostPort++;
        }
      }

      // Mark this port as occupied for any subsequent services
      occupiedSet.add(targetHostPort);
      allAllocatedHostPorts.push(targetHostPort);

      if (collisionDetected) {
        remappedPorts.push({
          service: serviceName,
          originalHostPort,
          allocatedHostPort: targetHostPort,
          containerPort: matchingExtracted.containerPort,
          protocol: matchingExtracted.protocol,
          hostIp: matchingExtracted.hostIp,
          reason: `Host port ${originalHostPort} is currently occupied; auto-assigned next free port ${targetHostPort}`,
        });

        // Programmatically mutate the AST node
        if (matchingExtracted.isLongSyntax) {
          // Object node in yaml
          if (portNode && typeof portNode.set === 'function') {
            portNode.set('published', targetHostPort);
          } else if (typeof portNode === 'object' && portNode !== null) {
            portNode.published = targetHostPort;
          }
        } else {
          // Short string node
          let newPortStr = '';
          const protoSuffix = matchingExtracted.protocol === 'udp' ? '/udp' : '';
          if (matchingExtracted.hostIp) {
            newPortStr = `${matchingExtracted.hostIp}:${targetHostPort}:${matchingExtracted.containerPort}${protoSuffix}`;
          } else {
            newPortStr = `${targetHostPort}:${matchingExtracted.containerPort}${protoSuffix}`;
          }

          if (portNode && typeof portNode === 'object' && 'value' in portNode) {
            portNode.value = newPortStr;
          } else {
            portsSeq.items[idx] = newPortStr;
          }
        }
      }
    });
  }

  const resolvedYaml = doc.toString();

  return {
    hasCollisions: remappedPorts.length > 0,
    remappedPorts,
    resolvedYaml,
    extractedPorts,
    allAllocatedHostPorts,
  };
}
