import { expect, it } from 'vitest';
import { carregarSelecaoIntegracoes, criarIntegracoesDoAmbiente } from './composicao.js';

it('desenvolvimento fica simulado e configuração real parcial falha sem fallback', async () => {
  expect(carregarSelecaoIntegracoes({})).toEqual([]);
  expect((await criarIntegracoesDoAmbiente({})).reais).toEqual({});
  await expect(criarIntegracoesDoAmbiente({ GIA_AD_MODO: 'real' })).rejects.toThrow('GIA_AD_URL');
});

it('recusa seletores desconhecidos, escrita sem transporte e opt-in local sem gate', () => {
  for (const env of [
    { GIA_M365_MODO: 'REAL' },
    { GIA_AMBIENTE: 'teste', GIA_ESCRITA_EXTERNA: 'true', GIA_ESCRITA_LIBERADA: 'ad:criar' },
    { GIA_JIRA_MODO: 'real', GIA_JIRA_ESCRITA_HABILITADA: 'true' },
    { GIA_DOCUSIGN_ESCRITA_HABILITADA: 'yes' },
  ])
    expect(() => carregarSelecaoIntegracoes(env)).toThrow();
});
