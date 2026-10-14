import {
  listaPedidosSchema,
  pedidoDetalheSchema,
  respostaErroSchema,
  respostaSucessoSchema,
  resultadoImportacaoSchema,
  type PapelHumano,
} from '@gia/contratos';
import { describe, expect, it } from 'vitest';
import { DURACAO_SESSAO_MS, PESSOAS_FICTICIAS } from './sessao/sessoes-simuladas.js';
import { cpfFicticio } from './simuladores/cpf-ficticio.js';
import { CSRF, montarApi, type ApiDeTeste } from './teste/apoio.js';

function codigo(res: { json(): unknown }): string {
  return respostaErroSchema.parse(res.json()).codigo;
}

/** Importa como revisor e devolve o pedido celetista RH-1001 com sua versão. */
async function prepararPedido(api: ApiDeTeste): Promise<{ pedidoId: string; versao: number }> {
  const revisor = await api.entrar('revisor');
  const relatorio = resultadoImportacaoSchema.parse((await api.importar(revisor)).json());
  const criado = relatorio.criados.find((c) => c.chave === 'RH-1001');
  if (!criado) throw new Error('RH-1001 não importado');
  return { pedidoId: criado.pedidoId, versao: criado.versao };
}

async function aprovarComo(api: ApiDeTeste, papel: PapelHumano, pedidoId: string, versao: number) {
  return api.comando(await api.entrar(papel), pedidoId, {
    pedidoId,
    versaoEsperada: versao,
    acao: 'aprovar',
    dados: {},
  });
}

