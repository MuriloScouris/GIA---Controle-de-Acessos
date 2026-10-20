import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ErroConfiguracao,
  RegistroMetricas,
  carregarConfiguracaoAmbiente,
  carregarGatesDeEscrita,
  criarRegistrador,
  escritaPermitida,
  liberacaoDosGates,
  modoDosGates,
} from './index.js';
import { servirMetricas } from './observabilidade-servidor.js';
import {
  exigirSegredosForaDoAmbiente,
  resolverSegredosDeArquivo,
  segredosNoAmbiente,
} from './segredos.js';

function variaveis(acao: () => unknown): readonly string[] {
  try {
    acao();
  } catch (erro) {
    if (erro instanceof ErroConfiguracao) return erro.variaveis;
    throw erro;
  }
  throw new Error('esperava erro de configuração');
}

describe('gates explícitos de escrita externa (regra 8)', () => {
  it('por padrão nada é liberado e as operações nascem simuladas', () => {
    const gates = carregarGatesDeEscrita({});
    expect(gates).toEqual({ ambiente: 'desenvolvimento', escritaExterna: false, liberadas: [] });
    expect(modoDosGates(gates)).toBe('simulado');
    expect(Object.values(liberacaoDosGates(gates)).every((l) => !l.criar && !l.revogar)).toBe(true);
  });

  it('a chave mestra nunca liga em desenvolvimento', () => {
    expect(variaveis(() => carregarConfiguracaoAmbiente({ GIA_ESCRITA_EXTERNA: 'true' }))).toEqual([
      'GIA_ESCRITA_EXTERNA',
    ]);
  });

  it('cada sistema e cada operação são liberados separadamente', () => {
    const gates = carregarGatesDeEscrita({
      GIA_AMBIENTE: 'producao',
      GIA_ESCRITA_EXTERNA: 'true',
      GIA_ESCRITA_LIBERADA: 'ad:criar, softexpert:criar',
    });
    expect(gates.liberadas).toEqual(['ad:criar', 'softexpert:criar']);
    expect(modoDosGates(gates)).toBe('real');
    expect(escritaPermitida(gates, 'ad', 'criar')).toBe(true);
    expect(escritaPermitida(gates, 'ad', 'revogar')).toBe(false);
    expect(escritaPermitida(gates, 'm365', 'criar')).toBe(false);
    expect(liberacaoDosGates(gates).ad).toEqual({ criar: true, revogar: false });
    expect(liberacaoDosGates(gates).jira).toEqual({ criar: false, revogar: false });
  });

  it('chave mestra ligada sem lista não libera nada', () => {
    const gates = carregarGatesDeEscrita({ GIA_AMBIENTE: 'teste', GIA_ESCRITA_EXTERNA: 'true' });
    expect(escritaPermitida(gates, 'ad', 'criar')).toBe(false);
  });

  it('lista com a chave mestra desligada, curinga ou item desconhecido é erro', () => {
    for (const env of [
      { GIA_AMBIENTE: 'producao', GIA_ESCRITA_LIBERADA: 'ad:criar' },
      { GIA_AMBIENTE: 'producao', GIA_ESCRITA_EXTERNA: 'true', GIA_ESCRITA_LIBERADA: '*' },
      { GIA_AMBIENTE: 'producao', GIA_ESCRITA_EXTERNA: 'true', GIA_ESCRITA_LIBERADA: 'ad:*' },
      { GIA_AMBIENTE: 'producao', GIA_ESCRITA_EXTERNA: 'true', GIA_ESCRITA_LIBERADA: 'sap:criar' },
      { GIA_AMBIENTE: 'producao', GIA_ESCRITA_EXTERNA: 'true', GIA_ESCRITA_LIBERADA: 'ad:apagar' },
    ]) {
      expect(variaveis(() => carregarGatesDeEscrita(env))).toEqual(['GIA_ESCRITA_LIBERADA']);
    }
  });
});

