import { describe, expect, it } from 'vitest';
import {
  ajustarIdentidade,
  anexarEventos,
  cancelarOperacao,
  comprovarAcessoManual,
  configuracaoPadrao,
  congelarProfundo,
  consolidarPedido,
  criarEvento,
  editarProposta,
  reabrirPedido,
  receberChamado,
  reconciliarItem,
  registrarAcessoManual,
  registrarCorrecao,
  registrarResultadoOperacao,
  rejeitarPedido,
  resultadoDeFalhaTecnica,
  solicitarExecucao,
  POLITICA_EXECUCAO_PADRAO,
  REGISTRO_VAZIO,
  type AtorRegistrado,
  type ItemAcesso,
  type Operacao,
  type PedidoAdmissao,
  type ResultadoExistencia,
  type Revisao,
} from '../../src/index.js';
import {
  AGORA,
  cenarioAprovado,
  cenarioEmExecucao,
  cenarioRecebido,
  chamado,
  codigoErro,
  configuracaoComEscrita,
  CPF_ANA,
  ctxExecutor,
  ctxRevisor,
  ctxServico,
  depois,
  itemDo,
  itemProposto,
  itensSugeridos,
  operacaoDo,
  parametrosSoftexpert,
  reservar,
  resultadoConector,
  valor,
} from '../apoio/fabricas.js';

const SEGREDO = 'Fict1c1o-S3gr3d0';

function conferencia(mudancas: Partial<ResultadoExistencia> = {}): ResultadoExistencia {
  return {
    modo: 'real',
    contaExiste: true,
    acessosEncontrados: [],
    etapaComprovada: null,
    referenciaExterna: 'CN=ana.souza',
    conferidaEm: depois(60_000),
    ...mudancas,
  };
}

/** AD com resultado desconhecido (timeout sem etapa), pronto para reconciliar. */
function adDesconhecido() {
  const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
  const item = itemDo(cenario.itens, 'ad');
  const registrado = valor(
    registrarResultadoOperacao(
      {
        operacao: reservar(operacaoDo(cenario.operacoes, item)),
        item,
        resultado: resultadoDeFalhaTecnica({ tipo: 'timeout', etapa: null }, 'real'),
      },
      POLITICA_EXECUCAO_PADRAO,
      ctxServico(),
    ),
  );
  return { ...cenario, item: registrado.item, operacao: registrado.operacao };
}

function solicitarAd(
  pedido: PedidoAdmissao,
  cenario: { readonly revisao: Revisao },
  item: ItemAcesso,
  existentes: readonly Operacao[],
  agora = AGORA,
) {
  return valor(
    solicitarExecucao(
      {
        pedido,
        revisao: cenario.revisao,
        itens: [item],
        operacoesExistentes: existentes,
        configuracao: configuracaoComEscrita(),
        modo: 'real',
      },
      pedido.versao,
      ctxExecutor(agora),
    ),
  );
}

