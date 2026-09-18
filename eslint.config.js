import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', 'target/**', '.anchor/**', 'node_modules/**', 'test-ledger/**'] },
  ...tseslint.configs.strict,
  {
    files: ['packages/cli/src/**/*.ts'],
    rules: {
      // The CLI is a thin shell (architecture §1): only core and the argument parser may be imported.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!@epochnotes/core$|commander$|\\./|node:)',
              message: 'CLI may import only @epochnotes/core, commander, node: builtins and its own files.',
            },
          ],
        },
      ],
    },
  },
);
