import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { _resetDossierCache } from '@cat-cafe/shared/dossier';

const { createRoutingContextRuntime } = await import('../dist/domains/routing-context/RoutingContextRuntime.js');
const ownerId = 'issue-1438-owner';
const primaryCatId = 'issue-1438-primary';
const secondaryCatId = 'issue-1438-secondary';
const missingModelCatId = 'issue-1438-missing-model';
const member = (id, defaultModel = 'test-model') => ({
  id,
  name: id,
  displayName: id,
  avatar: 'test',
  color: { primary: '#000', secondary: '#fff' },
  mentionPatterns: [],
  mcpSupport: false,
  roleDescription: 'Local test member',
  personality: 'test',
  clientId: 'openai',
  defaultModel,
});
const configs = {
  [primaryCatId]: member(primaryCatId),
  [secondaryCatId]: member(secondaryCatId),
};
for (const [id, config] of Object.entries(configs)) catRegistry.register(id, config);
catRegistry.register(missingModelCatId, { ...member(missingModelCatId), defaultModel: undefined });

function fixture(t, { signals = [], preferences = [], members = configs } = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'routing-composition-1438-'));
  t.after(() => {
    _resetDossierCache();
    rmSync(projectRoot, { recursive: true, force: true });
  });
  const runtime = createRoutingContextRuntime({ redis: {}, projectRoot, getConfigs: () => members });
  // Keep the production catalog/resolver/profile/preflight wiring; isolate only storage I/O.
  t.mock.method(runtime.signalStore, 'getOwnerRevision', async () => signals.length);
  t.mock.method(runtime.signalStore, 'listByOwner', async () => signals);
  t.mock.method(runtime.preferenceStore, 'listByOwner', async () => preferences);
  return { runtime, projectRoot };
}

function writeDossier(projectRoot, content) {
  const directory = join(projectRoot, 'docs', 'team');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'cat-dossier.md');
  writeFileSync(path, content);
  return path;
}

function profile(catId) {
  return `# Local dossier\n\n\`\`\`yaml\n# structured-profile: cat:${catId}\nentityId: "cat:${catId}"\noneLiner: "Local member"\n\`\`\`\n`;
}

async function assertDegraded(runtime, reason, targetCatId = primaryCatId) {
  const read = await runtime.readService.read({ ownerId, observedAt: Date.now() });
  assert.equal(read.resolution.state, 'degraded');
  assert.equal(read.resolution.reason, reason);
  const decision = await runtime.dispatchPreflight.preflight({ ownerId, targetCatIds: [targetCatId] });
  assert.equal(decision.resolverState, 'degraded');
  assert.equal(decision.targets[0].disposition, 'warned');
  assert.equal(decision.targets[0].reasons[0].code, 'routing_context_unavailable');
  assert.deepEqual(decision.targets[0].reasons[0].sourceRefs, [`routing-context:resolver_degraded:${reason}`]);
}

