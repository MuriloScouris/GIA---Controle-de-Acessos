import {
  pedidoDetalheSchema,
  respostaErroSchema,
  respostaSucessoSchema,
  resultadoImportacaoSchema,
  resultadoItemSchema,
  resultadoItensSchema,
  type PedidoDetalhe,
  type ResultadoImportacao,
} from '@gia/contratos';
import { SISTEMAS } from '@gia/dominio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PESSOAS_FICTICIAS } from './sessao/sessoes-simuladas.js';
import { cpfFicticio } from './simuladores/cpf-ficticio.js';
import { montarApi, type ApiDeTeste } from './teste/apoio.js';

const fetchBloqueado = vi.fn(() => {
  throw new Error('chamada de rede externa não permitida nos testes');
});

beforeEach(() => {
  vi.stubGlobal('fetch', fetchBloqueado);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchBloqueado.mockClear();
});

async function importar(api: ApiDeTeste, cookie: string): Promise<ResultadoImportacao> {
  const res = await api.importar(cookie);
  expect(res.statusCode).toBe(200);
  return resultadoImportacaoSchema.parse(res.json());
}

function pedidoDaChave(relatorio: ResultadoImportacao, chave: string): string {
  const criado = relatorio.criados.find((c) => c.chave === chave);
  if (!criado) throw new Error(`pedido ${chave} não foi criado`);
  return criado.pedidoId;
}

async function detalhe(api: ApiDeTeste, cookie: string, pedidoId: string): Promise<PedidoDetalhe> {
  const res = await api.get(cookie, `/pedidos/${pedidoId}`);
  expect(res.statusCode).toBe(200);
  return pedidoDetalheSchema.parse(res.json());
}

function aprovar(pedidoId: string, versaoEsperada: number) {
  return { pedidoId, versaoEsperada, acao: 'aprovar', dados: {} };
}

describe('importação simulada do Jira', () => {
  it('normaliza, separa por vínculo, deduplica pela origem e relata recusas sem chamar a rede', async () => {
    const api = montarApi();
    const revisor = await api.entrar('revisor');
    const relatorio = await importar(api, revisor);

    expect(relatorio.criados.map((c) => c.chave)).toEqual([
      'RH-1001',
      'RH-1002',
      'RH-1003',
      'RH-1007',
    ]);
    const celetista = relatorio.criados[0];
    expect(celetista).toMatchObject({
      tipoVinculo: 'celetista',
      status: 'pendenteAprovacao',
      // Recebido (v1) e já verificado por quem pode validar (v2).
      versao: 2,
      sistemasPropostos: [...SISTEMAS],
      sistemasDescartados: [],
      pendenciaIdentidade: null,
    });
    // Terceiro: nenhum sistema habilitado por padrão, nada é proposto por engano.
    expect(relatorio.criados[1]).toMatchObject({
      chave: 'RH-1002',
      tipoVinculo: 'terceiro',
      sistemasPropostos: [],
      sistemasDescartados: [...SISTEMAS],
    });
    expect(relatorio.criados[3]).toMatchObject({
      chave: 'RH-1007',
      versao: 1,
      pendenciaIdentidade: 'EMAIL_CORPORATIVO_INVALIDO',
    });
    expect(relatorio.duplicados).toEqual([{ chave: 'RH-1001', pedidoId: celetista?.pedidoId }]);
    expect(relatorio.ignorados).toEqual([{ chave: 'RH-1004', tipoSolicitacao: 'Desligamento' }]);
    expect(relatorio.recusados).toEqual([
      expect.objectContaining({ chave: 'RH-1005', codigo: 'CPF_INVALIDO', campos: [] }),
      expect.objectContaining({
        chave: 'RH-1006',
        codigo: 'DADO_INVALIDO',
        campos: expect.arrayContaining(['fields.nomeCompleto', 'fields.cpf']),
      }),
    ]);

    // Regra 10: importar de novo não cria nenhum pedido.
    const segunda = await importar(api, revisor);
    expect(segunda.criados).toEqual([]);
    expect(segunda.duplicados.map((d) => d.chave)).toEqual([
      'RH-1001',
      'RH-1002',
      'RH-1003',
      'RH-1001',
      'RH-1007',
    ]);
    expect(api.persistencia.espiar.pedidos()).toHaveLength(4);
    expect(api.persistencia.espiar.colaboradores()).toHaveLength(4);
    expect(api.leiturasJira()).toBe(2);
    expect(fetchBloqueado).not.toHaveBeenCalled();
  });

  it('gera identidade e itens a partir das regras de área e cargo, com a origem de cada sugestão', async () => {
    const api = montarApi();
    const revisor = await api.entrar('revisor');
    const relatorio = await importar(api, revisor);
    const pedido = await detalhe(api, revisor, pedidoDaChave(relatorio, 'RH-1001'));

    expect(pedido.revisao.identidade).toEqual({
      login: 'maria.souza',
      upn: 'maria.souza@exemplo.com.br',
      email: 'maria.souza@exemplo.com.br',
      proxyAddresses: ['SMTP:maria.souza@exemplo.com.br'],
      nomeExibicao: 'Maria Ficticia Souza',
      origem: 'emailCorporativoRh',
    });
    expect(pedido.revisao.verificacaoIdentidade?.situacao).toBe('livre');
    expect(pedido.revisao.versaoRegras).toBe('regras-ficticias-2026.10-1');
    const ad = pedido.revisao.itens.find((item) => item.sistema === 'ad');
    expect(ad?.origemSugestao).toBe('Regra da área "Tecnologia" (regras-ficticias-2026.10-1)');
    expect(ad?.parametros).toMatchObject({
      login: 'maria.souza',
      ou: 'OU=Tecnologia,OU=Usuarios,DC=exemplo,DC=local',
      grupos: ['GG_Todos', 'GG_Tecnologia'],
      departamento: 'Tecnologia da Informação',
      cpf: cpfFicticio('100000001'),
    });
    // Nada foi aprovado nem enfileirado na ingestão.
    expect(pedido.itens).toEqual([]);
    expect(api.persistencia.espiar.operacoes()).toEqual([]);

    // Cargo com regra própria soma grupos e troca a função.
    const coordenador = await detalhe(api, revisor, pedidoDaChave(relatorio, 'RH-1003'));
    const se = coordenador.revisao.itens.find((item) => item.sistema === 'softexpert');
    expect(se?.parametros).toMatchObject({ area: 'Financeiro', funcao: 'Gestor' });
    expect(se?.origemSugestao).toContain('cargo "Coordenador"');
  });
});

