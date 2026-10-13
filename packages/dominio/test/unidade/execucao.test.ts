import { describe, expect, it } from 'vitest';
import {
  consolidarPedido,
  decidirProximoPasso,
  itensDoDocumento,
  registrarAcessoManual,
  registrarResultadoOperacao,
  resultadoDeFalhaTecnica,
  sistemasPendentes,
  solicitarExecucao,
  statusPedidoPelosItens,
  validarPolitica,
  ETAPAS_PROVISIONAR,
  POLITICA_EXECUCAO_PADRAO,
  type ItemAcesso,
  type Operacao,
  type Sistema,
} from '../../src/index.js';
import {
  cenarioAprovado,
  cenarioEmExecucao,
  codigoErro,
  configuracaoComEscrita,
  ctxExecutor,
  ctxServico,
  depois,
  itemDo,
  operacaoDo,
  reservar,
  resultadoConector,
  substituirItens,
  valor,
} from '../apoio/fabricas.js';

function ultimaEtapa(sistema: Sistema) {
  return ETAPAS_PROVISIONAR[sistema].at(-1)!;
}

describe('Execução — fluxo completo', () => {
  it('todos os sistemas confirmados: pedido concluído e documento com os cinco acessos', () => {
    const cenario = cenarioEmExecucao();
    let itens: ItemAcesso[] = [...cenario.itens];
    const operacoes: Operacao[] = [];
    // AD primeiro; o M365 depende dele.
    for (const sistema of ['ad', 'm365', 'docusign', 'softexpert', 'jira'] as const) {
      const item = itemDo(itens, sistema);
      const registrado = valor(
        registrarResultadoOperacao(
          {
            operacao: reservar(
              operacaoDo(cenario.operacoes, item),
              undefined,
              sistema === 'm365' ? itemDo(itens, 'ad') : null,
            ),
            item,
            resultado: resultadoConector({
              etapa: ultimaEtapa(sistema),
              referenciaExterna: `ext-${sistema}`,
            }),
          },
          POLITICA_EXECUCAO_PADRAO,
          ctxServico(),
        ),
      );
      itens = substituirItens(itens, [registrado.item]);
      operacoes.push(registrado.operacao);
    }
    const consolidado = valor(
      consolidarPedido({ pedido: cenario.pedido, itens, operacoes }, ctxServico()),
    );
    expect(consolidado.pedido.status).toBe('concluido');
    expect(consolidado.eventos.map((evento) => evento.tipo)).toEqual(['statusPedidoAlterado']);
    const documento = valor(itensDoDocumento(consolidado.pedido, itens));
    expect(documento.map((item) => item.idExterno)).toEqual([
      'ext-ad',
      'ext-m365',
      'ext-docusign',
      'ext-softexpert',
      'ext-jira',
    ]);
    expect(sistemasPendentes(itens)).toEqual([]);
  });

  it('solicitar execução muda o pedido para em execução e numera a geração do item', () => {
    const cenario = cenarioEmExecucao({ sistemas: ['jira'] });
    expect(cenario.pedido.status).toBe('emExecucao');
    const jira = itemDo(cenario.itens, 'jira');
    expect(jira).toMatchObject({ status: 'emExecucao', geracao: 1 });
    expect(operacaoDo(cenario.operacoes, jira).chaveIdempotencia).toMatch(
      /^gia:real:.*:provisionar:g1$/,
    );
  });

  it('pedido ainda pendente de aprovação não executa', () => {
    const aprovado = cenarioAprovado({ sistemas: ['jira'] });
    const resultado = solicitarExecucao(
      {
        pedido: { ...aprovado.pedido, status: 'pendenteAprovacao' },
        revisao: aprovado.revisao,
        itens: aprovado.itens,
        operacoesExistentes: [],
        configuracao: configuracaoComEscrita(),
        modo: 'real',
      },
      aprovado.pedido.versao,
      ctxExecutor(),
    );
    expect(codigoErro(resultado)).toBe('TRANSICAO_INVALIDA');
  });

  it('item de outra revisão é recusado', () => {
    const aprovado = cenarioAprovado({ sistemas: ['jira'] });
    const resultado = solicitarExecucao(
      {
        pedido: aprovado.pedido,
        revisao: aprovado.revisao,
        itens: aprovado.itens,
        operacoesExistentes: [],
        configuracao: configuracaoComEscrita(),
        modo: 'real',
        itemIds: ['item-de-outro-pedido'],
      },
      aprovado.pedido.versao,
      ctxExecutor(),
    );
    expect(codigoErro(resultado)).toBe('ITEM_FORA_DO_PEDIDO');
  });

  it('provisionar um item por vez: com os demais ainda não enviados, o pedido volta a aprovado', () => {
    const aprovado = cenarioAprovado({ sistemas: ['ad', 'jira'] });
    const execucao = valor(
      solicitarExecucao(
        {
          pedido: aprovado.pedido,
          revisao: aprovado.revisao,
          itens: aprovado.itens,
          operacoesExistentes: [],
          configuracao: configuracaoComEscrita(),
          modo: 'real',
          itemIds: [itemDo(aprovado.itens, 'jira').id],
        },
        aprovado.pedido.versao,
        ctxExecutor(),
      ),
    );
    const cenario = {
      pedido: execucao.pedido,
      itens: substituirItens(aprovado.itens, execucao.itens),
      operacoes: execucao.operacoes,
    };
    const jira = itemDo(cenario.itens, 'jira');
    expect(cenario.pedido.status).toBe('emExecucao');
    expect(itemDo(cenario.itens, 'ad').status).toBe('pendente');
    const registrado = valor(
      registrarResultadoOperacao(
        {
          operacao: reservar(operacaoDo(cenario.operacoes, jira)),
          item: jira,
          resultado: resultadoConector({ etapa: 'adicionarGrupos' }),
        },
        POLITICA_EXECUCAO_PADRAO,
        ctxServico(),
      ),
    );
    const consolidado = valor(
      consolidarPedido(
        {
          pedido: cenario.pedido,
          itens: substituirItens(cenario.itens, [registrado.item]),
          operacoes: [registrado.operacao],
        },
        ctxServico(),
      ),
    );
    expect(consolidado.pedido.status).toBe('aprovado');
  });
});