describe('segredos fora do ambiente (regra 12)', () => {
  it('aponta segredo passado por valor, sem repetir o valor', () => {
    const env = {
      GIA_AMBIENTE: 'teste',
      GIA_JIRA_API_TOKEN: 'abc',
      GIA_AD_SENHA_ARQUIVO: '/run/secrets/ad',
      GIA_DATABASE_URL: 'postgres://gia:senha-forte@db:5432/gia',
      GIA_DATABASE_URL_TESTE: 'postgres://postgres:x@localhost/teste',
      GIA_SOFTEXPERT_USUARIO_SERVICO: 'svc.gia',
    };
    expect(segredosNoAmbiente(env)).toEqual(['GIA_DATABASE_URL', 'GIA_JIRA_API_TOKEN']);
    expect(exigirSegredosForaDoAmbiente(env)).toEqual(['GIA_DATABASE_URL', 'GIA_JIRA_API_TOKEN']);
  });

  it('em produção recusa subir com segredo por valor', () => {
    const env = { GIA_AMBIENTE: 'producao', GIA_DOCUSIGN_SECRET: 'x' };
    expect(variaveis(() => exigirSegredosForaDoAmbiente(env))).toEqual(['GIA_DOCUSIGN_SECRET']);
    expect(
      exigirSegredosForaDoAmbiente({ GIA_AMBIENTE: 'producao', GIA_AD_SENHA_ARQUIVO: '/x' }),
    ).toEqual([]);
    expect(
      exigirSegredosForaDoAmbiente({
        GIA_AMBIENTE: 'producao',
        GIA_DATABASE_URL: 'postgres://db/gia',
      }),
    ).toEqual([]);
  });

  describe('valor vindo de arquivo do cofre', () => {
    let pasta = '';
    beforeAll(async () => {
      pasta = await mkdtemp(join(tmpdir(), 'gia-segredo-'));
    });
    afterAll(async () => {
      await rm(pasta, { recursive: true, force: true });
    });

    it('lê GIA_DATABASE_URL de GIA_DATABASE_URL_ARQUIVO', async () => {
      const arquivo = join(pasta, 'db');
      await writeFile(arquivo, 'postgres://gia:x@db/gia\n');
      const env = await resolverSegredosDeArquivo({
        GIA_AMBIENTE: 'producao',
        GIA_DATABASE_URL_ARQUIVO: arquivo,
        OUTRA: '1',
      });
      expect(env['GIA_DATABASE_URL']).toBe('postgres://gia:x@db/gia');
      expect(env['OUTRA']).toBe('1');
      // O valor lido do cofre não conta como segredo passado por valor.
      expect(exigirSegredosForaDoAmbiente(env)).toEqual([]);
      expect(() => exigirSegredosForaDoAmbiente({ ...env })).toThrow('GIA_DATABASE_URL');
    });

    it('valor e arquivo ao mesmo tempo, arquivo ausente ou vazio são erro', async () => {
      const vazio = join(pasta, 'vazio');
      await writeFile(vazio, '');
      await expect(
        resolverSegredosDeArquivo({ GIA_DATABASE_URL: 'x', GIA_DATABASE_URL_ARQUIVO: vazio }),
      ).rejects.toMatchObject({ variaveis: ['GIA_DATABASE_URL'] });
      for (const caminho of [vazio, join(pasta, 'nao-existe')]) {
        await expect(
          resolverSegredosDeArquivo({ GIA_DATABASE_URL_ARQUIVO: caminho }),
        ).rejects.toMatchObject({
          variaveis: ['GIA_DATABASE_URL_ARQUIVO'],
        });
      }
    });
  });
});

