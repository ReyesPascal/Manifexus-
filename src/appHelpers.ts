import { DeepContainerMetadata } from './types';

/**
 * Some containers only exist to serve another app in the same stack: Nextcloud's database, Immich's
 * Redis. They aren't apps people open, so the dashboard shows them inside the app they belong to
 * (on its card and in its Details) instead of as cards of their own.
 *
 * A container belongs to an app when, in the same stack, the app depends on it (Compose's
 * depends_on) and it has no web page of its own; or when it's a database/cache kind of image and
 * the stack has exactly one other app it could belong to.
 */

const HELPER_IMAGE = /(^|\/)(mariadb|mysql|postgres(ql)?|postgis|pgvecto-rs|timescaledb|redis|valkey|keydb|dragonfly|mongo(db)?|memcached|elasticsearch|opensearch|clamav|rabbitmq|influxdb|cassandra|etcd|minio|couchdb|nats|mosquitto)([:@-]|$)/i;

const service = (c: DeepContainerMetadata) => (c.compose?.service || c.cleanName).toLowerCase();

/** The services this container depends on, from Compose's label ("db:service_started:false,redis:…") */
function dependsOn(c: DeepContainerMetadata): string[] {
  const raw = c.labels?.['com.docker.compose.depends_on'] || '';
  return raw
    .split(',')
    .map((s) => s.split(':')[0].trim().toLowerCase())
    .filter(Boolean);
}

const noWebPage = (c: DeepContainerMetadata) => !c.webPort && !c.customUrl;
export const isHelperKind = (c: DeepContainerMetadata) => HELPER_IMAGE.test((c.image || '').split('@')[0]);

/** For each helper container, the id of the app it belongs to */
export function helperParents(apps: DeepContainerMetadata[]): Map<string, string> {
  const parent = new Map<string, string>();
  const byStack = new Map<string, DeepContainerMetadata[]>();
  for (const c of apps) {
    const p = c.compose?.isCompose && c.compose.project;
    if (!p) continue;
    if (!byStack.has(p)) byStack.set(p, []);
    byStack.get(p)!.push(c);
  }
  for (const list of byStack.values()) {
    if (list.length < 2) continue;
    const bySvc = new Map(list.map((c) => [service(c), c]));
    // 1. The app says it depends on it, and it has no web page of its own
    for (const app of list) {
      for (const dep of dependsOn(app)) {
        const h = bySvc.get(dep);
        if (!h || h.id === app.id || parent.has(h.id)) continue;
        if (noWebPage(h) && (isHelperKind(h) || !isHelperKind(app))) parent.set(h.id, app.id);
      }
    }
    // Something that is itself a helper can't own helpers: hand them to its own app
    for (const [h, p] of parent) if (parent.has(p)) parent.set(h, parent.get(p)!);
    // 2. A database or cache with exactly one app it could belong to
    const mains = list.filter((c) => !parent.has(c.id) && !(isHelperKind(c) && noWebPage(c)));
    if (mains.length === 1) {
      for (const h of list) if (h.id !== mains[0].id && !parent.has(h.id) && isHelperKind(h) && noWebPage(h)) parent.set(h.id, mains[0].id);
    }
  }
  return parent;
}

/** The helpers of each app, by app id */
export function helpersByApp(apps: DeepContainerMetadata[], parents: Map<string, string>): Map<string, DeepContainerMetadata[]> {
  const out = new Map<string, DeepContainerMetadata[]>();
  for (const c of apps) {
    const p = parents.get(c.id);
    if (!p) continue;
    if (!out.has(p)) out.set(p, []);
    out.get(p)!.push(c);
  }
  return out;
}

/** A short name for a helper: "db", "redis" */
export const helperName = (c: DeepContainerMetadata) => c.customName || c.compose?.service || c.friendlyName || c.cleanName;

/** What a helper is, in a word: Database, Cache, Search… */
export function helperKind(c: DeepContainerMetadata): string {
  const img = (c.image || '').toLowerCase();
  if (/(mariadb|mysql|postgres|postgis|pgvecto|timescaledb|mongo|cassandra|couchdb|influxdb)/.test(img)) return 'Database';
  if (/(redis|valkey|keydb|dragonfly|memcached)/.test(img)) return 'Cache';
  if (/(elasticsearch|opensearch)/.test(img)) return 'Search';
  if (/(rabbitmq|nats|mosquitto)/.test(img)) return 'Messaging';
  if (/clamav/.test(img)) return 'Virus Scanner';
  if (/minio/.test(img)) return 'Storage';
  return 'Service';
}

/** The product behind a helper, from its image: "MariaDB 11", "Redis" */
export function helperProduct(c: DeepContainerMetadata): string {
  const ref = (c.image || '').split('@')[0];
  const name = (ref.split('/').pop() || ref).split(':')[0];
  const tag = ref.includes(':') ? ref.split(':').pop() : '';
  const pretty: Record<string, string> = { mariadb: 'MariaDB', mysql: 'MySQL', postgres: 'PostgreSQL', postgresql: 'PostgreSQL', redis: 'Redis', valkey: 'Valkey', mongo: 'MongoDB', memcached: 'Memcached', elasticsearch: 'Elasticsearch', opensearch: 'OpenSearch', clamav: 'ClamAV', minio: 'MinIO', rabbitmq: 'RabbitMQ' };
  const label = pretty[name.toLowerCase()] || name;
  return tag && /^\d/.test(tag) ? `${label} ${tag.split('-')[0]}` : label;
}
