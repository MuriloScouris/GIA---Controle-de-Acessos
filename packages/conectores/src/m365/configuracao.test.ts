import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErroConfiguracao } from '@gia/contratos';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { carregarConfiguracaoM365, lerSegredoM365 } from './configuracao.js';

const VALIDO = {
  GIA_M365_TENANT_ID: '11111111-2222-4333-8444-555555555555',
  GIA_M365_CLIENT_ID: '66666666-7777-4888-9999-000000000000',
  GIA_M365_CLIENT_SECRET_ARQUIVO: '/run/secrets/m365',
};

function variaveis(env: Record<string, string>): readonly string[] {
  try {
    carregarConfiguracaoM365(env);
  } catch (erro) {
    if (erro instanceof ErroConfiguracao) return erro.variaveis;
    throw erro;
  }
  throw new Error('esperava erro de configuração');
}

describe('configuração do M365 por ambiente', () => {
  it('lê a configuração com padrões seguros e nuvem global', () => {
    expect(carregarConfiguracaoM365(VALIDO)).toEqual({
      tenantId: VALIDO.GIA_M365_TENANT_ID,
      clientId: VALIDO.GIA_M365_CLIENT_ID,
      arquivoSegredo: '/run/secrets/m365',
      nuvem: 'global',
      timeoutMs: 20_000,
      tentativasLeitura: 3,
    });
    expect(
      carregarConfiguracaoM365({ ...VALIDO, GIA_M365_TENANT_ID: 'empresa.onmicrosoft.com' })
        .tenantId,
    ).toBe('empresa.onmicrosoft.com');
  });

  it('só aceita o tenant explícito: "common" ou "organizations" entrariam em outro tenant', () => {
    for (const tenant of ['common', 'organizations', 'consumers', '../x', '']) {
      expect(variaveis({ ...VALIDO, GIA_M365_TENANT_ID: tenant })).toEqual(['GIA_M365_TENANT_ID']);
    }
  });

  it('lista só os nomes das variáveis com problema, nunca os valores', () => {
    expect(
      variaveis({
        GIA_M365_TENANT_ID: VALIDO.GIA_M365_TENANT_ID,
        GIA_M365_CLIENT_ID: 'segredo-colado-no-lugar-errado',
        GIA_M365_NUVEM: 'china',
        GIA_M365_TIMEOUT_MS: '60000',
      }),
    ).toEqual([
      'GIA_M365_CLIENT_ID',
      'GIA_M365_CLIENT_SECRET_ARQUIVO',
      'GIA_M365_NUVEM',
      'GIA_M365_TIMEOUT_MS',
    ]);
  });

  describe('segredo em arquivo do cofre', () => {
    let pasta = '';
    beforeAll(async () => {
      pasta = await mkdtemp(join(tmpdir(), 'gia-m365-'));
    });
    afterAll(async () => {
      await rm(pasta, { recursive: true, force: true });
    });

    it('lê sem a quebra de linha final; ausente, vazio ou com várias linhas é erro', async () => {
      const ok = join(pasta, 'ok');
      await writeFile(ok, 'valor-de-teste\n');
      expect(await lerSegredoM365(ok)).toBe('valor-de-teste');
      const vazio = join(pasta, 'vazio');
      const linhas = join(pasta, 'linhas');
      await writeFile(vazio, '');
      await writeFile(linhas, 'a\nb');
      for (const caminho of [join(pasta, 'nao-existe'), vazio, linhas]) {
        await expect(lerSegredoM365(caminho)).rejects.toMatchObject({
          variaveis: ['GIA_M365_CLIENT_SECRET_ARQUIVO'],
        });
      }
    });
  });
});
