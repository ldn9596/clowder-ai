import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

const TEST_CAT_ID = 'issue-1381-codex-window';
const MANUAL_WINDOW = 258_400;
const CODEX_EFFECTIVE_PERCENT = 0.95;
const EFFECTIVE_WINDOW = Math.floor(MANUAL_WINDOW * CODEX_EFFECTIVE_PERCENT); // 245480

// Codex exec_json reports token_count.model_context_window AFTER applying its
// effective_context_window_percent to the injected native model_context_window.
const codexEffectiveReport = (nativeWindow) => Math.floor(nativeWindow * CODEX_EFFECTIVE_PERCENT);

describe('issue #1381: Codex exec_json native/effective context window feedback loop', () => {
  let resolveInvocationCapacitySnapshot;
  let applyUsageEvidenceToInvocationSnapshot;
  let applyActiveSessionCapacityPin;
  let SessionChainStore;
  let savedConfigs;

  function registerTestCat(contextWindow = MANUAL_WINDOW, defaultModel = 'gpt-5.6-sol') {
    catRegistry.reset();
    catRegistry.register(TEST_CAT_ID, {
      id: TEST_CAT_ID,
      name: TEST_CAT_ID,
      displayName: 'Issue 1381 Test',
      avatar: '🐱',
      color: { primary: '#000', secondary: '#fff' },
      mentionPatterns: ['@issue-1381-codex-window'],
      clientId: 'openai',
      accountRef: 'codex-oauth',
      provider: 'openai',
      defaultModel,
      contextWindow,
      mcpSupport: false,
      roleDescription: 'test',
      personality: 'test',
    });
  }

  function execJsonService() {
    return {
      async *invoke() {},
      contextCapability() {
        return {
          provider: 'openai',
          carrier: 'exec_json',
          reportsRuntimeWindow: true,
          authoritativeUsage: true,
          usageTelemetry: 'available',
          nativeWindowControl: true,
          nativeCompressionControl: true,
          observesCompression: true,
          reason: 'test codex exec_json carrier',
        };
      },
    };
  }

  before(async () => {
    ({ resolveInvocationCapacitySnapshot, applyUsageEvidenceToInvocationSnapshot, applyActiveSessionCapacityPin } =
      await import('../dist/domains/cats/services/agents/invocation/invocation-capacity-snapshot.js'));
    ({ SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js'));
    savedConfigs = catRegistry.getAllConfigs();
  });

  after(() => {
    catRegistry.reset();
    for (const [id, config] of Object.entries(savedConfigs)) catRegistry.register(id, config);
  });

  /**
   * One resume round: resolve member config, apply the session pin, inject the
   * native window into Codex, observe Codex's effective report, apply the pin
   * again. Returns the post-report snapshot.
   */
  async function runResumeRound(store, threadId, reportOverride) {
    const resolved = await resolveInvocationCapacitySnapshot({
      catId: TEST_CAT_ID,
      service: execJsonService(),
    });
    const pinned = await applyActiveSessionCapacityPin({
      snapshot: resolved,
      catId: TEST_CAT_ID,
      threadId,
      sessionChainStore: store,
    });
    // Codex applies its 95% effective factor to whatever native window we
    // injected; the report must never become the next native window.
    const report = reportOverride ?? codexEffectiveReport(pinned.nativeWindowTokens);
    const observed = applyUsageEvidenceToInvocationSnapshot({
      snapshot: pinned,
      catId: TEST_CAT_ID,
      capability: pinned.capability,
      reportedWindowSize: report,
    });
    return applyActiveSessionCapacityPin({
      snapshot: observed,
      catId: TEST_CAT_ID,
      threadId,
      sessionChainStore: store,
    });
  }

  it('keeps the manual-configured native window stable across 12 resumes of the same session', async () => {
    registerTestCat();
    const store = new SessionChainStore();
    const threadId = 'thread-issue-1381-stability';
    const active = store.create({
      cliSessionId: 'cli-issue-1381-stability',
      threadId,
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });

    // Round 1 establishes the pin: native 258400 → Codex reports 245480.
    const first = await runResumeRound(store, threadId);
    assert.equal(first.nativeWindowTokens, MANUAL_WINDOW);
    assert.equal(first.capacity.windowTokens, EFFECTIVE_WINDOW);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, EFFECTIVE_WINDOW);

    // Rounds 2..12 must be a fixed point: before the fix each round fed the
    // effective report back as the next native window (258400 → 245480 →
    // 233206 → …); now the native window comes from member config every time.
    for (let round = 2; round <= 12; round += 1) {
      const snapshot = await runResumeRound(store, threadId);
      assert.equal(
        snapshot.nativeWindowTokens,
        MANUAL_WINDOW,
        `round ${round}: native model_context_window must stay at the configured ${MANUAL_WINDOW}`,
      );
      assert.equal(
        snapshot.capacity.windowTokens,
        EFFECTIVE_WINDOW,
        `round ${round}: effective capacity must stay at ${EFFECTIVE_WINDOW}, not shrink recursively`,
      );
      assert.equal(
        store.get(active.id)?.capacityPin?.windowTokens,
        EFFECTIVE_WINDOW,
        `round ${round}: session pin must stay at ${EFFECTIVE_WINDOW}`,
      );
    }
  });

  it('still shrinks the pin when the provider independently reports a genuinely smaller window', async () => {
    registerTestCat();
    const store = new SessionChainStore();
    const threadId = 'thread-issue-1381-genuine-shrink';
    const active = store.create({
      cliSessionId: 'cli-issue-1381-shrink',
      threadId,
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });

    await runResumeRound(store, threadId);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, EFFECTIVE_WINDOW);

    // A genuinely independent reduction (e.g. provider/model metadata change),
    // not the 95% echo of our own injection.
    const shrunk = await runResumeRound(store, threadId, 200_000);
    assert.equal(shrunk.capacity.windowTokens, 200_000);
    assert.equal(shrunk.capacity.source, 'reported');
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, 200_000);

    // The shrink persists and does not oscillate back while the provider keeps
    // reporting the reduced window.
    const steady = await runResumeRound(store, threadId, 200_000);
    assert.equal(steady.capacity.windowTokens, 200_000);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, 200_000);
  });

  it('never auto-expands a pin on a larger fresh report — recovery stays explicit via seal/rollover', async () => {
    registerTestCat();
    const store = new SessionChainStore();
    const threadId = 'thread-issue-1381-recovery';
    const active = store.create({
      cliSessionId: 'cli-issue-1381-recovery',
      threadId,
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });
    // Pin polluted by the old feedback loop (258400 * 0.95^11 ≈ 146973).
    store.update(active.id, {
      capacityPin: {
        windowTokens: 146_973,
        inputCeilingTokens: 130_973,
        source: 'reported',
        provenance: 'Carrier reported 146,973 tokens (polluted by pre-fix feedback loop)',
        actionable: true,
      },
    });

    // Codex now reports the stable effective window (245480) — larger than the
    // polluted pin. A larger report cannot distinguish pre-fix pollution from
    // a genuine shrink followed by genuine recovery, so the pin must NOT
    // auto-expand; the recoverable state is surfaced in the provenance.
    const clamped = await runResumeRound(store, threadId);
    assert.equal(clamped.capacity.windowTokens, 146_973);
    assert.match(clamped.capacity.provenance, /session-pinned/);
    assert.match(clamped.capacity.provenance, /seal the session to recover/);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, 146_973);

    // Explicit recovery: sealing the session ends the pin; the fresh session
    // adopts the carrier-reported capacity on its first invocation.
    store.update(active.id, { status: 'sealed' });
    const fresh = store.create({
      cliSessionId: 'cli-issue-1381-recovered',
      threadId,
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });
    const recovered = await runResumeRound(store, threadId);
    assert.equal(recovered.capacity.windowTokens, EFFECTIVE_WINDOW);
    assert.equal(store.get(fresh.id)?.capacityPin?.windowTokens, EFFECTIVE_WINDOW);
  });

  it('does not expand a genuinely shrunk pin when the provider later reports a larger window', async () => {
    // 砚砚 review counterexample: genuine provider shrink to 200K, then a later
    // report of 245480. The larger report is genuine independent evidence, but
    // expansion past the pin remains gated on rollover.
    registerTestCat();
    const store = new SessionChainStore();
    const threadId = 'thread-issue-1381-genuine-then-larger';
    const active = store.create({
      cliSessionId: 'cli-issue-1381-genuine-then-larger',
      threadId,
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });

    await runResumeRound(store, threadId, 200_000);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, 200_000);

    const later = await runResumeRound(store, threadId, EFFECTIVE_WINDOW);
    assert.equal(later.capacity.windowTokens, 200_000);
    assert.match(later.capacity.provenance, /session-pinned/);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, 200_000);
  });

  it('does not expand a pin from a floor-raised catalog value without raw provider proof', async () => {
    // claude-fable-5: KNOWN_MIN floor raises a stale 200K CLI report to 1M in
    // the resolver, but the raw report never proved 1M — the pin must not
    // expand on that basis.
    registerTestCat(undefined, 'claude-fable-5');
    const store = new SessionChainStore();
    const threadId = 'thread-issue-1381-floor';
    const active = store.create({
      cliSessionId: 'cli-issue-1381-floor',
      threadId,
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });
    store.update(active.id, {
      capacityPin: {
        windowTokens: 200_000,
        inputCeilingTokens: 184_000,
        source: 'reported',
        provenance: 'Carrier reported 200,000 tokens',
        actionable: true,
      },
    });

    const recovered = await runResumeRound(store, threadId, 200_000);
    assert.equal(recovered.capacity.windowTokens, 200_000);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, 200_000);
  });

  it('keeps expansion gated on rollover when no fresh carrier report exists', async () => {
    registerTestCat();
    const store = new SessionChainStore();
    const threadId = 'thread-issue-1381-no-report';
    const active = store.create({
      cliSessionId: 'cli-issue-1381-no-report',
      threadId,
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });

    await runResumeRound(store, threadId);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, EFFECTIVE_WINDOW);

    // Member raises the manual cap mid-session; without a carrier report the
    // active session must NOT expand — rollover semantics are preserved.
    registerTestCat(400_000);
    const resolved = await resolveInvocationCapacitySnapshot({
      catId: TEST_CAT_ID,
      service: execJsonService(),
    });
    const pinned = await applyActiveSessionCapacityPin({
      snapshot: resolved,
      catId: TEST_CAT_ID,
      threadId,
      sessionChainStore: store,
    });
    assert.equal(pinned.capacity.windowTokens, EFFECTIVE_WINDOW);
    assert.match(pinned.capacity.provenance, /session-pinned/);
    assert.equal(pinned.nativeWindowTokens, 400_000);
    assert.equal(store.get(active.id)?.capacityPin?.windowTokens, EFFECTIVE_WINDOW);
  });
});