describe('logs estruturados', () => {
  it('uma linha JSON por evento, com correlação e sem segredo nem dado pessoal', () => {
    const linhas: string[] = [];
    const log = criarRegistrador({
      servico: 'api',
      ambiente: 'teste',
      saida: (l) => linhas.push(l),
      agora: () => '2026-10-15T12:00:00.000Z',
    }).filho({ correlacaoId: 'c-1' });
    log.info('http_requisicao', {
      rota: '/pedidos/:pedidoId',
      status: 200,
      detalhe: 'Bearer eyJabc.defgh.ijklm cpf 123.456.789-09 maria@exemplo.com.br',
      senha: 'abc',
      login: 'maria.souza',
    });
    log.debug('ignorado');
    expect(linhas).toHaveLength(1);
    expect(JSON.parse(linhas[0]!)).toEqual({
      instante: '2026-10-15T12:00:00.000Z',
      nivel: 'info',
      servico: 'api',
      ambiente: 'teste',
      evento: 'http_requisicao',
      correlacaoId: 'c-1',
      rota: '/pedidos/:pedidoId',
      status: 200,
      detalhe: 'Bearer [OCULTO] cpf [CPF] [EMAIL]',
      senha: '[OCULTO]',
      login: '[OCULTO]',
    });
  });

  it('campo não sobrescreve os fixos do registro', () => {
    const linhas: string[] = [];
    criarRegistrador({ servico: 'worker', ambiente: 'teste', saida: (l) => linhas.push(l) }).info(
      'x',
      {
        nivel: 'debug',
        servico: 'falso',
      },
    );
    expect(JSON.parse(linhas[0]!)).toMatchObject({ nivel: 'info', servico: 'worker' });
  });
});

describe('métricas', () => {
  it('exporta contador, medidor e histograma no formato do Prometheus', () => {
    const registro = new RegistroMetricas();
    const req = registro.contador('gia_http_requisicoes_total', 'Requisições HTTP.', [
      'rota',
      'status',
    ]);
    req.incrementar({ rota: '/saude', status: '200' });
    req.incrementar({ rota: '/saude', status: '200' });
    registro.medidor('gia_escrita_externa', 'Chave mestra (1 = ligada).').definir(0);
    registro
      .histograma('gia_http_duracao_ms', 'Duração.', [10, 100], ['rota'])
      .observar(42, { rota: 'a"b' });
    expect(registro.exportar()).toBe(
      [
        '# HELP gia_http_requisicoes_total Requisições HTTP.',
        '# TYPE gia_http_requisicoes_total counter',
        'gia_http_requisicoes_total{rota="/saude",status="200"} 2',
        '# HELP gia_escrita_externa Chave mestra (1 = ligada).',
        '# TYPE gia_escrita_externa gauge',
        'gia_escrita_externa 0',
        '# HELP gia_http_duracao_ms Duração.',
        '# TYPE gia_http_duracao_ms histogram',
        'gia_http_duracao_ms_bucket{rota="a\\"b",le="10"} 0',
        'gia_http_duracao_ms_bucket{rota="a\\"b",le="100"} 1',
        'gia_http_duracao_ms_bucket{rota="a\\"b",le="+Inf"} 1',
        'gia_http_duracao_ms_sum{rota="a\\"b"} 42',
        'gia_http_duracao_ms_count{rota="a\\"b"} 1',
        '',
      ].join('\n'),
    );
    expect(() => registro.contador('Nome Inválido', 'x')).toThrow();
  });

  it('serve as métricas numa porta separada, em loopback', async () => {
    const registro = new RegistroMetricas();
    registro.contador('gia_teste_total', 'Teste.').incrementar();
    const servidor = await servirMetricas(registro, { porta: 0 });
    try {
      const { port, address } = servidor.address() as AddressInfo;
      expect(address).toBe('127.0.0.1');
      const corpo = await new Promise<string>((resolver, rejeitar) => {
        request({ host: '127.0.0.1', port, path: '/metrics' }, (res) => {
          let texto = '';
          res.on('data', (c: Buffer) => (texto += c.toString()));
          res.on('end', () => resolver(texto));
        })
          .on('error', rejeitar)
          .end();
      });
      expect(corpo).toContain('gia_teste_total 1');
    } finally {
      await new Promise((resolver) => servidor.close(resolver));
    }
  });
});