describe('fluxo principal: proposta → edição → aprovação → fila → resultado → manual', () => {
  it('cumpre o ciclo com revisor e executor, sem nenhuma escrita externa', async () => {
    const api = montarApi();
    const revisor = await api.entrar('revisor');
    const executor = await api.entrar('executor');
    const pedidoId = pedidoDaChave(await importar(api, revisor), 'RH-1001');
    const inicial = await detalhe(api, revisor, pedidoId);

    // 3) Edição da proposta pendente: identidade ajustada e grupo a mais no AD.
    const itens = inicial.revisao.itens.map((item) =>
      item.sistema === 'ad'
        ? {
            ...item,
            parametros: {
              ...item.parametros,
              grupos: [...(item.parametros['grupos'] as string[]), 'GG_Projetos'],
            },
          }
        : item,
    );
    const edicao = await api.comando(revisor, pedidoId, {
      pedidoId,
      versaoEsperada: inicial.versao,
      acao: 'editarProposta',
      dados: {
        identidade: {
          login: 'maria.fsouza',
          email: 'maria.fsouza@exemplo.com.br',
          nomeExibicao: 'Maria F. Souza',
        },
        itens,
      },
    });
    expect(edicao.statusCode).toBe(200);
    // Edita (v+1) e revalida a identidade nova (v+2) na mesma transação.
    expect(respostaSucessoSchema.parse(edicao.json())).toEqual({
      ok: true,
      status: 'pendenteAprovacao',
      versao: inicial.versao + 2,
      operacaoId: null,
    });
    const editado = await detalhe(api, revisor, pedidoId);
    expect(editado.revisao.identidade).toMatchObject({
      login: 'maria.fsouza',
      origem: 'ajusteManual',
    });
    expect(editado.revisao.verificacaoIdentidade?.situacao).toBe('livre');
    const adEditado = editado.revisao.itens.find((item) => item.sistema === 'ad');
    // Os parâmetros seguem a identidade da revisão.
    expect(adEditado?.parametros).toMatchObject({
      login: 'maria.fsouza',
      upn: 'maria.fsouza@exemplo.com.br',
      grupos: ['GG_Todos', 'GG_Tecnologia', 'GG_Projetos'],
    });

    // 4) Aprovar só grava a decisão (regra 1).
    const aprovacao = await api.comando(revisor, pedidoId, aprovar(pedidoId, editado.versao));
    expect(aprovacao.statusCode).toBe(200);
    const aprovado = respostaSucessoSchema.parse(aprovacao.json());
    expect(aprovado).toMatchObject({ status: 'aprovado', operacaoId: null });
    expect(api.persistencia.espiar.operacoes()).toEqual([]);
    const itensAprovados = resultadoItensSchema.parse(
      (await api.get(executor, `/pedidos/${pedidoId}/itens`)).json(),
    );
    expect(itensAprovados.itens.map((item) => [item.sistema, item.status])).toEqual(
      SISTEMAS.map((sistema) => [sistema, 'pendente']),
    );

    // 5) Solicitar execução de parte dos itens: grava na fila e responde "aceita".
    const docusign = itensAprovados.itens.find((item) => item.sistema === 'docusign');
    const paraExecutar = itensAprovados.itens
      .filter((item) => item.sistema !== 'docusign')
      .map((item) => item.id);
    const solicitacao = await api.comando(executor, pedidoId, {
      pedidoId,
      versaoEsperada: aprovado.versao,
      acao: 'solicitarExecucao',
      dados: { itemIds: paraExecutar },
    });
    expect(solicitacao.statusCode).toBe(202);
    const aceita = respostaSucessoSchema.parse(solicitacao.json());
    expect(aceita.operacaoIds).toHaveLength(4);
    expect(aceita.operacaoId).toBe(aceita.operacaoIds?.[0]);
    // Escrita externa desligada: operações simuladas, sem mudar item nem pedido (regra 9).
    expect(aceita).toMatchObject({ status: 'aprovado', versao: aprovado.versao });
    const fila = api.persistencia.espiar.operacoes();
    expect(fila.map((op) => [op.modo, op.status, op.acao])).toEqual(
      Array.from({ length: 4 }, () => ['simulado', 'pendente', 'provisionar']),
    );
    expect(fila.every((op) => op.solicitadaPor.id === PESSOAS_FICTICIAS.executor.usuarioId)).toBe(
      true,
    );

    // 6) Resultado por item, com a operação de cada um.
    const resultado = resultadoItensSchema.parse(
      (await api.get(revisor, `/pedidos/${pedidoId}/itens`)).json(),
    );
    for (const item of resultado.itens) {
      expect(item.status).toBe('pendente');
      expect(item.operacoes.map((op) => [op.modo, op.status])).toEqual(
        item.sistema === 'docusign' ? [] : [['simulado', 'pendente']],
      );
    }

    // 7) Registrar acesso manual no item que ficou de fora.
    const manual = await api.comando(executor, pedidoId, {
      pedidoId,
      versaoEsperada: aceita.versao,
      acao: 'registrarAcessoManual',
      dados: { itemId: docusign?.id, observacao: 'Usuário criado pelo suporte no portal.' },
    });
    expect(manual.statusCode).toBe(200);
    const item = resultadoItemSchema.parse(
      (await api.get(executor, `/pedidos/${pedidoId}/itens/${docusign?.id}`)).json(),
    );
    expect(item).toMatchObject({
      status: 'registradoManual',
      observacaoManual: 'Usuário criado pelo suporte no portal.',
      mensagem: 'Acesso registrado manualmente; nenhum conector foi acionado.',
    });

    // Auditoria: cada passo virou evento, com o ator da sessão.
    const eventos = api.persistencia.espiar.eventos().filter((e) => e.pedidoId === pedidoId);
    expect(eventos.map((e) => [e.tipo, e.ator?.id])).toEqual([
      ['pedidoRecebido', PESSOAS_FICTICIAS.revisor.usuarioId],
      ['identidadeVerificada', PESSOAS_FICTICIAS.revisor.usuarioId],
      ['propostaEditada', PESSOAS_FICTICIAS.revisor.usuarioId],
      ['identidadeVerificada', PESSOAS_FICTICIAS.revisor.usuarioId],
      ['identidadeVerificada', PESSOAS_FICTICIAS.revisor.usuarioId],
      ['pedidoAprovado', PESSOAS_FICTICIAS.revisor.usuarioId],
      ['simulacaoSolicitada', PESSOAS_FICTICIAS.executor.usuarioId],
      ['acessoManualRegistrado', PESSOAS_FICTICIAS.executor.usuarioId],
    ]);
    expect(fetchBloqueado).not.toHaveBeenCalled();
  });

  it('o Administrador do Gia executa o ciclo inteiro sozinho, ainda sem escrita externa', async () => {
    const api = montarApi();
    const admin = await api.entrar('administradorGia');
    const pedidoId = pedidoDaChave(await importar(api, admin), 'RH-1001');
    const pedido = await detalhe(api, admin, pedidoId);
    expect(pedido.dadosRh.cpf).toBe(cpfFicticio('100000001'));

    const aprovacao = await api.comando(admin, pedidoId, aprovar(pedidoId, pedido.versao));
    expect(aprovacao.statusCode).toBe(200);
    const { versao } = respostaSucessoSchema.parse(aprovacao.json());
    const solicitacao = await api.comando(admin, pedidoId, {
      pedidoId,
      versaoEsperada: versao,
      acao: 'solicitarExecucao',
      dados: {},
    });
    expect(solicitacao.statusCode).toBe(202);
    expect(api.persistencia.espiar.operacoes().every((op) => op.modo === 'simulado')).toBe(true);
    const itens = resultadoItensSchema.parse(
      (await api.get(admin, `/pedidos/${pedidoId}/itens`)).json(),
    );
    const jira = itens.itens.find((item) => item.sistema === 'jira');
    const manual = await api.comando(admin, pedidoId, {
      pedidoId,
      versaoEsperada: versao,
      acao: 'registrarAcessoManual',
      dados: { itemId: jira?.id, observacao: 'Conta criada manualmente.' },
    });
    expect(manual.statusCode).toBe(200);
    const atores = new Set(
      api.persistencia.espiar
        .eventos()
        .filter((e) => e.pedidoId === pedidoId)
        .map((e) => e.ator?.papeis.join(',')),
    );
    // Ações do Administrador do Gia ficam filtráveis na auditoria pelo papel.
    expect([...atores]).toEqual(['administradorGia']);
  });
});

