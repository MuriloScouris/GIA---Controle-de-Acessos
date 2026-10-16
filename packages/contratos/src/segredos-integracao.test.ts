import { expect, it } from 'vitest';
import { exigirSegredosForaDoAmbiente, resolverSegredosDeArquivo } from './segredos.js';

it('arquivo declarado não torna um token inline confiável em produção', async () => {
  const env = {
    GIA_AMBIENTE: 'producao',
    GIA_JIRA_API_TOKEN: 'valor-ficticio',
    GIA_JIRA_API_TOKEN_ARQUIVO: '/arquivo-inexistente',
  };
  expect(() => exigirSegredosForaDoAmbiente(env)).toThrow('GIA_JIRA_API_TOKEN');
  await expect(resolverSegredosDeArquivo(env)).rejects.toThrow('GIA_JIRA_API_TOKEN');
});
