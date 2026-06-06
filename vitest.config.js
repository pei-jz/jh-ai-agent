import { defineConfig } from 'vitest/config';

// Unit-test config. Tests run in a Node environment and mock the Tauri bridge
// (`@tauri-apps/api/*`) so pure logic (path resolution, permission
// classification, parsing, scoring, …) can be exercised without a running app.
//
// Coverage: `npm run test:coverage`. The strategy (see the refactor plan) is to
// extract PURE logic into dedicated modules and cover those to ~100%; the thin
// Tauri/DOM I/O glue is intentionally excluded from the line target. Thresholds
// are ramped up phase-by-phase as modules are extracted + tested.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.js', 'test/**/*.test.js', 'sdk/**/*.test.js'],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html'],
      reportsDirectory: './coverage',
      // Count only source modules we actually unit-test. As pure logic is
      // extracted (Phases 1-5) more is added here; DOM-/IO-heavy glue stays
      // excluded until it has a jsdom/integration harness.
      // Phase-gated: each refactor phase adds its extracted-module glob here once
      // it ships with tests. (Phase 1 = agent/**; memory/**, tools/**, utils/**
      // are enabled in Phases 2/3/5.)
      include: [
        'src/modules/ai/agent/**/*.js',
        'src/modules/ai/memory/**/*.js',
        'src/modules/ai/tools/**/*.js',
        // Pure view util (the DOM/IPC glue in resultView.js stays excluded).
        'src/dashboard/utils/markdown.js',
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
        // harness in unit tests). Pure logic stays in FuzzyPath/FileEdit/PlanGate.
        'src/modules/ai/tools/handlers/**',
      ],
      // Thresholds locked in after Phases 1-5 (achieved ~95.6% lines / 85.7%
      // branches / 100% funcs across the extracted pure-logic modules). Set just
      // below the achieved values so future regressions fail CI without being
      // brittle. Pure-logic modules are individually held to ~100% in their suites.
      thresholds: {
        lines: 90,
        functions: 95,
        branches: 80,
        statements: 90,
      },
    },
  },
});
