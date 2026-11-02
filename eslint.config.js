// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['dist/', 'coverage/', 'node_modules/', 'spike/reports/', '.multidb/']),

  js.configs.recommended,

  // TypeScript code: type-aware rules.
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  // Server code: stdout is reserved for the MCP protocol (JSON-RPC).
  // A single console.log can break the connection with Claude Code.
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },

  // Scripts and utilities (plain JavaScript, allowed to write to the console).
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
]);
