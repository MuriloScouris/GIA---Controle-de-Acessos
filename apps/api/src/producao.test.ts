import {
  ErroConfiguracao,
  RegistroMetricas,
  carregarGatesDeEscrita,
  criarRegistrador,
  liberacaoDosGates,
  prontidaoPublicaRespostaSchema,
  prontidaoRespostaSchema,
  respostaErroSchema,
  respostaSucessoSchema,
  resultadoImportacaoSchema,
  resultadoItensSchema,
} from '@gia/contratos';
import { configuracaoPadrao } from '@gia/dominio';
import { describe, expect, it } from 'vitest';
import { CABECALHO_CORRELACAO, prontidaoDetalhadaDe } from './http/observabilidade.js';
import { criarAppDoAmbiente } from './index.js';
import { criarPersistenciaEmMemoria } from './persistencia/memoria.js';
import { prepararAmbienteApi, proxiesConfiaveis } from './producao.js';
import { montarApi } from './teste/apoio.js';

function variaveis(acao: () => unknown): readonly string[] {
  try {
    acao();
  } catch (erro) {
    if (erro instanceof ErroConfiguracao) return erro.variaveis;
    throw erro;
  }
  throw new Error('esperava erro de configuração');
}

function comLogs() {
  const linhas: Record<string, unknown>[] = [];
  const registrador = criarRegistrador({
    servico: 'api',
    ambiente: 'teste',
    saida: (linha) => linhas.push(JSON.parse(linha) as Record<string, unknown>),
  });
  return { linhas, registrador };
}