describe('Execução — retentativas (ADR-0004)', () => {
  it('erro transitório sem efeito é repetido com backoff 5s, 15s, 45s e depois falha', () => {
    const cenario = cenarioEmExecucao({ sistemas: ['jira'] });
    let item = itemDo(cenario.itens, 'jira');
    let operacao = operacaoDo(cenario.operacoes, item);
    let agora = depois(0);
    const esperas: number[] = [];
    for (let tentativa = 1; tentativa <= 4; tentativa += 1) {
      const registrado = valor(
        registrarResultadoOperacao(
          {
            operacao: reservar(operacao, agora),
            item,
            resultado: resultadoDeFalhaTecnica({ tipo: 'conexaoRecusada', etapa: null }, 'real'),
          },
          POLITICA_EXECUCAO_PADRAO,
          ctxServico(agora),
        ),
      );
      operacao = registrado.operacao;
      item = registrado.item;
      if (registrado.proximoPasso.tipo === 'retentar') {
        esperas.push(registrado.proximoPasso.aguardarMs);
        expect(item.status).toBe('emExecucao');
        agora = operacao.disponivelEm;
      }
    }
    expect(esperas).toEqual([5_000, 15_000, 45_000]);
    expect(operacao).toMatchObject({ status: 'concluida', tentativas: 4, efeito: 'semEfeito' });
    expect(item.status).toBe('falhou');
  });

  it('respeita Retry-After maior que o backoff e aplica jitter vindo de fora', () => {
    const limite = resultadoDeFalhaTecnica(
      { tipo: 'limiteDeTaxa', etapa: null, tentarAposMs: 60_000 },
      'real',
    );
    expect(
      decidirProximoPasso(
        { acao: 'provisionar', modo: 'real', resultado: limite, tentativas: 1 },
        POLITICA_EXECUCAO_PADRAO,
      ),
    ).toEqual({
      tipo: 'retentar',
      aguardarMs: 60_000,
    });
    const recusa = resultadoDeFalhaTecnica({ tipo: 'conexaoRecusada', etapa: null }, 'real');
    expect(
      decidirProximoPasso(
        { acao: 'provisionar', modo: 'real', resultado: recusa, tentativas: 1, sorteioJitter: 0.5 },
        POLITICA_EXECUCAO_PADRAO,
      ),
    ).toEqual({ tipo: 'retentar', aguardarMs: 5_500 });
  });

  it('falha definitiva (não transitória) não é repetida', () => {
    const definitiva = resultadoConector({
      efeito: 'semEfeito',
      codigo: 'OU_INEXISTENTE',
      transitorio: false,
    });
    expect(
      decidirProximoPasso(
        { acao: 'provisionar', modo: 'real', resultado: definitiva, tentativas: 1 },
        POLITICA_EXECUCAO_PADRAO,
      ).tipo,
    ).toBe('finalizar');
  });

  it('valida os parâmetros da política', () => {
    expect(validarPolitica(POLITICA_EXECUCAO_PADRAO).ok).toBe(true);
    expect(codigoErro(validarPolitica({ ...POLITICA_EXECUCAO_PADRAO, duracaoLeaseMs: 0 }))).toBe(
      'DADO_INVALIDO',
    );
    expect(codigoErro(validarPolitica({ ...POLITICA_EXECUCAO_PADRAO, backoffMs: [5_000] }))).toBe(
      'DADO_INVALIDO',
    );
    expect(
      codigoErro(validarPolitica({ ...POLITICA_EXECUCAO_PADRAO, renovacaoLeaseMs: 200_000 })),
    ).toBe('DADO_INVALIDO');
    expect(codigoErro(validarPolitica({ ...POLITICA_EXECUCAO_PADRAO, maxRetentativas: -1 }))).toBe(
      'DADO_INVALIDO',
    );
    expect(
      codigoErro(validarPolitica({ ...POLITICA_EXECUCAO_PADRAO, timeoutConexaoMs: 60_000 })),
    ).toBe('DADO_INVALIDO');
  });
});

