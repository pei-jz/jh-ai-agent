import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Unit + loop-integration test config. Tests run in a Node environment and mock
// the Tauri bridge (`@tauri-apps/api/*`) so logic can be exercised without a
// running app.
//
// ── Coverage scope: read this before trusting the % ────────────────────────
// The reported percentage is scoped to `include` below. That list holds the
// modules we actually test — it is NOT the whole app, so "78%" means "78% of
// the tested surface", not "78% of JH AI Agent".
//
// IN the denominator:
//   • pure logic modules (agent/, memory/, tools/)          — held to a high bar
//   • AgentController.js — the ~2,600-line decision loop, covered end-to-end by
//     the scripted mock-LLM harness (src/modules/ai/__tests__/agentHarness.js)
//   • pure view/SDK helpers
//   • ToolExecutor.js  — tool gating / dispatch guard rails (invoke() mocked)
//   • LLMService.js    — protocol choice + usage resolution (transport mocked)
//
//   • ContextBuilder / ConversationMemory / TaskBridge — prompt assembly,
//     compaction and mode dispatch, all reachable with the bridge mocked
//   • MonitorView.js — task selection, grouping, result dedup and the live feed,
//     under jsdom (`// @vitest-environment jsdom` in the test file)
//
// STILL OUT (the honest remaining gap):
//   src/dashboard/views/ChatView.js / ConfigView.js / others — same jsdom
//     approach would work; only MonitorView (where the reported bugs were) is
//     covered so far
//   src/modules/ai/tools/handlers/**      thin invoke() wrappers (logic lives in
//                                         SymbolIndex / gitStatusParse / FileEdit,
//                                         which ARE covered). resourceHandlers is
//                                         and officeHandlers are carved back IN —
//                                         they disambiguate/shape data rather than
//                                         forwarding, and have their own suites.
//   McpManager.js — only the resource-routing half is covered; config load/save
//     and the three transports still need a harness
// Historically the expensive bugs (the SSE tool-call corruption, the Playwright
// worker that could never start) lived in exactly this excluded region while the
// gate stayed green. Shrinking this list is the point of the next phase.
export default defineConfig({
  // Svelte components are compiled for tests too, so a migrated component is
  // covered by the same suite as the code it replaced — the migration's whole
  // safety net. `hot: false` keeps the compiler output plain: HMR wrappers change
  // component identity and confuse @testing-library's cleanup.
  plugins: [svelte({ hot: false })],
  // Without the browser condition, Vite hands Vitest svelte's SERVER build and
  // every mount dies with "mount(...) is not available on the server". Svelte 5
  // ships client and server entry points behind export conditions, and Vitest's
  // node-ish default resolution picks the wrong one.
  resolve: {
    conditions: ['browser'],
  },
  test: {
    environment: 'node',
    // .svelte.test.js files are jsdom by convention (they mount components); the
    // per-file `// @vitest-environment jsdom` pragma still decides, as before.
    include: ['src/**/*.test.js', 'test/**/*.test.js', 'sdk/**/*.test.js'],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html'],
      reportsDirectory: './coverage',
      include: [
        'src/modules/ai/agent/**/*.js',
        'src/modules/ai/memory/**/*.js',
        'src/modules/ai/tools/**/*.js',
        // The agent loop itself — exercised by the mock-LLM harness.
        'src/modules/ai/AgentController.js',
        // Tool gating/dispatch and provider-protocol decisions. Both reach Tauri
        // only through `invoke`, which the tests mock — the "it's just I/O glue"
        // exemption was only ever true of the handlers, not these.
        'src/modules/ai/ToolExecutor.js',
        'src/modules/ai/LLMService.js',
        // The Monitor view — the surface most user-reported bugs landed on.
        'src/dashboard/views/MonitorView.js',
        // The Task view's model + renderer, extracted from MonitorView so the
        // ordering rules are testable rather than entangled with the DOM.
        'src/dashboard/views/monitor/**/*.js',
        // The Svelte migration's seam (docs/design/svelte-migration.md). The
        // .svelte components themselves are covered by their own suites but are
        // not in this list: v8 coverage maps compiled Svelte output poorly enough
        // that the percentage would be noise rather than a signal.
        'src/dashboard/svelte/**/*.js',
        // Licensing (docs/design/licensing.md) and the updater's reporting rules.
        // Both are small, pure, and the kind of thing that fails silently and
        // embarrassingly — an expired licence locking someone out, or an updater
        // claiming "up to date" after a check that never ran.
        'src/modules/license/**/*.js',
        'src/dashboard/views/update/**/*.js',
        // Prompt assembly, history compaction, and the Rust↔JS task bridge.
        'src/modules/ai/ContextBuilder.js',
        'src/modules/ai/ConversationMemory.js',
        'src/modules/bridge/TaskBridge.js',
        // MCP fan-out: which app owns a resource, and the refusal to guess when
        // two publish the same URI. Real routing logic, not transport glue.
        'src/modules/ai/McpManager.js',
        // Pure view util (the DOM/IPC glue in resultView.js stays excluded).
        'src/dashboard/utils/markdown.js',
        // The theme cycle — pure, and the contract the title-bar button relies on.
        'src/dashboard/utils/theme.js',
        // Pure chat helpers extracted from ChatView (DOM-free).
        'src/dashboard/views/chat/chatMarkdown.js',
        'src/dashboard/views/chat/chatSessions.js',
        'src/dashboard/views/chat/chatRenderer.js',
        // AI-Hub client SDK (Part B) — dependency-free, transport-injectable.
        'sdk/jhai-adapter.js',
      ],
      exclude: [
        '**/__tests__/**',
        '**/*.test.js',
        // Pure static data (tool JSON-Schema definitions) — no logic to unit-test.
        'src/modules/ai/tools/toolSchemas.js',
        // Tool handlers = thin Tauri `invoke`/`fetch` I/O glue (no jsdom/IPC
        // harness in unit tests). Pure logic stays in FuzzyPath/FileEdit/
        // SymbolIndex/commandPolicy, which ARE covered.
        // resourceHandlers is the exception: it formats and disambiguates
        // rather than forwarding, and has its own suite.
        'src/modules/ai/tools/handlers/!(resourceHandlers|officeHandlers).js',
      ],
      // GLOBAL thresholds track the whole scoped set, which now includes the
      // partially-covered agent loop — so they are lower than they were when the
      // denominator held only pure helpers. Set just under the achieved values
      // so a regression fails CI without being brittle.
      // Adding two large, partially-covered modules pulls the GLOBAL numbers
      // down — that is the honest picture, not a regression. Per-area bars below
      // stop the well-covered modules from drifting behind the lower average.
      // NOTE on the headline number: MonitorView is ~3,700 lines of view code, so
      // including it drops the global figure sharply even though the modules that
      // carry the logic are well covered. That is the honest picture — but it also
      // means the GLOBAL bar is a weak signal now. The per-area bars below are
      // what actually guard quality; treat those as the real gate.
      thresholds: {
        lines: 55,
        functions: 60,
        branches: 70,
        statements: 55,
        // PER-AREA bars keep the pure-logic modules from rotting behind the
        // lower global average. These stay high on purpose.
        'src/modules/ai/agent/**/*.js': {
          lines: 90, functions: 95, branches: 80, statements: 90,
        },
        'src/modules/ai/tools/**/*.js': {
          lines: 90, functions: 90, branches: 78, statements: 90,
        },
        // The loop's own floor — ratchet this up as the harness grows.
        'src/modules/ai/AgentController.js': {
          lines: 55, functions: 60, branches: 40, statements: 55,
        },
        // Newly covered; floors sit just under what the suites achieve today so
        // a regression fails while leaving room to keep climbing.
        'src/modules/ai/ToolExecutor.js': {
          lines: 65, functions: 28, branches: 65, statements: 65,
        },
        'src/modules/ai/LLMService.js': {
          lines: 38, functions: 30, branches: 85, statements: 38,
        },
        // Only the resource-routing half is under test; config load/save and
        // the transport wiring still need a harness.
        'src/modules/ai/McpManager.js': {
          lines: 38, functions: 30, branches: 90, statements: 38,
        },
        'src/modules/bridge/TaskBridge.js': {
          lines: 64, functions: 68, branches: 48, statements: 64,
        },
        // View code — the covered slice is the logic that produced real bugs
        // (task selection, grouping, result dedup, the live feed).
        'src/dashboard/views/MonitorView.js': {
          lines: 15, functions: 22, branches: 58, statements: 15,
        },
        // Extracted Task-view logic — held to the pure-module bar.
        'src/dashboard/views/monitor/**/*.js': {
          lines: 95, functions: 88, branches: 85, statements: 95,
        },
        // Pure decision tables with no I/O: there is no excuse for a gap here.
        'src/modules/license/**/*.js': {
          lines: 100, functions: 100, branches: 95, statements: 100,
        },
        'src/dashboard/views/update/**/*.js': {
          lines: 100, functions: 100, branches: 95, statements: 100,
        },
      },
    },
  },
});
