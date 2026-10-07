import tseslint from 'typescript-eslint';

export default tseslint.config(
  // corpus/pairs holds excerpts of other people's files: fragments, not programs, and not ours to restyle
  {
    ignores: [
      '**/dist/**',
      'target/**',
      '.anchor/**',
      'node_modules/**',
      'test-ledger/**',
      'corpus/pairs/**',
    ],
  },
  ...tseslint.configs.strict,
  {
    files: ['packages/cli/src/**/*.ts'],
    rules: {
      // The CLI is a thin shell: only core and the argument parser may be imported, so logic stays testable in core.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!@epochnotes/core$|commander$|\\./|node:module$)',
              message:
                'CLI may import only @epochnotes/core, commander, node:module (to read its own package.json) and its own files.',
            },
          ],
        },
      ],
    },
  },
);