describe('Execução — consolidação e registro manual', () => {
  it('status do pedido pelos itens: parcial nunca aparece como concluído', () => {
    const item = (status: ItemAcesso['status']) => ({ status }) as ItemAcesso;
    expect(statusPedidoPelosItens([item('confirmado'), item('registradoManual')])).toBe(
      'concluido',
    );
    expect(statusPedidoPelosItens([item('confirmado'), item('parcial')])).toBe('concluidoComErros');
    expect(statusPedidoPelosItens([item('confirmado'), item('desconhecido')])).toBe(
      'concluidoComErros',
    );
    expect(statusPedidoPelosItens([item('falhou'), item('emExecucao')])).toBe('emExecucao');
    expect(statusPedidoPelosItens([item('confirmado'), item('pendente')])).toBe('aprovado');
  });

  it('registro manual exige observação, é auditado e conclui o item', () => {
    const aprovado = cenarioAprovado({ sistemas: ['jira'] });
    const jira = itemDo(aprovado.itens, 'jira');
    expect(
      codigoErro(
        registrarAcessoManual(
          { pedido: aprovado.pedido, item: jira, observacao: ' ' },
          jira.versao,
          ctxExecutor(),
        ),
      ),
    ).toBe('OBSERVACAO_OBRIGATORIA');
    const manual = valor(
      registrarAcessoManual(
        { pedido: aprovado.pedido, item: jira, observacao: 'feito pelo time do Jira' },
        jira.versao,
        ctxExecutor(),
      ),
    );
    expect(manual.item).toMatchObject({
      status: 'registradoManual',
      observacaoManual: 'feito pelo time do Jira',
    });
    expect(manual.item.mensagem).toContain('nenhum conector foi acionado');
    expect(manual.eventos[0]?.tipo).toBe('acessoManualRegistrado');
    expect(
      codigoErro(
        registrarAcessoManual(
          { pedido: aprovado.pedido, item: jira, observacao: 'x' },
          jira.versao + 5,
          ctxExecutor(),
        ),
      ),
    ).toBe('CONFLITO_DE_VERSAO');
  });

  it('documento só é emitido para pedido concluído', () => {
    const aprovado = cenarioAprovado({ sistemas: ['jira'] });
    expect(codigoErro(itensDoDocumento(aprovado.pedido, aprovado.itens))).toBe(
      'DOCUMENTO_INDISPONIVEL',
    );
  });

  it('consolidar pedido fora da execução não muda nada', () => {
    const aprovado = cenarioAprovado({ sistemas: ['jira'] });
    const pendente = { ...aprovado.pedido, status: 'pendenteAprovacao' as const };
    const consolidado = valor(
      consolidarPedido({ pedido: pendente, itens: aprovado.itens, operacoes: [] }, ctxServico()),
    );
    expect(consolidado.pedido).toBe(pendente);
    expect(consolidado.eventos).toEqual([]);
  });
});
