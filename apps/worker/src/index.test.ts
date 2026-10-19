import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErroConfiguracao } from '@gia/contratos';
import { describe, expect, it } from 'vitest';
import { POLITICA_EXECUCAO_PADRAO, SISTEMAS, type Conector } from '@gia/dominio';
import {
  carregarConfiguracaoWorker,
  executarWorker,
  iniciar,
  LIMITE_POR_SISTEMA_PADRAO,
  montarConectores,
} from './index.js';
import { smokeIntegracoes } from './smoke.js';

describe('@gia/worker', () => {
  it('inicia com escrita externa desligada', () => {
    expect(iniciar({})).toContain('escrita externa desligada');
  });

  it('recusa ligar a escrita externa', () => {
    expect(() => iniciar({ GIA_ESCRITA_EXTERNA: 'true' })).toThrow(ErroConfiguracao);
  });

  it('recusa ambiente inválido', () => {
    expect(() => iniciar({ GIA_AMBIENTE: 'x' })).toThrow(ErroConfiguracao);
  });

  it('identidade e intervalo do worker vêm do ambiente, com padrões', () => {
    expect(carregarConfiguracaoWorker({})).toMatchObject({
      ambiente: 'desenvolvimento',
      escritaExterna: false,
      intervaloMs: 1_000,
    });
    expect(carregarConfiguracaoWorker({}).workerId).toMatch(/^worker-/);
    expect(
      carregarConfiguracaoWorker({ GIA_WORKER_ID: ' worker-7 ', GIA_WORKER_INTERVALO_MS: '250' }),
    ).toMatchObject({ workerId: 'worker-7', intervaloMs: 250 });
  });

  it('intervalo inválido: o erro cita só o nome da variável', () => {
    for (const valor of ['0', '-5', 'rapido', '1.5']) {
      expect(() => carregarConfiguracaoWorker({ GIA_WORKER_INTERVALO_MS: valor })).toThrow(
        new ErroConfiguracao(['GIA_WORKER_INTERVALO_MS']),
      );
    }
  });

  it('política de execução: defaults do ADR-0004 e cada parâmetro configurável', () => {
    const padrao = carregarConfiguracaoWorker({});
    expect(padrao.politica).toEqual(POLITICA_EXECUCAO_PADRAO);
    expect(padrao.limitePorSistema).toEqual({
      ad: LIMITE_POR_SISTEMA_PADRAO,
      m365: LIMITE_POR_SISTEMA_PADRAO,
      docusign: LIMITE_POR_SISTEMA_PADRAO,
      softexpert: LIMITE_POR_SISTEMA_PADRAO,
      jira: LIMITE_POR_SISTEMA_PADRAO,
    });
    const config = carregarConfiguracaoWorker({
      GIA_EXECUCAO_TIMEOUT_CONEXAO_MS: '3000',
      GIA_EXECUCAO_TIMEOUT_CHAMADA_MS: '20000',
      GIA_EXECUCAO_MAX_RETENTATIVAS: '2',
      GIA_EXECUCAO_BACKOFF_MS: '1000, 2000',
      GIA_EXECUCAO_JITTER_MAXIMO_MS: '0',
      GIA_EXECUCAO_LEASE_MS: '90000',
      GIA_EXECUCAO_RENOVACAO_LEASE_MS: '20000',
      GIA_EXECUCAO_LOTE: '4',
      GIA_EXECUCAO_ESPERA_M365_MS: '120000',
      GIA_EXECUCAO_LIMITE_POR_SISTEMA: 'ad=2, m365=1',
    });
    expect(config.politica).toEqual({
      timeoutConexaoMs: 3_000,
      timeoutChamadaMs: 20_000,
      maxRetentativas: 2,
      backoffMs: [1_000, 2_000],
      jitterMaximoMs: 0,
      duracaoLeaseMs: 90_000,
      renovacaoLeaseMs: 20_000,
      lotePorWorker: 4,
      esperaSincronizacaoM365Ms: 120_000,
    });
    expect(config.limitePorSistema).toMatchObject({
      ad: 2,
      m365: 1,
      jira: LIMITE_POR_SISTEMA_PADRAO,
    });
    expect(
      carregarConfiguracaoWorker({ GIA_EXECUCAO_LIMITE_POR_SISTEMA: '3' }).limitePorSistema,
    ).toEqual({ ad: 3, m365: 3, docusign: 3, softexpert: 3, jira: 3 });
  });

  it('política inválida: o erro cita só as variáveis, nunca os valores', () => {
    const casos: [Record<string, string>, string[]][] = [
      [{ GIA_EXECUCAO_LEASE_MS: 'dois minutos' }, ['GIA_EXECUCAO_LEASE_MS']],
      [{ GIA_EXECUCAO_LOTE: '0' }, ['GIA_EXECUCAO_LOTE']],
      [{ GIA_EXECUCAO_BACKOFF_MS: '5000,abc' }, ['GIA_EXECUCAO_BACKOFF_MS']],
      // Menos esperas do que retentativas.
      [{ GIA_EXECUCAO_MAX_RETENTATIVAS: '5' }, ['GIA_EXECUCAO_BACKOFF_MS']],
      // Renovar depois de vencer não protege nada.
      [{ GIA_EXECUCAO_RENOVACAO_LEASE_MS: '120000' }, ['GIA_EXECUCAO_RENOVACAO_LEASE_MS']],
      // Conexão maior que a chamada inteira.
      [{ GIA_EXECUCAO_TIMEOUT_CONEXAO_MS: '60000' }, ['GIA_EXECUCAO_TIMEOUT_CONEXAO_MS']],
      // Uma chamada não pode durar mais que o lease que a protege.
      [{ GIA_EXECUCAO_TIMEOUT_CHAMADA_MS: '120000' }, ['GIA_EXECUCAO_TIMEOUT_CHAMADA_MS']],
      [{ GIA_EXECUCAO_LIMITE_POR_SISTEMA: 'ad=0' }, ['GIA_EXECUCAO_LIMITE_POR_SISTEMA']],
      [{ GIA_EXECUCAO_LIMITE_POR_SISTEMA: 'sap=2' }, ['GIA_EXECUCAO_LIMITE_POR_SISTEMA']],
      [{ GIA_AMBIENTE: 'x', GIA_EXECUCAO_LOTE: 'muitos' }, ['GIA_AMBIENTE', 'GIA_EXECUCAO_LOTE']],
    ];
    for (const [env, variaveis] of casos) {
      expect(() => carregarConfiguracaoWorker(env), JSON.stringify(env)).toThrow(
        new ErroConfiguracao(variaveis),
      );
    }
  });

  it('o timeout de conexão configurado é o que os conectores usam, não o padrão de 5 s', async () => {
    const lentos = (env: Record<string, string>) => {
      const catalogo = montarConectores(carregarConfiguracaoWorker(env).politica);
      for (const sistema of SISTEMAS) {
        catalogo.simuladores[sistema].testar = () => new Promise((r) => setTimeout(r, 200));
      }
      return catalogo;
    };
    const configurado = lentos({ GIA_EXECUCAO_TIMEOUT_CONEXAO_MS: '50' });
    const padrao = lentos({});
    for (const sistema of SISTEMAS) {
      expect(await configurado.conectores[sistema].testarConexao(), sistema).toMatchObject({
        disponivel: false,
        codigo: 'TIMEOUT',
      });
      expect(await padrao.conectores[sistema].testarConexao(), sistema).toMatchObject({
        disponivel: true,
      });
    }
  });

  it('produção recusa verificação TLS desligada (M6), citando só o nome', async () => {
    const env = { GIA_AMBIENTE: 'producao', NODE_TLS_REJECT_UNAUTHORIZED: '0' };
    expect(() => iniciar(env)).toThrow('Configuração inválida: NODE_TLS_REJECT_UNAUTHORIZED');
    const linhas: string[] = [];
    await expect(
      executarWorker(env, new AbortController().signal, (l) => linhas.push(l)),
    ).rejects.toThrow('Configuração inválida: NODE_TLS_REJECT_UNAUTHORIZED');
    // Recusa antes de ler o cofre, abrir conectores ou o banco: nada foi registrado.
    expect(linhas).toEqual([]);
    await expect(smokeIntegracoes(env, true)).rejects.toThrow(
      'Configuração inválida: NODE_TLS_REJECT_UNAUTHORIZED',
    );
  });

  it('fora de produção o worker sobe com TLS desligado e registra o aviso na partida', async () => {
    const env = { GIA_AMBIENTE: 'teste', NODE_TLS_REJECT_UNAUTHORIZED: '0' };
    expect(iniciar(env)).toContain('escrita externa desligada');
    const linhas: string[] = [];
    // Sem banco o worker para logo depois; o aviso já saiu na partida.
    await expect(
      executarWorker(env, new AbortController().signal, (l) => linhas.push(l)),
    ).rejects.toThrow('GIA_DATABASE_URL');
    expect(linhas.map((l) => JSON.parse(l) as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({
        evento: 'tls_verificacao_desligada',
        nivel: 'aviso',
        variaveis: ['NODE_TLS_REJECT_UNAUTHORIZED'],
      }),
    );
  });

  it('worker e smoke em produção recusam TLS desligado antes de ler o cofre (M6, ordem)', async () => {
    const ausente = join(tmpdir(), `gia-cofre-ausente-${randomUUID()}`);
    const comCofre = { GIA_AMBIENTE: 'producao', GIA_DATABASE_URL_ARQUIVO: ausente };
    const erroDe = (promessa: Promise<unknown>) =>
      promessa.then(
        () => new Error('não deveria concluir'),
        (e: unknown) => e,
      );
    const sinal = new AbortController().signal;
    // Controle: com a verificação ligada, os dois chegam ao cofre e falham nele.
    for (const erro of [
      await erroDe(executarWorker(comCofre, sinal, () => undefined)),
      await erroDe(smokeIntegracoes(comCofre, true)),
    ]) {
      expect(erro).toBeInstanceOf(ErroConfiguracao);
      expect((erro as ErroConfiguracao).variaveis).toEqual(['GIA_DATABASE_URL_ARQUIVO']);
    }
    const desligado = { ...comCofre, NODE_TLS_REJECT_UNAUTHORIZED: '0' };
    for (const erro of [
      await erroDe(executarWorker(desligado, sinal, () => undefined)),
      await erroDe(smokeIntegracoes(desligado, true)),
    ]) {
      expect(erro).toBeInstanceOf(ErroConfiguracao);
      expect((erro as ErroConfiguracao).variaveis).toEqual(['NODE_TLS_REJECT_UNAUTHORIZED']);
      expect((erro as Error).message).not.toContain(ausente);
    }
  });

  it('fora de produção o smoke roda com TLS desligado, avisa e não dá validado (M6)', async () => {
    const desligado = await smokeIntegracoes(
      { GIA_AMBIENTE: 'teste', NODE_TLS_REJECT_UNAUTHORIZED: '0' },
      true,
    );
    expect(desligado.avisos).toEqual(['tls_verificacao_desligada']);
    expect(desligado.validado).toBe(false);
    const ligado = await smokeIntegracoes({ GIA_AMBIENTE: 'teste' }, true);
    expect(ligado.avisos).toEqual([]);
  });

  it('smoke de leitura: só a verificação TLS desligada emite o aviso e tira o validado (M6)', async () => {
    // Cinco conectores que respondem disponíveis, sem rede: com TLS ligado o
    // smoke de leitura valida; a única diferença entre os dois casos é o TLS.
    const chamadas: string[] = [];
    const disponiveis = async () =>
      Object.fromEntries(
        SISTEMAS.map((sistema) => [
          sistema,
          {
            testarConexao: async () => {
              chamadas.push(sistema);
              return { modo: 'real', disponivel: true, codigo: 'OK', mensagem: 'ok' } as const;
            },
          } as unknown as Conector,
        ]),
      );
    const env = { GIA_AMBIENTE: 'teste' };

    const ligado = await smokeIntegracoes(env, false, disponiveis);
    expect(ligado.escopo).toBe('leitura');
    expect(ligado.sistemas.every((s) => s.status === 'disponivel')).toBe(true);
    expect(ligado.validado).toBe(true);
    expect(ligado.avisos).toEqual([]);

    for (const valor of ['1', '']) {
      const outro = await smokeIntegracoes(
        { ...env, NODE_TLS_REJECT_UNAUTHORIZED: valor },
        false,
        disponiveis,
      );
      expect(outro.avisos).toEqual([]);
      expect(outro.validado).toBe(true);
    }

    chamadas.length = 0;
    const desligado = await smokeIntegracoes(
      { ...env, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
      false,
      disponiveis,
    );
    // As leituras rodaram e responderam disponíveis; mesmo assim não valida.
    expect(chamadas.sort()).toEqual([...SISTEMAS].sort());
    expect(desligado.sistemas.every((s) => s.status === 'disponivel')).toBe(true);
    expect(desligado.avisos).toEqual(['tls_verificacao_desligada']);
    expect(desligado.validado).toBe(false);
    // O relatório não carrega o valor da variável.
    expect(JSON.stringify(desligado)).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
  });

  it('sem URL do banco o worker não sobe', async () => {
    await expect(executarWorker({}, new AbortController().signal, () => undefined)).rejects.toThrow(
      'Configuração inválida: GIA_DATABASE_URL',
    );
  });
});
