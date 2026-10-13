import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/coverage/**', '.maestri/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Domínio puro (packages/dominio): sem banco, rede, sistema de arquivos,
    // conectores, frameworks, relógio ou aleatoriedade. Só imports relativos.
    files: ['packages/dominio/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: String.raw`^(?!\.{1,2}/)`,
              message:
                'O domínio não depende de pacotes externos nem de módulos do Node (sem I/O, rede, banco ou framework). Use apenas imports relativos.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'O domínio não faz chamadas de rede.' },
        { name: 'process', message: 'O domínio não lê ambiente nem processo.' },
        { name: 'setTimeout', message: 'O domínio não agenda trabalho; isso é do worker.' },
        { name: 'setInterval', message: 'O domínio não agenda trabalho; isso é do worker.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'O instante vem do contexto do comando (ctx.agora), nunca do relógio.',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'O instante vem do contexto do comando (ctx.agora), nunca do relógio.',
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: 'O domínio é determinístico; aleatoriedade vem de fora.',
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
);
