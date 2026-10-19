import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErroConfiguracao } from '@gia/contratos';
import { expect, it } from 'vitest';
import { iniciarApi } from './index.js';

/** Erro de configuração de `iniciarApi`, ou falha do teste se subir. */
async function erroDeArranque(env: Record<string, string>): Promise<ErroConfiguracao> {
  const erro: unknown = await iniciarApi(env).then(
    async (app) => {
      await app.close();
      return new Error('a API não deveria subir');
    },
    (e: unknown) => e,
  );
  expect(erro).toBeInstanceOf(ErroConfiguracao);
  return erro as ErroConfiguracao;
}

it('API recusa transporte real incompleto antes de abrir porta', async () => {
  await expect(
    iniciarApi({ GIA_AMBIENTE: 'teste', GIA_AD_MODO: 'real', GIA_LOG_NIVEL: 'erro' }),
  ).rejects.toThrow('GIA_AD_URL');
});

it('API em produção com verificação TLS desligada não abre a porta (M6)', async () => {
  await expect(
    iniciarApi({
      GIA_AMBIENTE: 'producao',
      GIA_DATABASE_URL: 'postgres://db/gia',
      GIA_LOG_NIVEL: 'erro',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    }),
  ).rejects.toThrow('Configuração inválida: NODE_TLS_REJECT_UNAUTHORIZED');
});

it('API em produção recusa TLS desligado antes de ler o cofre (M6, ordem)', async () => {
  // Arquivo do cofre que não existe: ler o cofre primeiro daria erro sobre ele.
  const ausente = join(tmpdir(), `gia-cofre-ausente-${randomUUID()}`);
  const comCofre = {
    GIA_AMBIENTE: 'producao',
    GIA_DATABASE_URL_ARQUIVO: ausente,
    GIA_LOG_NIVEL: 'erro',
  };
  // Controle: com a verificação ligada, o arranque chega ao cofre e falha nele.
  expect((await erroDeArranque(comCofre)).variaveis).toEqual(['GIA_DATABASE_URL_ARQUIVO']);
  // Com TLS desligado, a recusa vem antes: só a variável TLS, nada do cofre.
  const erro = await erroDeArranque({ ...comCofre, NODE_TLS_REJECT_UNAUTHORIZED: '0' });
  expect(erro.variaveis).toEqual(['NODE_TLS_REJECT_UNAUTHORIZED']);
  expect(erro.message).toBe('Configuração inválida: NODE_TLS_REJECT_UNAUTHORIZED');
  expect(erro.message).not.toContain(ausente);
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