describe('Regressão 1 — segredos não ficam em entidades nem retornos (regra 12)', () => {
  it('observação de acesso manual com segredo é recusada (não só mascarada no evento)', () => {
    const aprovado = cenarioAprovado({ sistemas: ['jira'] });
    const jira = itemDo(aprovado.itens, 'jira');
    const resultado = registrarAcessoManual(
      { pedido: aprovado.pedido, item: jira, observacao: `feito à mão password=${SEGREDO}` },
      jira.versao,
      ctxExecutor(),
    );
    expect(codigoErro(resultado)).toBe('SEGREDO_NAO_PERMITIDO');
    expect(JSON.stringify(resultado)).not.toContain(SEGREDO);
  });

  it('motivos de rejeição, reabertura, cancelamento e correção com segredo são recusados', () => {
    const recebido = cenarioRecebido();
    expect(
      codigoErro(
        rejeitarPedido({ pedido: recebido.pedido, motivo: `token=${SEGREDO}` }, 1, ctxRevisor()),
      ),
    ).toBe('SEGREDO_NAO_PERMITIDO');

    const aprovado = cenarioAprovado();
    expect(
      codigoErro(
        reabrirPedido(
          {
            pedido: aprovado.pedido,
            revisao: aprovado.revisao,
            itens: aprovado.itens,
            motivo: `senha: ${SEGREDO}`,
          },
          aprovado.pedido.versao,
          ctxRevisor(),
        ),
      ),
    ).toBe('SEGREDO_NAO_PERMITIDO');

    const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
    const item = itemDo(cenario.itens, 'ad');
    expect(
      codigoErro(
        cancelarOperacao(
          { operacao: operacaoDo(cenario.operacoes, item), item, motivo: `Bearer ${SEGREDO}` },
          ctxExecutor(),
        ),
      ),
    ).toBe('SEGREDO_NAO_PERMITIDO');

    const original = valor(
      criarEvento({
        id: 'e1',
        tipo: 'pedidoAprovado',
        origem: 'gia',
        ator: { tipo: 'humano', id: 'u', nome: 'R', papeis: ['revisor'] },
        instante: AGORA,
      }),
    );
    const registro = valor(anexarEventos(REGISTRO_VAZIO, [original]));
    expect(
      codigoErro(
        registrarCorrecao(
          registro,
          { eventoOriginalId: 'e1', motivo: `api_key=${SEGREDO}`, correcao: {} },
          ctxRevisor(),
        ),
      ),
    ).toBe('SEGREDO_NAO_PERMITIDO');
  });

  it('referência externa da conferência é sanitizada na reconciliação e na comprovação manual', () => {
    const desconhecido = adDesconhecido();
    const reconciliado = valor(
      reconciliarItem(
        {
          pedido: desconhecido.pedido,
          item: desconhecido.item,
          operacao: desconhecido.operacao,
          conferencia: conferencia({
            acessosEncontrados: ['grupo:GG_Financeiro', 'grupo:GG_VPN'],
            referenciaExterna: `CN=ana.souza;password=${SEGREDO}`,
          }),
          desfecho: 'confirmado',
        },
        desconhecido.item.versao,
        ctxExecutor(depois(60_000)),
      ),
    );
    expect(JSON.stringify(reconciliado)).not.toContain(SEGREDO);

    const aprovado = cenarioAprovado({ sistemas: ['ad'] });
    const ad = itemDo(aprovado.itens, 'ad');
    const manual = valor(
      registrarAcessoManual(
        { pedido: aprovado.pedido, item: ad, observacao: 'conta criada pelo suporte' },
        ad.versao,
        ctxExecutor(),
      ),
    ).item;
    const comprovado = valor(
      comprovarAcessoManual(
        {
          pedido: aprovado.pedido,
          item: manual,
          conferencia: conferencia({
            acessosEncontrados: ['grupo:GG_Financeiro', 'grupo:GG_VPN'],
            referenciaExterna: `Bearer ${SEGREDO}`,
          }),
        },
        manual.versao,
        ctxExecutor(depois(60_000)),
      ),
    );
    expect(JSON.stringify(comprovado)).not.toContain(SEGREDO);
  });

  it('origem da sugestão, nome de exibição e dados do RH não carregam segredo', () => {
    const recebido = cenarioRecebido();
    expect(
      codigoErro(
        editarProposta(
          {
            pedido: recebido.pedido,
            revisao: recebido.revisao,
            configuracao: configuracaoPadrao(),
            itens: [{ ...itemProposto('jira'), origemSugestao: `regra X token=${SEGREDO}` }],
          },
          recebido.pedido.versao,
          ctxRevisor(),
        ),
      ),
    ).toBe('SEGREDO_NAO_PERMITIDO');
    expect(
      codigoErro(
        ajustarIdentidade({
          login: 'ana',
          email: 'ana@empresa.com.br',
          nomeExibicao: `Ana senha=${SEGREDO}`,
        }),
      ),
    ).toBe('SEGREDO_NAO_PERMITIDO');

    const base = chamado({ idExterno: 'RH-SEG' });
    const comSegredo = { ...base, dadosRh: { ...base.dadosRh, gestor: `Gestor senha=${SEGREDO}` } };
    const criado = valor(
      receberChamado(
        {
          chamado: comSegredo,
          pedidoMesmaOrigem: null,
          colaboradorExistente: null,
          configuracao: configuracaoPadrao(),
          versaoRegras: 'v',
          itensSugeridos: itensSugeridos(['jira']),
        },
        ctxRevisor(),
      ),
    );
    expect(JSON.stringify(criado)).not.toContain(SEGREDO);
  });
});