describe('revisão: colisão, pendência, rejeição e reabertura', () => {
  it('identidade em uso por outra pessoa bloqueia a aprovação até o ajuste humano', async () => {
    const api = montarApi();
    const revisor = await api.entrar('revisor');
    const pedidoId = pedidoDaChave(await importar(api, revisor), 'RH-1003');
    const pedido = await detalhe(api, revisor, pedidoId);
    expect(pedido.revisao.verificacaoIdentidade?.situacao).toBe('emUsoPorOutraPessoa');

    const recusada = await api.comando(revisor, pedidoId, aprovar(pedidoId, pedido.versao));
    expect(recusada.statusCode).toBe(422);
    const erro = respostaErroSchema.parse(recusada.json());
    expect(erro.codigo).toBe('IDENTIDADE_EM_USO');
    expect(erro.detalhes?.['conflitos']).toEqual(
      expect.arrayContaining([{ fonte: 'ad', campo: 'login', valor: 'joao.pereira' }]),
    );
    // Recusa desfaz tudo, inclusive a revalidação feita na mesma transação.
    expect((await detalhe(api, revisor, pedidoId)).versao).toBe(pedido.versao);

    const edicao = await api.comando(revisor, pedidoId, {
      pedidoId,
      versaoEsperada: pedido.versao,
      acao: 'editarProposta',
      dados: {
        identidade: {
          login: 'joao.fpereira',
          email: 'joao.fpereira@exemplo.com.br',
          nomeExibicao: 'Joao F. Pereira',
        },
      },
    });
    expect(edicao.statusCode).toBe(200);
    const { versao } = respostaSucessoSchema.parse(edicao.json());
    const aprovada = await api.comando(revisor, pedidoId, aprovar(pedidoId, versao));
    expect(aprovada.statusCode).toBe(200);
  });

  it('sem e-mail do RH a proposta fica pendente até alguém definir a identidade', async () => {
    const api = montarApi();
    const revisor = await api.entrar('revisor');
    const pedidoId = pedidoDaChave(await importar(api, revisor), 'RH-1007');
    const pedido = await detalhe(api, revisor, pedidoId);
    expect(pedido.revisao.identidade).toBeNull();
    expect(pedido.revisao.pendenciaIdentidade?.codigo).toBe('EMAIL_CORPORATIVO_INVALIDO');

    const recusada = await api.comando(revisor, pedidoId, aprovar(pedidoId, pedido.versao));
    expect(recusada.statusCode).toBe(422);
    expect(respostaErroSchema.parse(recusada.json()).codigo).toBe('IDENTIDADE_AUSENTE');

    const edicao = await api.comando(revisor, pedidoId, {
      pedidoId,
      versaoEsperada: pedido.versao,
      acao: 'editarProposta',
      dados: {
        identidade: {
          login: 'ana.rocha',
          email: 'ana.rocha@exemplo.com.br',
          nomeExibicao: 'Ana Ficticia Rocha',
        },
      },
    });
    const { versao } = respostaSucessoSchema.parse(edicao.json());
    expect((await api.comando(revisor, pedidoId, aprovar(pedidoId, versao))).statusCode).toBe(200);
  });

  it('rejeita com motivo e reabre com nova revisão', async () => {
    const api = montarApi();
    const revisor = await api.entrar('revisor');
    const pedidoId = pedidoDaChave(await importar(api, revisor), 'RH-1001');
    const pedido = await detalhe(api, revisor, pedidoId);

    const rejeicao = await api.comando(revisor, pedidoId, {
      pedidoId,
      versaoEsperada: pedido.versao,
      acao: 'rejeitar',
      dados: { motivo: 'Cargo divergente do contrato.' },
    });
    expect(respostaSucessoSchema.parse(rejeicao.json())).toMatchObject({ status: 'rejeitado' });
    const rejeitado = await detalhe(api, revisor, pedidoId);
    expect(rejeitado.motivoRejeicao).toBe('Cargo divergente do contrato.');

    const reabertura = await api.comando(revisor, pedidoId, {
      pedidoId,
      versaoEsperada: rejeitado.versao,
      acao: 'reabrir',
      dados: { motivo: 'RH corrigiu o cargo.' },
    });
    expect(respostaSucessoSchema.parse(reabertura.json())).toMatchObject({
      status: 'pendenteAprovacao',
    });
    const reaberto = await detalhe(api, revisor, pedidoId);
    expect(reaberto.revisao.numero).toBe(2);
    expect(reaberto.revisao.id).not.toBe(pedido.revisao.id);
  });
});