describe('usuário não autenticado', () => {
  it('sem sessão, com sessão forjada ou expirada recebe 401 e nada é lido do Jira', async () => {
    const api = montarApi();
    const { pedidoId } = await prepararPedido(api);
    const leituras = api.leiturasJira();

    for (const cookie of [null, 'gia_sessao=inventada', 'outro=valor']) {
      const lista = await api.get(cookie, '/pedidos');
      expect(lista.statusCode).toBe(401);
      expect(codigo(lista)).toBe('NAO_AUTENTICADO');
      expect((await api.get(cookie, `/pedidos/${pedidoId}`)).statusCode).toBe(401);
      expect((await api.post(cookie, '/importacoes/jira', {})).statusCode).toBe(401);
      expect(
        (
          await api.comando(cookie ?? '', pedidoId, {
            pedidoId,
            versaoEsperada: 2,
            acao: 'aprovar',
            dados: {},
          })
        ).statusCode,
      ).toBe(401);
    }
    expect(api.leiturasJira()).toBe(leituras);

    const revisor = await api.entrar('revisor');
    expect((await api.get(revisor, '/pedidos')).statusCode).toBe(200);
    api.avancar(DURACAO_SESSAO_MS);
    // Expiração absoluta: a sessão não é renovada pelo uso.
    expect(codigo(await api.get(revisor, '/pedidos'))).toBe('NAO_AUTENTICADO');
  });

  it('logout encerra a sessão no servidor', async () => {
    const api = montarApi();
    const revisor = await api.entrar('revisor');
    const sessao = await api.get(revisor, '/sessao');
    expect(sessao.json()).toMatchObject({
      usuarioId: PESSOAS_FICTICIAS.revisor.usuarioId,
      papeis: ['revisor'],
    });
    const saida = await api.app.inject({
      method: 'DELETE',
      url: '/sessao',
      headers: { ...CSRF, cookie: revisor },
    });
    expect(saida.statusCode).toBe(204);
    expect(String(saida.headers['set-cookie'])).toContain('Max-Age=0');
    expect((await api.get(revisor, '/pedidos')).statusCode).toBe(401);
  });

  it('o cookie de sessão é HttpOnly, Secure e SameSite=Strict, e o corpo não traz o identificador', async () => {
    const api = montarApi();
    const res = await api.post(null, '/sessao/simulada', { papel: 'executor' });
    expect(res.statusCode).toBe(201);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^gia_sessao=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    const id = cookie.split(';')[0]?.split('=')[1] ?? '';
    expect(res.body).not.toContain(id);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('em produção não há login simulado: só o OIDC (futuro) abre sessão', async () => {
    const api = montarApi({ ambiente: 'producao' });
    const res = await api.post(null, '/sessao/simulada', { papel: 'administradorGia' });
    expect(res.statusCode).toBe(404);
    expect((await api.get(null, '/pedidos')).statusCode).toBe(401);
  });
});

describe('CSRF nas escritas', () => {
  it('escrita sem o cabeçalho de proteção é recusada antes de qualquer efeito', async () => {
    const api = montarApi();
    const revisor = await api.entrar('revisor');
    const res = await api.post(revisor, '/importacoes/jira', {}, {});
    expect(res.statusCode).toBe(403);
    expect(codigo(res)).toBe('CSRF_INVALIDO');
    expect(api.leiturasJira()).toBe(0);
    expect((await api.post(null, '/sessao/simulada', { papel: 'revisor' }, {})).statusCode).toBe(
      403,
    );
  });
});

describe('ator vem da sessão (regra 13)', () => {
  it('ator no corpo do comando é recusado, em qualquer nível', async () => {
    const api = montarApi();
    const { pedidoId, versao } = await prepararPedido(api);
    const revisor = await api.entrar('revisor');
    for (const corpo of [
      { pedidoId, versaoEsperada: versao, acao: 'aprovar', dados: {}, ator: 'outra-pessoa' },
      { pedidoId, versaoEsperada: versao, acao: 'aprovar', dados: { aprovadoPor: 'x' } },
      {
        pedidoId,
        versaoEsperada: versao,
        acao: 'rejeitar',
        dados: { motivo: 'm', usuarioId: 'x' },
      },
    ]) {
      const res = await api.comando(revisor, pedidoId, corpo);
      expect(res.statusCode).toBe(400);
      expect(codigo(res)).toBe('ATOR_INFORMADO_PELO_CLIENTE');
    }
    // Login simulado também não aceita identidade vinda do cliente.
    const login = await api.post(null, '/sessao/simulada', {
      papel: 'revisor',
      usuarioId: PESSOAS_FICTICIAS.administradorGia.usuarioId,
    });
    expect(codigo(login)).toBe('ATOR_INFORMADO_PELO_CLIENTE');
    // O serviço executor é identidade técnica do worker; não abre sessão humana.
    const servico = await api.post(null, '/sessao/simulada', { papel: 'servicoExecutor' });
    expect(codigo(servico)).toBe('DADO_INVALIDO');
  });

  it('cabeçalhos do cliente não mudam o ator nem a correlação gravados', async () => {
    const api = montarApi();
    const revisor = await api.entrar('revisor');
    await api.post(
      revisor,
      '/importacoes/jira',
      {},
      {
        ...CSRF,
        'x-ator': PESSOAS_FICTICIAS.administradorGia.usuarioId,
        'request-id': 'correlacao-forjada',
      },
    );
    const eventos = api.persistencia.espiar.eventos();
    expect(eventos.length).toBeGreaterThan(0);
    for (const evento of eventos) {
      expect(evento.ator?.id).toBe(PESSOAS_FICTICIAS.revisor.usuarioId);
      expect(evento.correlacaoId).not.toBe('correlacao-forjada');
    }
  });
});

describe('permissão negada no servidor', () => {
  it.each<[PapelHumano, Record<string, unknown>]>([
    ['solicitante', { acao: 'aprovar', dados: {} }],
    ['executor', { acao: 'aprovar', dados: {} }],
    ['auditor', { acao: 'rejeitar', dados: { motivo: 'sem permissão' } }],
    ['administradorTecnico', { acao: 'aprovar', dados: {} }],
    ['executor', { acao: 'editarProposta', dados: {} }],
    ['solicitante', { acao: 'recalcularIdentidade', dados: {} }],
    ['revisor', { acao: 'solicitarExecucao', dados: {} }],
    [
      'revisor',
      {
        acao: 'registrarAcessoManual',
        dados: { itemId: PESSOAS_FICTICIAS.revisor.usuarioId, observacao: 'x' },
      },
    ],
    ['auditor', { acao: 'solicitarExecucao', dados: {} }],
  ])('%s não pode %j', async (papel, comando) => {
    const api = montarApi();
    const { pedidoId, versao } = await prepararPedido(api);
    const eventosAntes = api.persistencia.espiar.eventos().length;
    const res = await api.comando(await api.entrar(papel), pedidoId, {
      pedidoId,
      versaoEsperada: versao,
      ...comando,
    });
    expect(res.statusCode).toBe(403);
    expect(codigo(res)).toBe('PERMISSAO_NEGADA');
    expect(api.persistencia.espiar.eventos()).toHaveLength(eventosAntes);
    expect(api.persistencia.espiar.pedidos()[0]?.versao).toBe(versao);
  });

  it.each<PapelHumano>(['auditor', 'administradorTecnico'])(
    '%s não importa chamados do Jira',
    async (papel) => {
      const api = montarApi();
      const res = await api.importar(await api.entrar(papel));
      expect(res.statusCode).toBe(403);
      expect(codigo(res)).toBe('PERMISSAO_NEGADA');
      expect(api.leiturasJira()).toBe(0);
    },
  );

  it('permissão é checada antes de procurar o pedido (403 não revela se ele existe)', async () => {
    const api = montarApi();
    const inexistente = '5e0f6a10-0000-4000-8000-0000000000ff';
    const res = await aprovarComo(api, 'executor', inexistente, 1);
    expect(res.statusCode).toBe(403);
    const revisor = await aprovarComo(api, 'revisor', inexistente, 1);
    expect(revisor.statusCode).toBe(404);
  });

  it('administrador técnico não acompanha pedidos', async () => {
    const api = montarApi();
    const res = await api.get(await api.entrar('administradorTecnico'), '/pedidos');
    expect(res.statusCode).toBe(403);
  });
});

describe('guardas de versão e de status', () => {
  it('versão desatualizada devolve 409 e não grava nada', async () => {
    const api = montarApi();
    const { pedidoId, versao } = await prepararPedido(api);
    const eventosAntes = api.persistencia.espiar.eventos().length;
    const res = await aprovarComo(api, 'revisor', pedidoId, versao - 1);
    expect(res.statusCode).toBe(409);
    const erro = respostaErroSchema.parse(res.json());
    expect(erro).toMatchObject({
      codigo: 'CONFLITO_DE_VERSAO',
      detalhes: { versaoAtual: versao, versaoEsperada: versao - 1 },
    });
    expect(api.persistencia.espiar.eventos()).toHaveLength(eventosAntes);
    expect(api.persistencia.espiar.pedidos()[0]?.status).toBe('pendenteAprovacao');
  });

  it('dois operadores com a mesma versão: só o primeiro grava', async () => {
    const api = montarApi();
    const { pedidoId, versao } = await prepararPedido(api);
    const revisor = await api.entrar('revisor');
    const admin = await api.entrar('administradorGia');
    const [a, b] = await Promise.all([
      api.comando(revisor, pedidoId, {
        pedidoId,
        versaoEsperada: versao,
        acao: 'aprovar',
        dados: {},
      }),
      api.comando(admin, pedidoId, {
        pedidoId,
        versaoEsperada: versao,
        acao: 'rejeitar',
        dados: { motivo: 'Duplicidade.' },
      }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  });

  it('não solicita execução de pedido pendente nem aprova de novo', async () => {
    const api = montarApi();
    const { pedidoId, versao } = await prepararPedido(api);
    const executor = await api.entrar('executor');
    const execucao = await api.comando(executor, pedidoId, {
      pedidoId,
      versaoEsperada: versao,
      acao: 'solicitarExecucao',
      dados: {},
    });
    expect(execucao.statusCode).toBe(422);
    expect(codigo(execucao)).toBe('TRANSICAO_INVALIDA');

    const aprovado = respostaSucessoSchema.parse(
      (await aprovarComo(api, 'revisor', pedidoId, versao)).json(),
    );
    const deNovo = await aprovarComo(api, 'revisor', pedidoId, aprovado.versao);
    expect(deNovo.statusCode).toBe(422);
    expect(codigo(deNovo)).toBe('TRANSICAO_INVALIDA');
    expect(api.persistencia.espiar.operacoes()).toEqual([]);
  });

  it('pedidoId do corpo diferente da rota é recusado', async () => {
    const api = montarApi();
    const { pedidoId, versao } = await prepararPedido(api);
    const outro = '5e0f6a10-0000-4000-8000-0000000000aa';
    const res = await api.comando(await api.entrar('revisor'), pedidoId, {
      pedidoId: outro,
      versaoEsperada: versao,
      acao: 'aprovar',
      dados: {},
    });
    expect(res.statusCode).toBe(400);
    expect(codigo(res)).toBe('DADO_INVALIDO');
  });
});

describe('entrada inválida e ações sem conector', () => {
  it('JSON malformado, rota com ID inválido e comando fora do contrato viram 400 sem eco', async () => {
    const api = montarApi();
    const revisor = await api.entrar('revisor');
    const malformado = await api.app.inject({
      method: 'POST',
      url: '/importacoes/jira',
      headers: { ...CSRF, cookie: revisor, 'content-type': 'application/json' },
      payload: '{"x":',
    });
    expect(malformado.statusCode).toBe(400);
    expect(codigo(malformado)).toBe('DADO_INVALIDO');
    expect((await api.get(revisor, '/pedidos/nao-e-uuid')).statusCode).toBe(400);
    const { pedidoId } = await prepararPedido(api);
    const desconhecido = await api.comando(revisor, pedidoId, {
      pedidoId,
      versaoEsperada: 1,
      acao: 'apagarTudo',
      dados: {},
    });
    expect(desconhecido.statusCode).toBe(400);
    expect(desconhecido.body).not.toContain('apagarTudo');
  });

  it('conferir existência e reconciliar dependem do worker: 501, depois da permissão', async () => {
    const api = montarApi();
    const { pedidoId, versao } = await prepararPedido(api);
    const executor = await api.entrar('executor');
    const conferir = await api.comando(executor, pedidoId, {
      pedidoId,
      versaoEsperada: versao,
      acao: 'conferirExistencia',
      dados: {},
    });
    expect(conferir.statusCode).toBe(501);
    expect(codigo(conferir)).toBe('ACAO_INDISPONIVEL');
    const solicitante = await api.comando(await api.entrar('solicitante'), pedidoId, {
      pedidoId,
      versaoEsperada: versao,
      acao: 'conferirExistencia',
      dados: {},
    });
    expect(solicitante.statusCode).toBe(403);
  });
});

describe('recorte de leitura e dados pessoais', () => {
  it('solicitante vê só os pedidos que importou, com CPF mascarado', async () => {
    const api = montarApi();
    const { pedidoId: doRevisor } = await prepararPedido(api);
    const solicitante = await api.entrar('solicitante');
    expect(
      listaPedidosSchema.parse((await api.get(solicitante, '/pedidos')).json()).pedidos,
    ).toEqual([]);
    expect((await api.get(solicitante, `/pedidos/${doRevisor}`)).statusCode).toBe(404);
    expect((await api.get(solicitante, `/pedidos/${doRevisor}/itens`)).statusCode).toBe(404);

    const outra = montarApi();
    const sol = await outra.entrar('solicitante');
    const relatorio = resultadoImportacaoSchema.parse((await outra.importar(sol)).json());
    // Sem permissão de validar, a identidade fica para o revisor verificar.
    expect(relatorio.criados[0]?.versao).toBe(1);
    const proprios = listaPedidosSchema.parse((await outra.get(sol, '/pedidos')).json()).pedidos;
    expect(proprios).toHaveLength(4);
    const detalhe = pedidoDetalheSchema.parse(
      (await outra.get(sol, `/pedidos/${proprios.at(-1)?.id}`)).json(),
    );
    expect(detalhe.dadosRh.cpf).toMatch(/^\d{3}\.\*\*\*\.\*\*\*-\d{2}$/);
    expect(JSON.stringify(detalhe)).not.toContain(cpfFicticio('100000001'));
  });

  it('executor e auditor veem CPF mascarado; revisor vê completo para editar a proposta', async () => {
    const api = montarApi();
    const { pedidoId } = await prepararPedido(api);
    for (const papel of ['executor', 'auditor'] as const) {
      const res = await api.get(await api.entrar(papel), `/pedidos/${pedidoId}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(cpfFicticio('100000001'));
    }
    const revisor = await api.get(await api.entrar('revisor'), `/pedidos/${pedidoId}`);
    expect(pedidoDetalheSchema.parse(revisor.json()).dadosRh.cpf).toBe(cpfFicticio('100000001'));
  });
});
