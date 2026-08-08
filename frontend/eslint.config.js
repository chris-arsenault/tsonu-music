import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/', 'dist/', 'build/', 'coverage/', 'public/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'devlab/**/*.{ts,tsx}', 'harness/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // The harness runner and its summariser are Node scripts, not browser modules.
    files: ['harness/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['src/visualizer/ui/VisualizerPanel.tsx'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['./editor/**'],
          message: 'The graph editor is owned by frontend/devlab and must not enter the public app graph.',
        }],
      }],
    },
  },
);
