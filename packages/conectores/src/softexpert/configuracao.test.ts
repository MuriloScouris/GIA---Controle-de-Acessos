import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErroConfiguracao } from '@gia/contratos';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cabecalhoAutorizacao,
  carregarConfiguracaoSoftexpert,
  lerSegredoSoftexpert,
} from './configuracao.js';

const CONTA_SERVICO = {
  GIA_SOFTEXPERT_URL: 'https://empresa.softexpert.exemplo',
  GIA_SOFTEXPERT_AUTENTICACAO: 'contaServico',
  GIA_SOFTEXPERT_USUARIO_SERVICO: 'svc.gia',
  GIA_SOFTEXPERT_SENHA_SERVICO_ARQUIVO: '/run/secrets/softexpert-senha',
};

function variaveisComErro(env: Record<string, string>): readonly string[] {
  try {
    carregarConfiguracaoSoftexpert(env);
  } catch (erro) {
    if (erro instanceof ErroConfiguracao) return erro.variaveis;
    throw erro;
  }
  throw new Error('esperava erro de configuração');
}

describe('configuração do SoftExpert por ambiente', () => {
  it('monta o endpoint do adm_ws a partir da base HTTPS, com padrões seguros', () => {
    expect(carregarConfiguracaoSoftexpert(CONTA_SERVICO)).toEqual({
      endpoint: 'https://empresa.softexpert.exemplo/apigateway/se/ws/adm_ws.php',
      autenticacao: {
        modo: 'contaServico',
        usuario: 'svc.gia',
        arquivoSenha: '/run/secrets/softexpert-senha',
      },
      idioma: null,
      timeoutMs: 20_000,
      tentativasLeitura: 2,
      revogacaoConferida: false,
    });
  });

  it('exige HTTPS e só a base (sem caminho, credencial ou query na URL)', () => {
    for (const url of [
      'http://empresa.softexpert.exemplo',
      'https://empresa.softexpert.exemplo/se/ws/adm_ws.php',
      'https://usuario:senha@empresa.softexpert.exemplo',
      'https://empresa.softexpert.exemplo/?token=x',
      'nao-e-url',
    ]) {
      expect(variaveisComErro({ ...CONTA_SERVICO, GIA_SOFTEXPERT_URL: url })).toEqual([
        'GIA_SOFTEXPERT_URL',
      ]);
    }
  });

  it('em produção exige conta de serviço: o token do gateway é pessoal', () => {
    const token = {
      GIA_SOFTEXPERT_URL: 'https://empresa.softexpert.exemplo',
      GIA_SOFTEXPERT_AUTENTICACAO: 'token',
      GIA_SOFTEXPERT_TOKEN_ARQUIVO: '/run/secrets/softexpert-token',
    };
    expect(
      carregarConfiguracaoSoftexpert({ ...token, GIA_AMBIENTE: 'teste' }).autenticacao,
    ).toEqual({
      modo: 'token',
      arquivoToken: '/run/secrets/softexpert-token',
    });
    expect(variaveisComErro({ ...token, GIA_AMBIENTE: 'producao' })).toEqual([
      'GIA_SOFTEXPERT_AUTENTICACAO',
    ]);
    expect(() =>
      carregarConfiguracaoSoftexpert({ ...CONTA_SERVICO, GIA_AMBIENTE: 'producao' }),
    ).not.toThrow();
  });

  it('lista só os nomes das variáveis com problema, nunca os valores', () => {
    const variaveis = variaveisComErro({
      GIA_SOFTEXPERT_URL: 'https://empresa.softexpert.exemplo',
      GIA_SOFTEXPERT_AUTENTICACAO: 'contaServico',
      GIA_SOFTEXPERT_USUARIO_SERVICO: 'svc gia; senha=segredo',
      GIA_SOFTEXPERT_TIMEOUT_MS: '60000',
      GIA_SOFTEXPERT_IDIOMA: 'pt_BR<x>',
      GIA_SOFTEXPERT_REVOGACAO_CONFERIDA: 'sim',
    });
    expect(variaveis).toEqual([
      'GIA_SOFTEXPERT_IDIOMA',
      'GIA_SOFTEXPERT_REVOGACAO_CONFERIDA',
      'GIA_SOFTEXPERT_SENHA_SERVICO_ARQUIVO',
      'GIA_SOFTEXPERT_TIMEOUT_MS',
      'GIA_SOFTEXPERT_USUARIO_SERVICO',
    ]);
    expect(variaveisComErro({})).toEqual(['GIA_SOFTEXPERT_AUTENTICACAO', 'GIA_SOFTEXPERT_URL']);
  });

  describe('segredos em arquivo do cofre e header Authorization', () => {
    let pasta = '';
    beforeAll(async () => {
      pasta = await mkdtemp(join(tmpdir(), 'gia-se-'));
    });
    afterAll(async () => {
      await rm(pasta, { recursive: true, force: true });
    });

    it('o JWT vai cru, sem "Bearer" (com o prefixo o gateway responde 401)', async () => {
      const arquivo = join(pasta, 'token');
      await writeFile(arquivo, 'Bearer eyJ.token.de.teste\n');
      expect(await cabecalhoAutorizacao({ modo: 'token', arquivoToken: arquivo })).toBe(
        'eyJ.token.de.teste',
      );
    });

    it('a conta de serviço vai como Basic', async () => {
      const arquivo = join(pasta, 'senha');
      await writeFile(arquivo, 'senha-de-teste');
      const cabecalho = await cabecalhoAutorizacao({
        modo: 'contaServico',
        usuario: 'svc.gia',
        arquivoSenha: arquivo,
      });
      expect(cabecalho).toBe(`Basic ${Buffer.from('svc.gia:senha-de-teste').toString('base64')}`);
    });

    it('arquivo ausente, vazio ou com várias linhas é erro de configuração com o nome da variável', async () => {
      const vazio = join(pasta, 'vazio');
      const linhas = join(pasta, 'linhas');
      await writeFile(vazio, '');
      await writeFile(linhas, 'a\nb\n');
      for (const caminho of [join(pasta, 'nao-existe'), vazio, linhas]) {
        await expect(
          lerSegredoSoftexpert(caminho, 'GIA_SOFTEXPERT_TOKEN_ARQUIVO'),
        ).rejects.toMatchObject({
          variaveis: ['GIA_SOFTEXPERT_TOKEN_ARQUIVO'],
        });
      }
    });
  });
});
