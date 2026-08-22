import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, it, mock } from 'node:test';
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

  function registerTestCat(contextWindow = MANUAL_WINDOW, defaultModel = 'gpt-5.6-sol', accountRef = 'codex-oauth') {
    catRegistry.reset();
    catRegistry.register(TEST_CAT_ID, {
      id: TEST_CAT_ID,
      name: TEST_CAT_ID,
      displayName: 'Issue 1381 Test',
      avatar: '🐱',
      color: { primary: '#000', secondary: '#fff' },
      mentionPatterns: ['@issue-1381-codex-window'],
      clientId: 'openai',
      ...(accountRef ? { accountRef } : {}),
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

  /**
   * 太阳猫 review P2: the pure snapshot/pin rounds above never cross the
   * production bridge — deleting the `contextNativeWindowTokens` pass-through
   * in invoke-single-cat would not turn them red. This suite drives the full
   * loop per resume round: route-level resolve + pre-pin → invokeSingleCat →
   * real CodexAgentService argv construction (mock spawn) → Codex's effective
   * token_count report (injected contextSnapshotResolver) → post-usage
   * re-pin in the real SessionChainStore.
   */
  describe('production bridge: invokeSingleCat → CodexAgentService argv/report/pin loop', () => {
    const CLI_THREAD_ID = 't-issue-1381-bridge';
    let invokeSingleCat;
    let CodexAgentService;
    let fakeL0Compiler;
    let bridgeGlobalConfigRoot;
    let savedGlobalConfigRoot;
    let savedHome;

    function createMockProcess() {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const emitter = new EventEmitter();
      const originalEmit = emitter.emit.bind(emitter);
      emitter.emit = (event, ...args) => {
        const emitted = originalEmit(event, ...args);
        if (event === 'exit') {
          process.nextTick(() => originalEmit('close', ...args));
        }
        return emitted;
      };
      const proc = {
        stdout,
        stderr,
        stdin: { write: () => true, end: () => {}, on: () => proc.stdin },
        // invoke-single-cat passes a liveness probe; spawnCli checks pid
        // liveness via signal-0, so the mock needs a pid that actually exists.
        // Signals still route through the mocked kill(), and cli-spawn's
        // process.on('exit') SIGKILL guard is neutralized by childExited.
        pid: process.pid,
        exitCode: null,
        kill: mock.fn(() => {
          process.nextTick(() => {
            if (!stdout.destroyed) stdout.end();
            emitter.emit('exit', null, 'SIGTERM');
          });
          return true;
        }),
        on: (event, listener) => {
          emitter.on(event, listener);
          return proc;
        },
        once: (event, listener) => {
          emitter.once(event, listener);
          return proc;
        },
        _emitter: emitter,
      };
      return proc;
    }

    function emitCodexEvents(proc, events) {
      for (const event of events) {
        proc.stdout.write(`${JSON.stringify(event)}\n`);
      }
      setImmediate(() => {
        proc.stdout.end();
        proc._emitter.emit('exit', 0, null);
      });
    }

    async function waitFor(condition, label) {
      const deadline = Date.now() + 10_000;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    function parseInjectedNativeWindow(args) {
      for (const arg of args) {
        const match = /^model_context_window=(\d+)$/.exec(arg);
        if (match) return Number(match[1]);
      }
      return null;
    }

    async function collect(iterable) {
      const msgs = [];
      for await (const msg of iterable) msgs.push(msg);
      return msgs;
    }

    before(async () => {
      ({ invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js'));
      ({ CodexAgentService } = await import('../dist/domains/cats/services/agents/providers/CodexAgentService.js'));
      ({ fakeL0Compiler } = await import('./helpers/fake-l0-compiler.js'));
      savedGlobalConfigRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      savedHome = process.env.HOME;
      bridgeGlobalConfigRoot = await mkdtemp(join(tmpdir(), 'issue-1381-bridge-global-'));
      process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = bridgeGlobalConfigRoot;
      process.env.HOME = bridgeGlobalConfigRoot;
    });

    after(async () => {
      if (savedGlobalConfigRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalConfigRoot;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (bridgeGlobalConfigRoot) await rm(bridgeGlobalConfigRoot, { recursive: true, force: true });
    });

    it('keeps the injected Codex argv window at the configured native window across 12 bridge resumes', async () => {
      // No accountRef: the bridge drives real invoke-single-cat account
      // resolution, which hard-fails on a bound account that does not exist in
      // the isolated global config. Template openai variants also leave
      // accountRef undefined.
      registerTestCat(undefined, undefined, null);
      const store = new SessionChainStore();
      const threadId = 'thread-issue-1381-bridge';
      // cliSessionId matches the Codex thread_id emitted below so the
      // session_init binding takes the same-session path every round.
      const active = store.create({
        cliSessionId: CLI_THREAD_ID,
        threadId,
        catId: TEST_CAT_ID,
        userId: 'user-1',
      });

      let currentProc = null;
      let currentReport = 0;
      let invocationCounter = 0;
      const spawnFn = mock.fn(() => currentProc);
      const service = new CodexAgentService({
        catId: TEST_CAT_ID,
        l0CompilerFn: fakeL0Compiler,
        spawnFn,
        model: 'gpt-5.6-sol',
        auditLog: { append: async () => {} },
        rawArchive: { append: async () => {}, getPath: () => undefined },
        // Simulates Codex's own token_count bookkeeping: whatever native window
        // was injected on argv comes back multiplied by the effective percent.
        contextSnapshotResolver: async () => ({ contextUsedTokens: 1_000, contextWindowTokens: currentReport }),
      });

      const sessionMap = new Map();
      const sessionKey = `user-1:${TEST_CAT_ID}:${threadId}`;
      const deps = {
        registry: {
          create: () => ({
            invocationId: `inv-bridge-${++invocationCounter}`,
            callbackToken: `tok-${invocationCounter}`,
          }),
          verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
        },
        sessionManager: {
          get: async () => sessionMap.get(sessionKey),
          getOrCreate: async () => ({}),
          store: async (_userId, _catId, _threadId, sessionId) => {
            sessionMap.set(sessionKey, sessionId);
          },
          delete: async () => {
            sessionMap.delete(sessionKey);
          },
          resolveWorkingDirectory: () => '/tmp/test',
        },
        threadStore: null,
        apiUrl: 'http://127.0.0.1:3004',
        sessionChainStore: store,
      };

      for (let round = 1; round <= 12; round += 1) {
        // route-serial.ts production sequence: resolve member config → apply the
        // active session pin → invoke with the pinned snapshot.
        const resolved = await resolveInvocationCapacitySnapshot({ catId: TEST_CAT_ID, service });
        const pinnedSnapshot = await applyActiveSessionCapacityPin({
          snapshot: resolved,
          catId: TEST_CAT_ID,
          threadId,
          userId: 'user-1',
          sessionChainStore: store,
        });

        currentProc = createMockProcess();
        const promise = collect(
          invokeSingleCat(deps, {
            catId: TEST_CAT_ID,
            service,
            prompt: `bridge resume round ${round}`,
            userId: 'user-1',
            threadId,
            isLastCat: true,
            capacitySnapshot: pinnedSnapshot,
            // Production contract for codex exec_json resumes: the continuity
            // handshake resolves 'unknown', so the route must supply a prompt
            // rebuild callback (route-serial passes one; without it the
            // invocation throws context_continuity_cold_rebuild_unavailable).
            rebuildPromptAfterSessionSeal: async () => `bridge resume round ${round} (rebuilt)`,
          }),
        );
        // Always drive the mocked CLI to completion before asserting — an
        // assertion thrown while the generator still waits for stdout would
        // leave the invocation timeout timer pending and hang the test process.
        let injected = null;
        let roundError = null;
        try {
          await waitFor(() => spawnFn.mock.calls.length === round, `codex spawn for round ${round}`);
          const args = spawnFn.mock.calls[round - 1].arguments[1];
          injected = parseInjectedNativeWindow(args);
          currentReport = codexEffectiveReport(injected ?? MANUAL_WINDOW);
          emitCodexEvents(currentProc, [
            { type: 'thread.started', thread_id: CLI_THREAD_ID },
            { type: 'turn.completed', usage: { input_tokens: 1_000, output_tokens: 50 } },
          ]);
        } catch (err) {
          roundError = err;
          try {
            currentProc.stdout.end();
            currentProc._emitter.emit('exit', 1, null);
          } catch {
            /* best-effort stream teardown */
          }
        }
        const msgs = await promise;
        if (roundError) throw roundError;
        assert.equal(
          injected,
          MANUAL_WINDOW,
          `round ${round}: argv must inject the config-owned native window ${MANUAL_WINDOW}, ` +
            'never the effective/pinned capacity (the pre-#1381 recursion)',
        );
        assert.ok(
          msgs.some((m) => m.type === 'done'),
          `round ${round}: invocation must complete`,
        );
        assert.ok(!msgs.some((m) => m.type === 'error'), `round ${round}: invocation must not error`);
        assert.equal(
          store.get(active.id)?.capacityPin?.windowTokens,
          EFFECTIVE_WINDOW,
          `round ${round}: session pin must stay at ${EFFECTIVE_WINDOW}, not shrink recursively`,
        );
      }
    });
  });
});