describe('configuração segura por ambiente', () => {
  it('produção exige PostgreSQL: memória perderia a fila e a auditoria', () => {
    expect(
      variaveis(() => prepararAmbienteApi({ GIA_AMBIENTE: 'producao' }, () => undefined)),
    ).toEqual(['GIA_DATABASE_URL']);
  });

  it('escrita real exige PostgreSQL também fora de produção', () => {
    expect(
      variaveis(() =>
        prepararAmbienteApi(
          { GIA_AMBIENTE: 'teste', GIA_ESCRITA_EXTERNA: 'true' },
          () => undefined,
        ),
      ),
    ).toEqual(['GIA_DATABASE_URL']);
  });

  it('produção recusa segredo passado por valor e cita só os nomes', () => {
    const erro = variaveis(() =>
      prepararAmbienteApi(
        {
          GIA_AMBIENTE: 'producao',
          GIA_DATABASE_URL: 'postgres://gia:senha-de-teste@db/gia',
          GIA_JIRA_API_TOKEN: 'token-de-teste',
        },
        () => undefined,
      ),
    );
    expect(erro).toEqual(['GIA_DATABASE_URL', 'GIA_JIRA_API_TOKEN']);
  });

  it('produção recusa verificação TLS desligada (M6), junto dos demais erros, só com os nomes', () => {
    expect(
      variaveis(() =>
        prepararAmbienteApi(
          {
            GIA_AMBIENTE: 'producao',
            GIA_DATABASE_URL: 'postgres://db/gia',
            NODE_TLS_REJECT_UNAUTHORIZED: '0',
          },
          () => undefined,
        ),
      ),
    ).toEqual(['NODE_TLS_REJECT_UNAUTHORIZED']);
    expect(
      variaveis(() =>
        prepararAmbienteApi(
          { GIA_AMBIENTE: 'producao', NODE_TLS_REJECT_UNAUTHORIZED: '0' },
          () => undefined,
        ),
      ),
    ).toEqual(['GIA_DATABASE_URL', 'NODE_TLS_REJECT_UNAUTHORIZED']);
  });

  it('fora de produção a API sobe com TLS desligado e registra o aviso na partida', () => {
    for (const ambiente of ['desenvolvimento', 'teste']) {
      const linhas: Record<string, unknown>[] = [];
      const pronto = prepararAmbienteApi(
        { GIA_AMBIENTE: ambiente, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
        (linha) => linhas.push(JSON.parse(linha) as Record<string, unknown>),
      );
      expect(pronto.config.ambiente).toBe(ambiente);
      expect(linhas.find((l) => l['evento'] === 'tls_verificacao_desligada')).toMatchObject({
        nivel: 'aviso',
        variaveis: ['NODE_TLS_REJECT_UNAUTHORIZED'],
      });
    }
    // Com a verificação ligada, nenhum aviso.
    const linhas: string[] = [];
    prepararAmbienteApi({ GIA_AMBIENTE: 'teste', NODE_TLS_REJECT_UNAUTHORIZED: '1' }, (linha) =>
      linhas.push(linha),
    );
    expect(linhas.join('\n')).not.toContain('tls_verificacao_desligada');
  });

  it('registra na partida o estado dos gates (auditoria operacional), sem segredo', () => {
    const linhas: string[] = [];
    prepararAmbienteApi(
      {
        GIA_AMBIENTE: 'teste',
        GIA_ESCRITA_EXTERNA: 'true',
        GIA_ESCRITA_LIBERADA: 'ad:criar',
        GIA_DATABASE_URL: 'postgres://db/gia',
        GIA_VERSAO: 'abc123',
      },
      (linha) => linhas.push(linha),
    );
    expect(JSON.parse(linhas.at(-1)!)).toMatchObject({
      evento: 'api_configurada',
      versao: 'abc123',
      modoExecucao: 'real',
      escritaExterna: true,
      escritaLiberada: ['ad:criar'],
      persistencia: 'postgres',
    });
  });

  it('sem configuração, a API do ambiente sobe como antes: memória e escrita desligada', async () => {
    const app = criarAppDoAmbiente({ GIA_LOG_NIVEL: 'erro' });
    const res = await app.inject({ method: 'GET', url: '/saude/pronta' });
    expect(prontidaoPublicaRespostaSchema.parse(res.json())).toEqual({ status: 'pronta' });
    // O estado da escrita só sai na avaliação detalhada (porta interna).
    const detalhada = await prontidaoDetalhadaDe(app)!();
    expect(prontidaoRespostaSchema.parse(detalhada.corpo).escrita).toEqual({
      modo: 'simulado',
      liberadas: [],
    });
    await app.close();
  });
});

describe('proxies confiáveis do limite de login (GIA_API_PROXY_CONFIAVEL, M8)', () => {
  it('padrão: nenhum proxy confiável, então o X-Forwarded-For é ignorado', () => {
    expect(proxiesConfiaveis(undefined)).toEqual([]);
    expect(proxiesConfiaveis('  ')).toEqual([]);
    expect(prepararAmbienteApi({}, () => undefined).proxiesConfiaveis).toEqual([]);
  });

  it('aceita IPs e CIDRs, v4 e v6, e leva a lista ao ambiente da API', () => {
    expect(proxiesConfiaveis('127.0.0.1, ::1,10.0.0.0/8 ,2001:db8::/32')).toEqual([
      '127.0.0.1',
      '::1',
      '10.0.0.0/8',
      '2001:db8::/32',
    ]);
    const ambiente = prepararAmbienteApi({ GIA_API_PROXY_CONFIAVEL: '127.0.0.1' }, () => undefined);
    expect(ambiente.proxiesConfiaveis).toEqual(['127.0.0.1']);
  });

  it('recusa contagem de saltos, nomes, palavras-chave e redes largas demais', () => {
    for (const ruim of [
      '1',
      'loopback',
      'proxy.interno',
      '127.0.0.1,',
      '0.0.0.0/0',
      '::/0',
      '10.0.0.0/7',
      '10.0.0.0/33',
      '2001:db8::/15',
      '10.0.0.0/8/8',
      '10.0.0.0/x',
      '999.1.1.1',
    ]) {
      expect(proxiesConfiaveis(ruim), ruim).toBe('invalido');
    }
  });

  it('valor inválido derruba a partida citando só o nome da variável', () => {
    expect(
      variaveis(() =>
        prepararAmbienteApi({ GIA_API_PROXY_CONFIAVEL: '0.0.0.0/0' }, () => undefined),
      ),
    ).toEqual(['GIA_API_PROXY_CONFIAVEL']);
  });
});

describe('health checks', () => {
  it('/saude é vivacidade; /saude/pronta pública verifica a persistência e mostra só o status', async () => {
    const { app } = montarApi({ versao: 'v-teste' });
    expect((await app.inject({ method: 'GET', url: '/saude' })).json()).toEqual({ status: 'ok' });
    const pronta = await app.inject({ method: 'GET', url: '/saude/pronta' });
    expect(pronta.statusCode).toBe(200);
    // M7: nada de ambiente, versão, verificações ou gates na porta pública.
    expect(pronta.json()).toEqual({ status: 'pronta' });
    expect(pronta.headers['cache-control']).toBe('no-store');
    expect(pronta.headers['x-content-type-options']).toBe('nosniff');
    // O detalhe continua disponível para a porta interna, com o mesmo contrato.
    const detalhada = await prontidaoDetalhadaDe(app)!();
    expect(detalhada.codigo).toBe(200);
    expect(prontidaoRespostaSchema.parse(detalhada.corpo)).toEqual({
      status: 'pronta',
      ambiente: 'teste',
      versao: 'v-teste',
      verificacoes: { persistencia: 'ok' },
      escrita: { modo: 'simulado', liberadas: [] },
    });
  });

  it('a prontidão pública é a mesma com ou sem sessão, até para o Administrador do Gia', async () => {
    const gates = carregarGatesDeEscrita({
      GIA_AMBIENTE: 'teste',
      GIA_ESCRITA_EXTERNA: 'true',
      GIA_ESCRITA_LIBERADA: 'ad:criar',
    });
    const api = montarApi({ versao: 'v-secreta-123', gates });
    const anonima = await api.app.inject({ method: 'GET', url: '/saude/pronta' });
    for (const papel of ['administradorGia', 'administradorTecnico', 'auditor'] as const) {
      const cookie = await api.entrar(papel);
      const comSessao = await api.app.inject({
        method: 'GET',
        url: '/saude/pronta',
        headers: { cookie },
      });
      expect(comSessao.json()).toEqual(anonima.json());
    }
    expect(anonima.json()).toEqual({ status: 'pronta' });
    // Nem versão, nem ambiente, nem a escrita ligada e liberada vazam.
    for (const vazamento of ['v-secreta-123', 'teste', 'real', 'ad:criar', 'persistencia'])
      expect(anonima.body).not.toContain(vazamento);
  });

  it('dependência que falha ou não responde deixa a API indisponível (503)', async () => {
    const { linhas, registrador } = comLogs();
    const { app } = montarApi({
      registrador,
      verificacoes: {
        banco: () => Promise.reject(new Error('conexão recusada em postgres://gia:x@db')),
        lenta: () => new Promise(() => undefined),
      },
    });
    const res = await app.inject({ method: 'GET', url: '/saude/pronta' });
    expect(res.statusCode).toBe(503);
    // Pública: só o status; quais dependências falharam fica no log e na porta interna.
    expect(res.json()).toEqual({ status: 'indisponivel' });
    const detalhada = await prontidaoDetalhadaDe(app)!();
    expect(detalhada.codigo).toBe(503);
    expect(prontidaoRespostaSchema.parse(detalhada.corpo)).toMatchObject({
      status: 'indisponivel',
      verificacoes: { persistencia: 'ok', banco: 'falha', lenta: 'falha' },
    });
    expect(linhas.find((l) => l['evento'] === 'prontidao_falhou')).toMatchObject({
      verificacoes: ['banco', 'lenta'],
    });
    expect(JSON.stringify(linhas)).not.toContain('gia:x');
  });
});

describe('logs estruturados com correlação e métricas', () => {
  it('cada resposta leva um ID de correlação gerado pela API, igual ao do log', async () => {
    const { linhas, registrador } = comLogs();
    const { app } = montarApi({ registrador });
    const res = await app.inject({
      method: 'GET',
      url: '/pedidos',
      headers: { [CABECALHO_CORRELACAO]: 'forjado-pelo-cliente', 'x-request-id': 'forjado' },
    });
    const correlacao = res.headers[CABECALHO_CORRELACAO];
    expect(correlacao).toMatch(/^[0-9a-f-]{36}$/);
    expect(linhas.at(-1)).toEqual({
      instante: expect.any(String),
      nivel: 'info',
      servico: 'api',
      ambiente: 'teste',
      evento: 'http_requisicao',
      correlacaoId: correlacao,
      metodo: 'GET',
      rota: '/pedidos',
      status: 401,
      duracaoMs: expect.any(Number),
    });
    const outra = await app.inject({ method: 'GET', url: '/pedidos' });
    expect(outra.headers[CABECALHO_CORRELACAO]).not.toBe(correlacao);
  });

  it('o log usa a rota declarada, nunca a URL com identificadores, e não loga as sondas', async () => {
    const { linhas, registrador } = comLogs();
    const api = montarApi({ registrador });
    const cookie = await api.entrar('revisor');
    await api.get(cookie, '/pedidos/11111111-1111-4111-8111-111111111111');
    await api.app.inject({ method: 'GET', url: '/saude' });
    const acessos = linhas.filter((l) => l['evento'] === 'http_requisicao');
    expect(acessos.map((l) => l['rota'])).toEqual(['/sessao/simulada', '/pedidos/:pedidoId']);
    expect(JSON.stringify(linhas)).not.toContain('11111111-1111');
  });

  it('erro interno vira 500 genérico, com o tipo do erro no log e nada da mensagem', async () => {
    const { linhas, registrador } = comLogs();
    const persistencia = criarPersistenciaEmMemoria();
    const api = montarApi({
      registrador,
      persistencia: {
        ...persistencia,
        executar: () => Promise.reject(new TypeError('falha com cpf 123.456.789-09')),
      },
    });
    const res = await api.get(await api.entrar('revisor'), '/pedidos');
    expect(res.statusCode).toBe(500);
    expect(respostaErroSchema.parse(res.json()).codigo).toBe('ERRO_INTERNO');
    expect(linhas.find((l) => l['evento'] === 'erro_interno')).toMatchObject({
      erro: 'TypeError',
      correlacaoId: res.headers[CABECALHO_CORRELACAO],
    });
    expect(JSON.stringify(linhas)).not.toMatch(/123\.456|falha com/);
  });

  it('conta requisições, duração e 5xx por rota declarada, e expõe o estado dos gates', async () => {
    const metricas = new RegistroMetricas();
    const { app } = montarApi({ metricas });
    await app.inject({ method: 'GET', url: '/saude' });
    await app.inject({ method: 'GET', url: '/saude' });
    await app.inject({ method: 'GET', url: '/nao-existe/123' });
    const texto = metricas.exportar();
    expect(texto).toContain('gia_api_requisicoes_total{metodo="GET",rota="/saude",status="200"} 2');
    expect(texto).toContain(
      'gia_api_requisicoes_total{metodo="GET",rota="nao_encontrada",status="404"} 1',
    );
    expect(texto).toContain('gia_api_duracao_ms_count{metodo="GET",rota="/saude"} 2');
    expect(texto).toContain('gia_escrita_externa_ligada 0');
    expect(texto).not.toContain('/nao-existe/123');
  });
});

describe('gates explícitos de escrita externa no fluxo', () => {
  async function pedidoAprovado(gates = carregarGatesDeEscrita({})) {
    const persistencia = criarPersistenciaEmMemoria({
      ...configuracaoPadrao(),
      liberacaoEscrita: liberacaoDosGates(gates),
    });
    const api = montarApi({ gates, persistencia });
    const revisor = await api.entrar('revisor');
    const relatorio = resultadoImportacaoSchema.parse((await api.importar(revisor)).json());
    const criado = relatorio.criados.find((c) => c.chave === 'RH-1001')!;
    const aprovado = respostaSucessoSchema.parse(
      (
        await api.comando(revisor, criado.pedidoId, {
          pedidoId: criado.pedidoId,
          versaoEsperada: criado.versao,
          acao: 'aprovar',
          dados: {},
        })
      ).json(),
    );
    const executor = await api.entrar('executor');
    const itens = resultadoItensSchema.parse(
      (await api.get(executor, `/pedidos/${criado.pedidoId}/itens`)).json(),
    ).itens;
    const solicitar = (itemIds?: string[]) =>
      api.comando(executor, criado.pedidoId, {
        pedidoId: criado.pedidoId,
        versaoEsperada: aprovado.versao,
        acao: 'solicitarExecucao',
        dados: itemIds === undefined ? {} : { itemIds },
      });
    return { api, persistencia, itens, solicitar };
  }

  it('desligado (padrão): toda execução nasce simulada', async () => {
    const { persistencia, solicitar } = await pedidoAprovado();
    expect((await solicitar()).statusCode).toBe(202);
    expect(new Set(persistencia.espiar.operacoes().map((op) => op.modo))).toEqual(
      new Set(['simulado']),
    );
  });

  it('ligado: só o sistema/operação liberado vira operação real; o resto é recusado pelo domínio', async () => {
    const gates = carregarGatesDeEscrita({
      GIA_AMBIENTE: 'teste',
      GIA_ESCRITA_EXTERNA: 'true',
      GIA_ESCRITA_LIBERADA: 'ad:criar',
    });
    const { persistencia, itens, solicitar } = await pedidoAprovado(gates);
    const todos = await solicitar();
    expect(todos.statusCode).toBe(422);
    expect(respostaErroSchema.parse(todos.json())).toMatchObject({
      codigo: 'ESCRITA_NAO_LIBERADA',
      detalhes: { sistemas: ['m365', 'docusign', 'softexpert', 'jira'] },
    });
    expect(persistencia.espiar.operacoes()).toEqual([]);

    const ad = itens.find((item) => item.sistema === 'ad')!;
    expect((await solicitar([ad.id])).statusCode).toBe(202);
    expect(persistencia.espiar.operacoes().map((op) => [op.sistema, op.modo])).toEqual([
      ['ad', 'real'],
    ]);
  });
});
