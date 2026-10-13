import { describe, expect, it } from 'vitest';
import {
  anexarEventos,
  cancelarOperacao,
  consolidarPedido,
  criarAtorDeServico,
  criarEvento,
  registrarCorrecao,
  PAPEIS,
  REGISTRO_VAZIO,
  type ContextoComando,
  type Papel,
} from '../../src/index.js';
import {
  AGORA,
  cenarioEmExecucao,
  codigoErro,
  contexto,
  ctxServico,
  itemDo,
  novoId,
  operacaoDo,
  valor,
} from '../apoio/fabricas.js';

const HUMANOS: readonly Papel[] = PAPEIS.filter((papel) => papel !== 'servicoExecutor');

function ctxDoPapel(papel: Papel): ContextoComando {
  if (papel !== 'servicoExecutor') return contexto([papel]);
  return {
    ator: criarAtorDeServico({ id: 'worker-1', nome: 'Serviço executor' }, null),
    agora: AGORA,
    correlacaoId: 'correlacao',
    novoId,
  };
}

describe('Guarda — cancelar operação exige `executarOperacoes`', () => {
  const autorizados: readonly Papel[] = ['executor', 'administradorGia'];

  it.each(PAPEIS.filter((papel) => !autorizados.includes(papel)))('%s não cancela', (papel) => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
    const item = itemDo(cenario.itens, 'ad');
    const resultado = cancelarOperacao(
      { operacao: operacaoDo(cenario.operacoes, item), item, motivo: 'tentativa indevida' },
      ctxDoPapel(papel),
    );
    expect(codigoErro(resultado)).toBe('PERMISSAO_NEGADA');
  });

  it.each(autorizados)('%s cancela', (papel) => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
    const item = itemDo(cenario.itens, 'ad');
    const resultado = valor(
      cancelarOperacao(
        { operacao: operacaoDo(cenario.operacoes, item), item, motivo: 'pedido reaberto' },
        ctxDoPapel(papel),
      ),
    );
    expect(resultado.operacao.status).toBe('cancelada');
    expect(resultado.eventos[0]?.ator?.papeis).toEqual([papel]);
  });
});

describe('Guarda — consolidar pedido é exclusivo do serviço executor', () => {
  it.each(HUMANOS)('%s não consolida (nem o Administrador do Gia)', (papel) => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad', 'm365'] });
    const resultado = consolidarPedido(
      { pedido: cenario.pedido, itens: cenario.itens, operacoes: cenario.operacoes },
      ctxDoPapel(papel),
    );
    expect(codigoErro(resultado)).toBe('PERMISSAO_NEGADA');
  });

  it('o serviço executor consolida', () => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
    expect(
      consolidarPedido(
        { pedido: cenario.pedido, itens: cenario.itens, operacoes: cenario.operacoes },
        ctxServico(),
      ).ok,
    ).toBe(true);
  });
});

describe('Guarda — corrigir evidência exige `corrigirEvidencia`', () => {
  const autorizados: readonly Papel[] = ['revisor', 'administradorGia'];

  function registro() {
    const original = valor(
      criarEvento({
        id: 'evento-original',
        tipo: 'pedidoAprovado',
        origem: 'gia',
        ator: { tipo: 'humano', id: 'u1', nome: 'Revisora', papeis: ['revisor'] },
        instante: AGORA,
        depois: { status: 'aprovado' },
      }),
    );
    return valor(anexarEventos(REGISTRO_VAZIO, [original]));
  }

  it.each(PAPEIS.filter((papel) => !autorizados.includes(papel)))(
    '%s não corrige o registro de auditoria',
    (papel) => {
      const antes = registro();
      const resultado = registrarCorrecao(
        antes,
        { eventoOriginalId: 'evento-original', motivo: 'ajuste', correcao: { status: 'x' } },
        ctxDoPapel(papel),
      );
      expect(codigoErro(resultado)).toBe('PERMISSAO_NEGADA');
      expect(antes).toHaveLength(1);
    },
  );

  it.each(autorizados)('%s corrige com novo evento auditado', (papel) => {
    const corrigido = valor(
      registrarCorrecao(
        registro(),
        { eventoOriginalId: 'evento-original', motivo: 'ajuste', correcao: { status: 'x' } },
        ctxDoPapel(papel),
      ),
    );
    expect(corrigido.registro).toHaveLength(2);
    expect(corrigido.evento.ator?.papeis).toEqual([papel]);
  });
});