describe('segredos (regra 12)', () => {
  it('segredo colado no chamado do Jira é sanitizado antes de virar pedido, proposta ou evento', async () => {
    const marcador = 'FICTICIO-SOMENTE-TESTE';
    const api = montarApi({
      chamados: [
        {
          key: 'RH-2001',
          fields: {
            tipoSolicitacao: 'Admissão - Celetista',
            nomeCompleto: `Bia password=${marcador} Lopes`,
            cpf: cpfFicticio('200000001'),
            matricula: `Bearer ${marcador}`,
            emailCorporativo: 'bia.lopes@exemplo.com.br',
            area: 'Tecnologia',
            cargo: 'Analista',
            dataAdmissao: '2026-11-03',
            gestor: null,
          },
        },
      ],
    });
    const revisor = await api.entrar('revisor');
    const relatorio = await importar(api, revisor);
    const pedidoId = pedidoDaChave(relatorio, 'RH-2001');
    const res = await api.get(revisor, `/pedidos/${pedidoId}`);
    expect(res.body).not.toContain(marcador);
    expect(JSON.stringify(api.persistencia.espiar.eventos())).not.toContain(marcador);
    expect(JSON.stringify(api.persistencia.espiar.colaboradores())).not.toContain(marcador);
  });

  it('observação com segredo é recusada e nada muda', async () => {
    const api = montarApi();
    const admin = await api.entrar('administradorGia');
    const pedidoId = pedidoDaChave(await importar(api, admin), 'RH-1001');
    const pedido = await detalhe(api, admin, pedidoId);
    const { versao } = respostaSucessoSchema.parse(
      (await api.comando(admin, pedidoId, aprovar(pedidoId, pedido.versao))).json(),
    );
    const itens = resultadoItensSchema.parse(
      (await api.get(admin, `/pedidos/${pedidoId}/itens`)).json(),
    );
    const res = await api.comando(admin, pedidoId, {
      pedidoId,
      versaoEsperada: versao,
      acao: 'registrarAcessoManual',
      dados: { itemId: itens.itens[0]?.id, observacao: 'senha: provisoria123' },
    });
    expect(res.statusCode).toBe(400);
    expect(respostaErroSchema.parse(res.json()).codigo).toBe('SEGREDO_NAO_PERMITIDO');
    expect(res.body).not.toContain('provisoria123');
    const depois = resultadoItensSchema.parse(
      (await api.get(admin, `/pedidos/${pedidoId}/itens`)).json(),
    );
    expect(depois.itens[0]?.status).toBe('pendente');
  });
});
