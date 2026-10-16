import { expect, it } from 'vitest';
import { iniciarApi } from './index.js';

it('API recusa transporte real incompleto antes de abrir porta', async () => {
  await expect(
    iniciarApi({ GIA_AMBIENTE: 'teste', GIA_AD_MODO: 'real', GIA_LOG_NIVEL: 'erro' }),
  ).rejects.toThrow('GIA_AD_URL');
});

it('API recusa token inline em produção mesmo com arquivo declarado', async () => {
  await expect(
    iniciarApi({
      GIA_AMBIENTE: 'producao',
      GIA_JIRA_API_TOKEN: 'ficticio',
      GIA_JIRA_API_TOKEN_ARQUIVO: '/inexistente',
    }),
  ).rejects.toThrow('GIA_JIRA_API_TOKEN');
});
