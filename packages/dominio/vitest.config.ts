import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Vitest só executa os testes; a checagem de tipos dos testes (inclusive
    // `@ts-expect-error`) é feita por `pnpm typecheck`.
    typecheck: { enabled: false },
  },
});
