import { describe, expect, it } from 'vitest';
import {
  aprovarPedido,
  configuracaoPadrao,
  editarProposta,
  podeTransicionar,
  reabrirPedido,
  recalcularIdentidade,
  receberChamado,
  rejeitarPedido,
  verificarIdentidade,
  TRANSICOES_PEDIDO,
  type StatusPedido,
} from '../../src/index.js';
import {
  cenarioAprovado,
  cenarioRecebido,
  cenarioVerificado,
  chamado,
  codigoErro,
  ctxExecutor,
  ctxRevisor,
  itemProposto,
  itensSugeridos,
  parametrosAd,
  parametrosJira,
  valor,
} from '../apoio/fabricas.js';

describe('Pedido de admissão — estados e transições', () => {
  it('tabela de transições do pedido', () => {
    const permitidas: [StatusPedido, StatusPedido][] = [
      ['pendenteAprovacao', 'aprovado'],
      ['pendenteAprovacao', 'rejeitado'],
      ['aprovado', 'emExecucao'],
      ['aprovado', 'pendenteAprovacao'],
      ['emExecucao', 'concluido'],
      ['emExecucao', 'concluidoComErros'],
      ['concluidoComErros', 'emExecucao'],
      ['concluidoComErros', 'pendenteAprovacao'],
      ['rejeitado', 'pendenteAprovacao'],
    ];
    for (const [de, para] of permitidas)
      expect(podeTransicionar(TRANSICOES_PEDIDO, de, para), `${de}→${para}`).toBe(true);
    expect(TRANSICOES_PEDIDO.concluido).toEqual([]);
    expect(podeTransicionar(TRANSICOES_PEDIDO, 'rejeitado', 'aprovado')).toBe(false);
    expect(podeTransicionar(TRANSICOES_PEDIDO, 'pendenteAprovacao', 'emExecucao')).toBe(false);
    expect(podeTransicionar(TRANSICOES_PEDIDO, 'emExecucao', 'pendenteAprovacao')).toBe(false);
  });

  it('recebe o chamado em pendente de aprovação, versão 1, com colaborador e revisão 1', () => {
    const { pedido, revisao, colaborador } = cenarioRecebido();
    expect(pedido).toMatchObject({
      status: 'pendenteAprovacao',
      versao: 1,
      colaboradorId: colaborador.id,
      revisaoCorrenteId: revisao.id,
    });
    expect(revisao).toMatchObject({ numero: 1, situacao: 'rascunho', versaoRegras: 'regras-v7' });
    expect(revisao.itens.map((item) => item.sistema)).toEqual([
      'ad',
      'm365',
      'docusign',
      'softexpert',
      'jira',
    ]);
    expect(revisao.itens.find((item) => item.sistema === 'ad')?.parametros).toMatchObject({
      login: 'ana.souza',
      upn: 'ana.souza@empresa.com.br',
    });
  });

  it('terceiro não recebe itens enquanto a regra de terceiros não for definida', () => {
    const recebido = valor(
      receberChamado(
        {
          chamado: chamado({ tipoVinculo: 'terceiro' }),
          pedidoMesmaOrigem: null,
          colaboradorExistente: null,
          configuracao: configuracaoPadrao(),
          versaoRegras: 'regras-v7',
          itensSugeridos: itensSugeridos(),
        },
        ctxRevisor(),
      ),
    );
    if (recebido.tipo !== 'criado') throw new Error('esperava pedido criado');
    expect(recebido.revisao.itens).toEqual([]);
    expect(recebido.sistemasDescartados).toEqual(['ad', 'm365', 'docusign', 'softexpert', 'jira']);
  });

  it('chamado com CPF inválido é recusado', () => {
    const resultado = receberChamado(
      {
        chamado: chamado({ cpf: '111.111.111-11' }),
        pedidoMesmaOrigem: null,
        colaboradorExistente: null,
        configuracao: configuracaoPadrao(),
        versaoRegras: 'v',
        itensSugeridos: [],
      },
      ctxRevisor(),
    );
    expect(codigoErro(resultado)).toBe('CPF_INVALIDO');
  });
});