describe('F293 routing context composition', () => {
  test('binds owner reads, writes and preflight to one resolver/store graph', async () => {
    const redis = {};
    const runtime = createRoutingContextRuntime({ redis, projectRoot: process.cwd(), getConfigs: () => ({}) });
    assert.equal(runtime.signalStore.redis, redis);
    assert.equal(runtime.preferenceStore.redis, redis);
    assert.equal(runtime.resolver.dependencies.signalStore, runtime.signalStore);
    assert.equal(runtime.resolver.dependencies.preferenceStore, runtime.preferenceStore);
    assert.equal(runtime.readService.dependencies.resolver, runtime.resolver);
    assert.equal(runtime.preflightService.resolver, runtime.resolver);
    assert.ok(runtime.promptProjector);
    assert.ok(runtime.promptProjection);
  });

  test('allows repeated sends with candidate-local absent profiles when the installation has no dossier', async (t) => {
    const { runtime } = fixture(t);
    const read = await runtime.readService.read({ ownerId, observedAt: Date.now() });
    assert.equal(read.resolution.state, 'fresh');
    assert.deepEqual(
      read.resolution.snapshot.candidates.map((candidate) => [candidate.binding.catId, candidate.profile]),
      [
        [primaryCatId, { state: 'absent' }],
        [secondaryCatId, { state: 'absent' }],
      ],
    );
    await assert.doesNotReject(runtime.promptProjection.resolve({ ownerId }));
    for (let send = 0; send < 2; send++) {
      const decision = await runtime.dispatchPreflight.preflight({ ownerId, targetCatIds: [primaryCatId] });
      assert.equal(decision.resolverState, 'fresh');
      assert.equal(decision.targets[0].disposition, 'allowed');
      assert.deepEqual(decision.targets[0].reasons, []);
    }
  });

  test('preserves owner routing preferences without requiring a dossier', async (t) => {
    const preference = {
      v: 1,
      ownerId,
      preferenceId: 'local-review-order',
      revisionId: 'local-review-order-v1',
      commandId: 'set-local-review-order',
      appliesWhen: { intent: 'review' },
      prefer: [{ type: 'cat', catId: secondaryCatId }],
      over: [{ type: 'cat', catId: primaryCatId }],
      rationale: 'Use the locally configured review order.',
      evidenceRefs: ['test:operator-preference'],
      version: 1,
      validFrom: 1,
      lifecycle: 'active',
    };
    const { runtime } = fixture(t, { preferences: [preference] });
    const read = await runtime.readService.read({ ownerId, observedAt: Date.now(), intent: 'review' });
    assert.equal(read.resolution.state, 'fresh');
    assert.deepEqual(
      read.resolution.snapshot.candidates.map((candidate) => candidate.binding.catId),
      [secondaryCatId, primaryCatId],
    );
    assert.deepEqual(read.resolution.snapshot.candidates[0].matchedPreferences, [
      { revisionId: preference.revisionId, lifecycle: 'active' },
    ]);
  });

  test('rejects a genuinely unavailable member even when the installation has no dossier', async (t) => {
    const now = Date.now();
    const signal = {
      v: 1,
      ownerId,
      eventId: 'local-member-unavailable',
      commandId: 'mark-local-member-unavailable',
      subjectRef: { type: 'cat', catId: primaryCatId },
      reasonCode: 'provider_unreachable',
      source: 'health_probe',
      observedAt: now,
      evidenceRef: 'test:health-probe',
      eventType: 'asserted',
      state: 'unavailable',
      validUntil: now + 60_000,
    };
    const { runtime } = fixture(t, { signals: [signal] });
    const decision = await runtime.dispatchPreflight.preflight({ ownerId, targetCatIds: [primaryCatId] });
    assert.equal(decision.resolverState, 'fresh');
    assert.equal(decision.targets[0].disposition, 'rejected');
    assert.ok(decision.targets[0].reasons.some((reason) => reason.code === 'routing_signal_unavailable'));
    assert.deepEqual(decision.targets[0].alternatives, [], 'members without applied profiles are not alternatives');
  });

  test('keeps an existing but unreadable dossier globally degraded', async (t) => {
    const { runtime, projectRoot } = fixture(t);
    // A directory at the file path produces a deterministic read failure even when tests run as root.
    mkdirSync(join(projectRoot, 'docs', 'team', 'cat-dossier.md'), { recursive: true });
    await assertDegraded(runtime, 'dossier_unreadable_or_empty');
  });

  test('keeps an existing but unparseable dossier globally degraded', async (t) => {
    const { runtime, projectRoot } = fixture(t);
    writeDossier(
      projectRoot,
      `\`\`\`yaml\n# structured-profile: cat:${primaryCatId}\nentityId: "unterminated\n\`\`\`\n`,
    );
    await assertDegraded(runtime, 'dossier_unreadable_or_empty');
  });

  test('keeps an applied profile with a missing model contract globally degraded', async (t) => {
    const { runtime, projectRoot } = fixture(t, {
      members: { [missingModelCatId]: catRegistry.getOrThrow(missingModelCatId).config },
    });
    writeDossier(projectRoot, profile(missingModelCatId));
    await assertDegraded(runtime, 'model_missing', missingModelCatId);
  });

  test('observes a locally created dossier after an initially absent profile without restarting', async (t) => {
    const { runtime, projectRoot } = fixture(t);
    const first = await runtime.readService.read({ ownerId, observedAt: Date.now() });
    assert.equal(first.resolution.state, 'fresh');
    assert.equal(first.resolution.snapshot.candidates[0].profile.state, 'absent');
    writeDossier(projectRoot, profile(primaryCatId));
    const second = await runtime.readService.read({ ownerId, observedAt: Date.now() });
    assert.equal(second.resolution.state, 'fresh');
    assert.equal(second.resolution.snapshot.candidates[0].profile.state, 'applied');
    assert.equal(second.resolution.snapshot.candidates[0].profile.revision.modelId, 'test-model');
    assert.equal(second.resolution.snapshot.candidates[1].profile.state, 'absent');
  });

  for (const [label, identity, closingFence] of [
    ['missing identity', '', '```'],
    ['malformed identity', 'entityId: "unterminated', '```'],
    ['mismatched identity', `entityId: "cat:${primaryCatId}"`, '```'],
    ['unclosed block', `entityId: "cat:${secondaryCatId}"`, ''],
  ]) {
    test(`diagnoses ${label} beside a valid peer without hiding unavailable signals`, async (t) => {
      const now = Date.now();
      const { runtime, projectRoot } = fixture(t, {
        signals: [
          {
            v: 1,
            ownerId,
            eventId: 'primary-down',
            commandId: 'mark-primary-down',
            subjectRef: { type: 'cat', catId: primaryCatId },
            reasonCode: 'provider_unreachable',
            source: 'health_probe',
            observedAt: now,
            evidenceRef: 'test:health',
            eventType: 'asserted',
            state: 'unavailable',
            validUntil: now + 60_000,
          },
        ],
      });
      const malformed = ['```yaml', `# structured-profile: cat:${secondaryCatId}`, identity, closingFence].join('\n');
      writeDossier(projectRoot, `${profile(primaryCatId)}\n${malformed}\n`);
      const read = await runtime.readService.read({ ownerId, observedAt: now });
      assert.equal(read.resolution.state, 'fresh');
      const primary = read.resolution.snapshot.candidates.find((cat) => cat.binding.catId === primaryCatId);
      const secondary = read.resolution.snapshot.candidates.find((cat) => cat.binding.catId === secondaryCatId);
      assert.equal(primary.profile.state, 'applied');
      const diagnostic = secondary.reasons.find((reason) => reason.code === 'capability_profile_invalid');
      assert.ok(diagnostic, 'marked malformed records must not silently become ordinary absence');
      assert.ok(diagnostic.sourceRefs.some((ref) => /docs\/team\/cat-dossier\.md#L\d+/.test(ref)));
      assert.equal(secondary.profile.state, 'absent');
      assert.equal(secondary.effect, 'eligible', 'availability effect retains its existing signal-only contract');
      assert.equal(secondary.availability, 'available', 'profile errors do not invent provider outages');
      const decision = await runtime.dispatchPreflight.preflight({
        ownerId,
        targetCatIds: [primaryCatId, secondaryCatId],
      });
      assert.equal(decision.resolverState, 'fresh');
      assert.equal(decision.targets[0].disposition, 'rejected');
      assert.deepEqual(decision.targets[0].alternatives, []);
      assert.equal(decision.targets[1].disposition, 'warned');
      assert.ok(decision.targets[1].reasons.some((reason) => reason.code === 'capability_profile_invalid'));
      assert.match(await runtime.promptProjection.resolve({ ownerId }), /capability_profile_invalid/);
    });
  }

  test('clears a removed malformed record diagnostic and refreshes its source revision', async (t) => {
    const { runtime, projectRoot } = fixture(t);
    writeDossier(
      projectRoot,
      `${profile(primaryCatId)}\n\`\`\`yaml\n# structured-profile: cat:${secondaryCatId}\n\`\`\`\n`,
    );
    const input = { ownerId, observedAt: 10_000 };
    const first = await runtime.readService.read(input);
    assert.equal(first.resolution.state, 'fresh');
    assert.ok(
      first.resolution.snapshot.candidates[1].reasons.some((reason) => reason.code === 'capability_profile_invalid'),
    );
    writeDossier(projectRoot, profile(primaryCatId));
    const second = await runtime.readService.read(input);
    assert.equal(second.resolution.state, 'fresh');
    assert.equal(second.resolution.snapshot.candidates[1].profile.state, 'absent');
    assert.deepEqual(second.resolution.snapshot.candidates[1].reasons, []);
    assert.notEqual(first.resolution.inputRevisionRef, second.resolution.inputRevisionRef);
    const decision = await runtime.dispatchPreflight.preflight({ ownerId, targetCatIds: [secondaryCatId] });
    assert.equal(decision.targets[0].disposition, 'allowed');
  });

  test('bounds repeated malformed-record diagnostics without degrading valid peers', async (t) => {
    const { runtime, projectRoot } = fixture(t);
    const badBlock = `\`\`\`yaml\n# structured-profile: cat:${secondaryCatId}\n\`\`\`\n`;
    writeDossier(projectRoot, profile(primaryCatId) + badBlock.repeat(40));
    const read = await runtime.readService.read({ ownerId, observedAt: Date.now() });
    assert.equal(read.resolution.state, 'fresh');
    assert.equal(read.resolution.snapshot.candidates[0].profile.state, 'applied');
    const reasons = read.resolution.snapshot.candidates[1].reasons;
    assert.equal(reasons.length, 1);
    assert.equal(reasons[0].code, 'capability_profile_invalid');
    assert.ok(reasons[0].sourceRefs.length > 0 && reasons[0].sourceRefs.length <= 32);
    const decision = await runtime.dispatchPreflight.preflight({
      ownerId,
      targetCatIds: [primaryCatId, secondaryCatId],
    });
    assert.deepEqual(
      decision.targets.map((target) => target.disposition),
      ['allowed', 'warned'],
    );
    assert.deepEqual(
      decision.targets[1].alternatives.map((candidate) => candidate.catId),
      [primaryCatId],
    );
  });
});