describe('Regressão 2 — cancelamento e reconciliação parcial não reiniciam etapas comprovadas (regra 4)', () => {
  it('AD parcial → retomada → cancelamento → nova execução continua de `adicionarGrupos`', () => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
    const ad = itemDo(cenario.itens, 'ad');
    const parcial = valor(
      registrarResultadoOperacao(
        {
          operacao: reservar(operacaoDo(cenario.operacoes, ad)),
          item: ad,
          resultado: resultadoConector({ efeito: 'parcial', etapa: 'habilitarConta' }),
        },
        POLITICA_EXECUCAO_PADRAO,
        ctxServico(),
      ),
    );
    const consolidado = valor(
      consolidarPedido(
        { pedido: cenario.pedido, itens: [parcial.item], operacoes: [parcial.operacao] },
        ctxServico(),
      ),
    );
    const retomada = solicitarAd(consolidado.pedido, cenario, parcial.item, [parcial.operacao]);
    const operacaoRetomada = retomada.operacoes[0]!;
    expect(operacaoRetomada.etapaInicial).toBe('adicionarGrupos');

    const cancelado = valor(
      cancelarOperacao(
        { operacao: operacaoRetomada, item: retomada.itens[0]!, motivo: 'janela de manutenção' },
        ctxExecutor(),
      ),
    );
    expect(cancelado.item).toMatchObject({ status: 'parcial', etapaAlcancada: 'habilitarConta' });

    const novaRetomada = solicitarAd(retomada.pedido, cenario, cancelado.item, [
      parcial.operacao,
      cancelado.operacao,
    ]);
    expect(novaRetomada.operacoes[0]?.etapaInicial).toBe('adicionarGrupos');
  });

  it('timeout sem etapa → reconciliação parcial exige etapa comprovada pela conferência', () => {
    const desconhecido = adDesconhecido();
    const semProva = reconciliarItem(
      {
        pedido: desconhecido.pedido,
        item: desconhecido.item,
        operacao: desconhecido.operacao,
        conferencia: conferencia(),
        desfecho: 'parcial',
      },
      desconhecido.item.versao,
      ctxExecutor(depois(60_000)),
    );
    expect(codigoErro(semProva)).toBe('ETAPA_DE_RETOMADA_NAO_COMPROVADA');

    for (const etapaComprovada of ['adicionarGrupos', 'criarConta'] as const) {
      expect(
        codigoErro(
          reconciliarItem(
            {
              pedido: desconhecido.pedido,
              item: desconhecido.item,
              operacao: desconhecido.operacao,
              conferencia: conferencia({ etapaComprovada }),
              desfecho: 'parcial',
            },
            desconhecido.item.versao,
            ctxExecutor(depois(60_000)),
          ),
        ),
      ).toBe('ETAPA_DE_RETOMADA_NAO_COMPROVADA');
    }
  });

  it('timeout → reconciliação parcial com prova → nova operação começa depois da etapa comprovada', () => {
    const desconhecido = adDesconhecido();
    const reconciliado = valor(
      reconciliarItem(
        {
          pedido: desconhecido.pedido,
          item: desconhecido.item,
          operacao: desconhecido.operacao,
          conferencia: conferencia({ etapaComprovada: 'habilitarConta' }),
          desfecho: 'parcial',
        },
        desconhecido.item.versao,
        ctxExecutor(depois(60_000)),
      ),
    );
    expect(reconciliado.item).toMatchObject({
      status: 'parcial',
      etapaAlcancada: 'habilitarConta',
    });
    const consolidado = valor(
      consolidarPedido(
        {
          pedido: desconhecido.pedido,
          itens: [reconciliado.item],
          operacoes: [reconciliado.operacao],
        },
        ctxServico(depois(60_000)),
      ),
    );
    const retomada = solicitarAd(
      consolidado.pedido,
      desconhecido,
      reconciliado.item,
      [reconciliado.operacao],
      depois(60_000),
    );
    expect(retomada.operacoes[0]?.etapaInicial).toBe('adicionarGrupos');
  });

  it('parcial sem etapa informada não é retomável: vai para conferência', () => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
    const ad = itemDo(cenario.itens, 'ad');
    const registrado = valor(
      registrarResultadoOperacao(
        {
          operacao: reservar(operacaoDo(cenario.operacoes, ad)),
          item: ad,
          resultado: resultadoConector({ efeito: 'parcial', etapa: null }),
        },
        POLITICA_EXECUCAO_PADRAO,
        ctxServico(),
      ),
    );
    expect(registrado.operacao).toMatchObject({
      efeito: 'desconhecido',
      codigo: 'PARCIAL_SEM_ETAPA',
    });
    expect(registrado.item.status).toBe('desconhecido');
  });
});