describe('Pedido de admissão — controle otimista de versão', () => {
  it('ação com versão desatualizada é recusada', () => {
    const base = cenarioVerificado();
    const resultado = aprovarPedido(
      {
        pedido: base.pedido,
        revisao: base.revisao,
        colaborador: base.colaborador,
        itensAnteriores: [],
      },
      base.pedido.versao - 1,
      ctxRevisor(),
    );
    expect(codigoErro(resultado)).toBe('CONFLITO_DE_VERSAO');
    expect(!resultado.ok && resultado.erro.detalhes).toEqual({
      versaoAtual: base.pedido.versao,
      versaoEsperada: base.pedido.versao - 1,
    });
  });

  it('cada comando que altera o pedido avança a versão em 1', () => {
    const recebido = cenarioRecebido();
    const verificado = valor(
      verificarIdentidade(
        { pedido: recebido.pedido, revisao: recebido.revisao, usos: [] },
        1,
        ctxRevisor(),
      ),
    );
    expect(verificado.pedido.versao).toBe(2);
    const aprovado = valor(
      aprovarPedido(
        {
          pedido: verificado.pedido,
          revisao: verificado.revisao,
          colaborador: recebido.colaborador,
          itensAnteriores: [],
        },
        2,
        ctxRevisor(),
      ),
    );
    expect(aprovado.pedido.versao).toBe(3);
    // Duas abas aprovando ao mesmo tempo: a segunda vê versão 2 e é recusada.
    expect(
      codigoErro(rejeitarPedido({ pedido: aprovado.pedido, motivo: 'duplicado' }, 2, ctxRevisor())),
    ).toBe('CONFLITO_DE_VERSAO');
  });
});

