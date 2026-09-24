import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// NFR-08: the core never imports a game adapter. Only the composition roots
// (the agent's and the panel's entry points) pick adapters, through
// @gsp/adapters; everything else sees the contract in @gsp/adapter-api.
const CORE = 'packages/{shared,formats,adapter-api,agent,panel,web}/src/**/*.{ts,tsx}';
const COMPOSITION_ROOTS = ['packages/agent/src/main.ts', 'packages/panel/src/main.ts', 'packages/panel/src/wiring.ts'];
const GAME_ADAPTER_IMPORTS = {
  patterns: [
    {
      regex: '^@gsp/(adapters|adapter-(?!api(/|$))[^/]+)(/.*)?$',
      message: 'The core must not import a game adapter (NFR-08): use the contract in @gsp/adapter-api; only the entry points wire adapters in.',
    },
    {
      regex: '^(\\.\\./)+(adapters|adapter-(?!api(/|$))[^/]+)(/.*)?$',
      message: 'The core must not import a game adapter (NFR-08), not even by relative path.',
    },
  ],
};

// Core files that still import Project Zomboid code while the M1 wave moves
// it into packages/adapter-pz. Each branch removes only its own group; the
// list goes away once all three are empty.
const LEGACY_GAME_IMPORTERS = [
  // --- M1-A (agent)
  'packages/agent/src/agent.ts',

  // --- M1-B (panel)

  // --- M1-C (config/web)
  'packages/panel/src/config/service.ts',
];

export default tseslint.config(
  // '.*/**': every top-level dot-directory (tool state, nested worktrees, .tmp).
  { ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**', 'fixtures/**', '.*/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-control-regex': 'off',
    },
  },
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: [CORE],
    ignores: [...COMPOSITION_ROOTS, '**/*.test.{ts,tsx}', ...LEGACY_GAME_IMPORTERS],
    rules: { 'no-restricted-imports': ['error', GAME_ADAPTER_IMPORTS] },
  },
);
