// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * O domínio é puro: nada de banco, rede, sistema de arquivos, conectores ou
 * frameworks. Só imports relativos entre arquivos do próprio pacote.
 */
const importsProibidosNoDominio = {
  patterns: [
    {
      regex: String.raw`^(?!\.{1,2}/)`,
      message:
        'O domínio não depende de pacotes externos nem de módulos do Node (sem I/O, rede, banco ou framework). Use apenas imports relativos.',
    },
  ],
};

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', importsProibidosNoDominio],
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
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['eslint.config.js', 'vitest.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
);