describe('Pedido de admissão — edição, rejeição e reabertura', () => {
  it('edita parâmetros e mantém a verificação se a identidade não mudou', () => {
    const base = cenarioVerificado();
    const editado = valor(
      editarProposta(
        {
          pedido: base.pedido,
          revisao: base.revisao,
          configuracao: configuracaoPadrao(),
          itens: [
            itemProposto('ad', parametrosAd({ grupos: ['GG_Outro'] })),
            itemProposto('jira', parametrosJira()),
          ],
        },
        base.pedido.versao,
        ctxRevisor(),
      ),
    );
    expect(editado.revisao.verificacaoIdentidade).toBe(base.revisao.verificacaoIdentidade);
    expect(editado.revisao.itens).toHaveLength(2);
    expect(editado.eventos[0]?.tipo).toBe('propostaEditada');
  });

  it('recusa sistema duplicado, parâmetros trocados e sistema fora do vínculo', () => {
    const base = cenarioRecebido();
    const editar = (
      itens: Parameters<typeof editarProposta>[0]['itens'],
      vinculoTerceiro = false,
    ) =>
      editarProposta(
        {
          pedido: vinculoTerceiro ? { ...base.pedido, tipoVinculo: 'terceiro' } : base.pedido,
          revisao: base.revisao,
          configuracao: configuracaoPadrao(),
          ...(itens === undefined ? {} : { itens }),
        },
        base.pedido.versao,
        ctxRevisor(),
      );
    expect(codigoErro(editar([itemProposto('ad'), itemProposto('ad')]))).toBe(
      'SISTEMA_DUPLICADO_NA_REVISAO',
    );
    expect(codigoErro(editar([itemProposto('ad', parametrosJira())]))).toBe(
      'PARAMETROS_DE_OUTRO_SISTEMA',
    );
    expect(codigoErro(editar([itemProposto('ad')], true))).toBe(
      'SISTEMA_NAO_HABILITADO_PARA_VINCULO',
    );
  });

  it('editar exige permissão de revisor', () => {
    const base = cenarioRecebido();
    expect(
      codigoErro(
        editarProposta(
          {
            pedido: base.pedido,
            revisao: base.revisao,
            configuracao: configuracaoPadrao(),
            itens: [],
          },
          base.pedido.versao,
          ctxExecutor(),
        ),
      ),
    ).toBe('PERMISSAO_NEGADA');
  });

  it('recalcular identidade volta ao e-mail do RH e exige nova verificação', () => {
    const base = cenarioVerificado();
    const recalculado = valor(
      recalcularIdentidade(
        { pedido: base.pedido, revisao: base.revisao, configuracao: configuracaoPadrao() },
        base.pedido.versao,
        ctxRevisor(),
      ),
    );
    expect(recalculado.revisao.identidade?.origem).toBe('emailCorporativoRh');
    expect(recalculado.revisao.verificacaoIdentidade).toBeNull();
  });

  it('rejeitar exige motivo e só vale para pendente de aprovação', () => {
    const base = cenarioRecebido();
    expect(codigoErro(rejeitarPedido({ pedido: base.pedido, motivo: '  ' }, 1, ctxRevisor()))).toBe(
      'MOTIVO_OBRIGATORIO',
    );
    const rejeitado = valor(
      rejeitarPedido({ pedido: base.pedido, motivo: ' vaga cancelada ' }, 1, ctxRevisor()),
    );
    expect(rejeitado.pedido).toMatchObject({
      status: 'rejeitado',
      motivoRejeicao: 'vaga cancelada',
      versao: 2,
    });
    expect(
      codigoErro(rejeitarPedido({ pedido: rejeitado.pedido, motivo: 'de novo' }, 2, ctxRevisor())),
    ).toBe('TRANSICAO_INVALIDA');
  });

  it('reabrir cria nova revisão em rascunho e preserva a aprovada', () => {
    const aprovado = cenarioAprovado();
    const reaberto = valor(
      reabrirPedido(
        {
          pedido: aprovado.pedido,
          revisao: aprovado.revisao,
          itens: aprovado.itens,
          motivo: 'trocar grupos',
        },
        aprovado.pedido.versao,
        ctxRevisor(),
      ),
    );
    expect(reaberto.pedido.status).toBe('pendenteAprovacao');
    expect(reaberto.revisao).toMatchObject({
      numero: 2,
      situacao: 'rascunho',
      baseadaEmRevisaoId: aprovado.revisao.id,
    });
    expect(reaberto.revisao.id).not.toBe(aprovado.revisao.id);
    expect(reaberto.pedido.revisaoCorrenteId).toBe(reaberto.revisao.id);
    expect(aprovado.revisao.situacao).toBe('aprovada');
    expect(
      codigoErro(
        reabrirPedido(
          { pedido: aprovado.pedido, revisao: aprovado.revisao, itens: [], motivo: '' },
          aprovado.pedido.versao,
          ctxRevisor(),
        ),
      ),
    ).toBe('MOTIVO_OBRIGATORIO');
  });

  it('pedido rejeitado pode ser reaberto para revisão', () => {
    const base = cenarioRecebido();
    const rejeitado = valor(
      rejeitarPedido({ pedido: base.pedido, motivo: 'dados errados' }, 1, ctxRevisor()),
    );
    const reaberto = valor(
      reabrirPedido(
        { pedido: rejeitado.pedido, revisao: base.revisao, itens: [], motivo: 'RH corrigiu' },
        2,
        ctxRevisor(),
      ),
    );
    expect(reaberto.pedido).toMatchObject({ status: 'pendenteAprovacao', motivoRejeicao: null });
  });

  it('não aprova revisão que não é a corrente', () => {
    const base = cenarioVerificado();
    const resultado = aprovarPedido(
      {
        pedido: base.pedido,
        revisao: { ...base.revisao, id: 'outra' },
        colaborador: base.colaborador,
        itensAnteriores: [],
      },
      base.pedido.versao,
      ctxRevisor(),
    );
    expect(codigoErro(resultado)).toBe('REVISAO_NAO_CORRENTE');
  });
});