describe('Regressão 3 — JA_REVOGADO nunca confirma provisionamento (regras 5/6)', () => {
  it.each([null, 'adicionarGrupos'] as const)(
    'provisionamento AD com JA_REVOGADO (etapa %s) não confirma o item',
    (etapa) => {
      const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
      const ad = itemDo(cenario.itens, 'ad');
      const registrado = valor(
        registrarResultadoOperacao(
          {
            operacao: reservar(operacaoDo(cenario.operacoes, ad)),
            item: ad,
            resultado: resultadoConector({ efeito: 'confirmado', codigo: 'JA_REVOGADO', etapa }),
          },
          POLITICA_EXECUCAO_PADRAO,
          ctxServico(),
        ),
      );
      expect(registrado.item.status).not.toBe('confirmado');
      expect(registrado.item.status).toBe('desconhecido');
      expect(registrado.operacao.codigo).toBe('CODIGO_INCOERENTE_COM_ACAO');
      expect(registrado.proximoPasso.tipo).toBe('reconciliar');
    },
  );
});

describe('Regressão 4 — papéis do ator congelados em profundidade no evento (regra 11)', () => {
  it('mutar o array de papéis do chamador não altera o evento', () => {
    const papeis: AtorRegistrado['papeis'][number][] = ['revisor'];
    const ator = Object.freeze({ tipo: 'humano' as const, id: 'u1', nome: 'Revisora', papeis });
    const evento = valor(
      criarEvento({ id: 'e1', tipo: 'pedidoAprovado', origem: 'gia', ator, instante: AGORA }),
    );
    papeis.push('executor');
    expect(evento.ator?.papeis).toEqual(['revisor']);
    expect(Object.isFrozen(evento.ator?.papeis)).toBe(true);
    expect(() => (evento.ator?.papeis as string[]).push('auditor')).toThrow(TypeError);
  });

  it('congelarProfundo percorre descendentes de raiz já congelada e tolera ciclos', () => {
    const lista = [1];
    const raiz = Object.freeze({ lista });
    congelarProfundo(raiz);
    expect(Object.isFrozen(lista)).toBe(true);
    const ciclo: Record<string, unknown> = {};
    ciclo['eu'] = ciclo;
    expect(() => congelarProfundo(ciclo)).not.toThrow();
    expect(Object.isFrozen(ciclo)).toBe(true);
  });
});

describe('Regressão 5 — CPF usado como identificador SoftExpert é mascarado na auditoria', () => {
  const cpfFormatado = `${CPF_ANA.slice(0, 3)}.${CPF_ANA.slice(3, 6)}.${CPF_ANA.slice(6, 9)}-${CPF_ANA.slice(9)}`;

  it.each([CPF_ANA, cpfFormatado])('identificador %s não aparece integral no evento', (cpf) => {
    const recebido = cenarioRecebido({ sistemas: ['softexpert'] });
    const editado = valor(
      editarProposta(
        {
          pedido: recebido.pedido,
          revisao: recebido.revisao,
          configuracao: configuracaoPadrao(),
          itens: [itemProposto('softexpert', parametrosSoftexpert({ identificador: cpf }))],
        },
        recebido.pedido.versao,
        ctxRevisor(),
      ),
    );
    const auditoria = JSON.stringify(editado.eventos);
    expect(auditoria).not.toContain(CPF_ANA);
    expect(auditoria).not.toContain(cpfFormatado);
    expect(auditoria).toContain(`${CPF_ANA.slice(0, 3)}.***.***-${CPF_ANA.slice(9)}`);
    // A entidade mantém o identificador real, necessário para provisionar.
    expect(editado.revisao.itens[0]?.parametros).toMatchObject({ identificador: cpf });
  });

  it('matrícula comum e números que não são CPF válido ficam intactos', () => {
    const recebido = cenarioRecebido({ sistemas: ['softexpert'] });
    for (const identificador of ['M123', '12345678900']) {
      const editado = valor(
        editarProposta(
          {
            pedido: recebido.pedido,
            revisao: recebido.revisao,
            configuracao: configuracaoPadrao(),
            itens: [itemProposto('softexpert', parametrosSoftexpert({ identificador }))],
          },
          recebido.pedido.versao,
          ctxRevisor(),
        ),
      );
      expect(JSON.stringify(editado.eventos)).toContain(`"identificador":"${identificador}"`);
    }
  });
});
