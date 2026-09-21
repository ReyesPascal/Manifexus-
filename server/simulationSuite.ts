import { mergeComposeWithAst, isManifexusContainer } from './stackService';
import {
  createPreMergeSnapshot,
  getMergeHistory,
  getHistoryRecordById,
  finalizeMergeRecord,
  markMergeAsReverted,
} from './historyService';
import { parseDocument } from 'yaml';
import fs from 'fs';
import path from 'path';

async function runSimulations() {
  console.log('=== STARTING DIRECTIVE 8 SIMULATION SUITE ===\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, desc: string) {
    if (condition) {
      console.log(`[PASS] ${desc}`);
      passed++;
    } else {
      console.error(`[FAIL] ${desc}`);
      failed++;
    }
  }

  // 1. Test AST Mutation & Comment Preservation
  console.log('\n--- SIMULATION 1: AST YAML Parsing & Comment Preservation ---');
  const baseYamlWithComments = `# Critical Production Stack
# Maintainer: sysadmin@homelab.local
version: '3.8'

services:
  # Primary Web Proxy
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    restart: always

networks:
  # Shared homelab frontend
  proxy_net:
    external: true
`;

  const newServices = {
    vaultwarden: {
      image: 'vaultwarden/server:latest',
      ports: ['8080:80'],
      environment: ['WEBSOCKET_ENABLED=true'],
    },
  };

  const mergedResult = mergeComposeWithAst(baseYamlWithComments, newServices);

  assert(mergedResult.includes('# Critical Production Stack'), 'Preserves top-level header comments');
  assert(mergedResult.includes('# Primary Web Proxy'), 'Preserves service-level inline comments');
  assert(mergedResult.includes('# Shared homelab frontend'), 'Preserves network-level comments');
  assert(mergedResult.includes('vaultwarden:'), 'Injects incoming service node');
  assert(mergedResult.includes('nginx:'), 'Retains existing service node');
  assert(mergedResult.includes('proxy_net:'), 'Retains existing networks definition');

  // Verify resulting document is valid YAML
  const doc = parseDocument(mergedResult);
  assert(doc.errors.length === 0, 'AST mutated document has 0 syntax errors');

  // 2. Test Directive 1: Manifexus Self-Protection Filter
  console.log('\n--- SIMULATION 2: Directive 1 Manifexus Self-Protection Filter ---');
  const testContainers = [
    { cleanName: 'manifexus', image: 'ghcr.io/reyespascal/manifexus:latest', compose: { project: 'manifexus' } },
    { cleanName: '/manifexus', image: 'manifexus:latest', compose: { project: 'default' } },
    { cleanName: 'pihole', image: 'pihole/pihole:latest', compose: { project: 'utilities-stack' } },
    { cleanName: 'vaultwarden', image: 'vaultwarden/server', compose: { project: 'vault' } },
  ];

  const filtered = testContainers.filter((c) => !isManifexusContainer(c as any));
  assert(filtered.length === 2, 'Filtered out all Manifexus containers');
  assert(!filtered.some((c) => c.cleanName.includes('manifexus')), 'No Manifexus container remains in merge fleet');

  // 3. Test Directive 6: Pre-merge Backups & State Ledger
  console.log('\n--- SIMULATION 3: State Ledger & Snapshot Archive ---');
  const tempTargetDir = path.join('/tmp', 'sim-target-stack-' + Date.now());
  fs.mkdirSync(tempTargetDir, { recursive: true });
  const preMergeContent = 'services:\n  dummy:\n    image: alpine\n';
  fs.writeFileSync(path.join(tempTargetDir, 'docker-compose.yml'), preMergeContent);

  const testMergeId = 'sim_merge_' + Date.now();
  const snapshotResult = await createPreMergeSnapshot({
    mergeId: testMergeId,
    targetStackName: 'sim-target-stack',
    targetDirectory: tempTargetDir,
    selectedContainers: [
      {
        id: 'test-src-1',
        cleanName: 'src-service',
        name: '/src-service',
        image: 'nginx:latest',
        state: 'running',
        status: 'Up 1 hour',
        ports: [],
        mounts: [],
        networks: [],
        compose: { isCompose: true, project: 'source-stack', service: 'src-service', workingDir: tempTargetDir },
        created: Date.now(),
      } as any,
    ],
    preMergeTargetCompose: preMergeContent,
  });

  assert(Boolean(snapshotResult.record.id), 'Generated unique Merge Record ID');
  assert(snapshotResult.record.status === 'pending_decision', 'Initial status is pending_decision');
  assert(fs.existsSync(snapshotResult.backupArchiveDir), 'Dedicated backup archive directory created');

  const history = getMergeHistory();
  assert(history.some((h) => h.id === testMergeId), 'Snapshot record found in state ledger');

  // 4. Test Directive 4: Post-Merge Keep vs Revert Decision
  console.log('\n--- SIMULATION 4: Post-Merge Finalization & Revert Mark ---');
  finalizeMergeRecord(testMergeId);
  const activeRecord = getHistoryRecordById(testMergeId);
  assert(activeRecord?.status === 'active', 'Marked record status as active upon "Keep Changes"');

  markMergeAsReverted(testMergeId, ['Simulated revert executed successfully']);
  const revertedRecord = getHistoryRecordById(testMergeId);
  assert(revertedRecord?.status === 'reverted', 'Marked record status as reverted upon "Revert"');
  assert((revertedRecord?.logs?.length ?? 0) > 0, 'Audit logs attached to reverted record in ledger');

  // Clean up temp dir
  fs.rmSync(tempTargetDir, { recursive: true, force: true });

  console.log(`\n=== SIMULATION SUMMARY: ${passed} PASSED, ${failed} FAILED ===\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runSimulations().catch((err) => {
  console.error('Simulation crashed:', err);
  process.exit(1);
});
