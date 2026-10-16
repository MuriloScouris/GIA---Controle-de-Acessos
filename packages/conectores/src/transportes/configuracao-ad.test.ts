import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErroConfiguracao } from '@gia/contratos';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { carregarConfiguracaoAd, lerSegredoDeArquivo } from './configuracao-ad.js';

const VALIDO = {
  GIA_AD_URL: 'ldaps://dc1.exemplo.com.br:636, ldaps://dc2.exemplo.com.br',
  GIA_AD_BIND_DN: 'CN=svc-gia,OU=Servico,DC=exemplo,DC=com,DC=br',
  GIA_AD_SENHA_ARQUIVO: '/run/secrets/gia-ad',
  GIA_AD_BASE_DN: 'DC=exemplo,DC=com,DC=br',
  GIA_AD_OU_INATIVOS: 'OU=Inativos,DC=exemplo,DC=com,DC=br',
};

function erroDe(env: Record<string, string | undefined>): readonly string[] {
  try {
    carregarConfiguracaoAd(env);
  } catch (erro) {
    if (erro instanceof ErroConfiguracao) return erro.variaveis;
    throw erro;
  }
  throw new Error('esperava erro de configuração');
}

describe('configuração do AD por ambiente', () => {
  it('lê a configuração com os padrões seguros', () => {
    expect(carregarConfiguracaoAd(VALIDO)).toEqual({
      urls: ['ldaps://dc1.exemplo.com.br:636', 'ldaps://dc2.exemplo.com.br'],
      bindDn: VALIDO.GIA_AD_BIND_DN,
      arquivoSenha: '/run/secrets/gia-ad',
      baseDn: VALIDO.GIA_AD_BASE_DN,
      ouInativos: VALIDO.GIA_AD_OU_INATIVOS,
      atributoCpf: 'employeeID',
      arquivoCa: null,
      nomeServidorTls: null,
      timeoutConexaoMs: 5_000,
      timeoutOperacaoMs: 10_000,
      tentativasLeitura: 2,
    });
  });

  it('exige LDAPS: ldap:// sem TLS é recusado em qualquer ambiente', () => {
    expect(erroDe({ ...VALIDO, GIA_AD_URL: 'ldap://dc1.exemplo.com.br' })).toEqual(['GIA_AD_URL']);
  });

  it('lista só o nome das variáveis ausentes ou inválidas, nunca os valores', () => {
    const variaveis = erroDe({
      GIA_AD_URL: 'ldaps://dc1.exemplo.com.br',
      GIA_AD_BIND_DN: 'svc-gia-senha-secreta',
      GIA_AD_TIMEOUT_OPERACAO_MS: 'muito',
    });
    expect(variaveis).toEqual([
      'GIA_AD_BASE_DN',
      'GIA_AD_BIND_DN',
      'GIA_AD_OU_INATIVOS',
      'GIA_AD_SENHA_ARQUIVO',
      'GIA_AD_TIMEOUT_OPERACAO_MS',
    ]);
    try {
      carregarConfiguracaoAd({ ...VALIDO, GIA_AD_BIND_DN: 'svc-gia-senha-secreta' });
    } catch (erro) {
      expect((erro as Error).message).not.toContain('senha-secreta');
    }
  });

  it('a OU de inativos precisa estar dentro da base gerenciada', () => {
    expect(erroDe({ ...VALIDO, GIA_AD_OU_INATIVOS: 'OU=Inativos,DC=outro,DC=br' })).toEqual([
      'GIA_AD_OU_INATIVOS',
    ]);
  });

  it('recusa NODE_DEBUG=ldapts, que registraria as mensagens LDAP com a senha inicial', () => {
    expect(erroDe({ ...VALIDO, NODE_DEBUG: 'net,ldapts' })).toEqual(['NODE_DEBUG']);
    expect(() => carregarConfiguracaoAd({ ...VALIDO, NODE_DEBUG: 'net' })).not.toThrow();
  });

  it('aceita atributo do CPF e nome TLS esperado, validando o formato', () => {
    const config = carregarConfiguracaoAd({
      ...VALIDO,
      GIA_AD_ATRIBUTO_CPF: 'extensionAttribute1',
      GIA_AD_TLS_NOME_SERVIDOR: 'dc1.exemplo.com.br',
    });
    expect(config).toMatchObject({
      atributoCpf: 'extensionAttribute1',
      nomeServidorTls: 'dc1.exemplo.com.br',
    });
    expect(erroDe({ ...VALIDO, GIA_AD_ATRIBUTO_CPF: 'cpf)(x' })).toEqual(['GIA_AD_ATRIBUTO_CPF']);
  });

  describe('segredo em arquivo do cofre', () => {
    let pasta = '';
    beforeAll(async () => {
      pasta = await mkdtemp(join(tmpdir(), 'gia-ad-'));
    });
    afterAll(async () => {
      await rm(pasta, { recursive: true, force: true });
    });

    it('lê o segredo sem a quebra de linha final', async () => {
      const caminho = join(pasta, 'senha');
      await writeFile(caminho, 'valor-de-teste\n');
      expect(await lerSegredoDeArquivo(caminho, 'GIA_AD_SENHA_ARQUIVO')).toBe('valor-de-teste');
    });

    it('arquivo ausente ou vazio é erro de configuração com o nome da variável', async () => {
      const vazio = join(pasta, 'vazio');
      await writeFile(vazio, '');
      for (const caminho of [join(pasta, 'nao-existe'), vazio]) {
        await expect(lerSegredoDeArquivo(caminho, 'GIA_AD_SENHA_ARQUIVO')).rejects.toMatchObject({
          variaveis: ['GIA_AD_SENHA_ARQUIVO'],
        });
      }
    });
  });
});
