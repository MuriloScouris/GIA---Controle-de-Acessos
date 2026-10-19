// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import type { PedidoDetalhe } from '@gia/contratos';
import { afterEach, describe, expect, it } from 'vitest';
import { detalhe, itemResultado } from '../teste/apoio.js';
import { LinhaDoTempoPedido, eventosDoPedido } from './LinhaDoTempoPedido.js';

afterEach(cleanup);

/** Pedido com criação, aprovação e um acesso confirmado nos instantes informados. */
function pedido(criadoEm: string, aprovadaEm: string | null, confirmadoEm: string | null) {
  const base = detalhe({ criadoEm });
  return detalhe({
    criadoEm,
    revisao: {
      ...base.revisao,
      aprovadaEm,
      aprovadaPor: aprovadaEm
        ? ({ nome: 'Revisora Ficticia' } as unknown as NonNullable<
            PedidoDetalhe['revisao']['aprovadaPor']
          >)
        : null,
    },
    itens: confirmadoEm ? [itemResultado({ status: 'confirmado', confirmadoEm })] : [],
  });
}

const ids = (d: PedidoDetalhe) => eventosDoPedido(d).map((evento) => evento.id.split('-')[0]);

describe('ordem da linha do tempo', () => {
  it('ordena do mais recente para o mais antigo (formato real, ISO com Z)', () => {
    const d = pedido(
      '2026-10-14T10:00:00.000Z',
      '2026-10-14T11:00:00.000Z',
      '2026-10-14T12:00:00.000Z',
    );
    expect(ids(d)).toEqual(['item', 'revisao', 'criado']);
  });

  it('compara o instante real e não o texto: com e sem milissegundos', () => {
    // Como texto, "…:00.500Z" < "…:00Z" ('.' vem antes de 'Z'), o que inverteria a ordem.
    const d = pedido('2026-10-14T10:00:00Z', '2026-10-14T10:00:00.500Z', null);
    expect(ids(d)).toEqual(['revisao', 'criado']);
  });

  it('compara o instante real com offsets diferentes', () => {
    // 10:00-03:00 = 13:00Z, depois de 12:00Z, embora o texto "10:00…" ordene antes de "12:00…".
    const d = pedido('2026-10-14T12:00:00Z', '2026-10-14T10:00:00-03:00', null);
    expect(ids(d)).toEqual(['revisao', 'criado']);
  });

  it('mantém a ordem de inserção quando o mesmo instante vem em formatos diferentes', () => {
    const d = pedido(
      '2026-10-14T12:00:00Z',
      '2026-10-14T09:00:00-03:00',
      '2026-10-14T12:00:00.000Z',
    );
    expect(ids(d)).toEqual(['criado', 'revisao', 'item']);
  });

  it('manda instantes inválidos ao final, de forma estável', () => {
    const d = pedido('instante-quebrado', '2026-10-14T11:00:00.000Z', 'tambem-invalido');
    expect(ids(d)).toEqual(['revisao', 'criado', 'item']);
  });

  it('não falha quando todos os instantes são inválidos e mantém a inserção', () => {
    const d = pedido('x', 'y', 'z');
    expect(ids(d)).toEqual(['criado', 'revisao', 'item']);
  });
});

describe('<LinhaDoTempoPedido>', () => {
  it('agrupa instantes inválidos em "Data indisponível" sem quebrar a tela', () => {
    render(<LinhaDoTempoPedido detalhe={pedido('ruim', '2026-10-14T11:00:00Z', 'pior')} />);
    const lista = screen.getByRole('list');
    expect(within(lista).getAllByText('Data indisponível')).toHaveLength(1);
    expect(within(lista).getByText(/Revisão 1 aprovada/)).toBeTruthy();
  });

  it('renderiza os eventos do mais recente para o mais antigo', () => {
    render(
      <LinhaDoTempoPedido
        detalhe={pedido('2026-10-14T10:00:00Z', '2026-10-14T10:00:00.500Z', null)}
      />,
    );
    const titulos = screen
      .getAllByText(/aprovada para execução|Pedido criado/)
      .map((e) => e.textContent);
    expect(titulos[0]).toMatch(/Revisão 1 aprovada/);
    expect(titulos[1]).toMatch(/Pedido criado/);
  });
});

describe('<LinhaDoTempoPedido> hierarquia visual', () => {
  it('mostra categoria, estado, hora e ator em campos distintos', () => {
    render(
      <LinhaDoTempoPedido
        detalhe={pedido('2026-10-14T10:00:00Z', '2026-10-14T11:00:00Z', '2026-10-14T12:00:00Z')}
      />,
    );
    const lista = screen.getByRole('list');
    const decisao = within(lista)
      .getByText(/Revisão 1 aprovada/)
      .closest('li')!;
    expect(within(decisao).getByText('Decisão')).toBeTruthy();
    expect(within(decisao).getByText('Decidido')).toBeTruthy();
    expect(within(decisao).getByText('Ator')).toBeTruthy();
    expect(within(decisao).getByText('Revisora Ficticia')).toBeTruthy();
    expect(decisao.querySelector('time')!.getAttribute('datetime')).toBe('2026-10-14T11:00:00Z');
    const acesso = within(lista)
      .getByText(/confirmado no destino/)
      .closest('li')!;
    expect(within(acesso).getByText('Sucesso')).toBeTruthy();
    expect(within(acesso).getByText('Sistema')).toBeTruthy();
    expect(within(acesso).queryByText('Ator')).toBeNull();
  });

  it('agrupa por dia com um cabeçalho por data', () => {
    render(
      <LinhaDoTempoPedido
        detalhe={pedido('2026-10-13T10:00:00Z', '2026-10-14T11:00:00Z', '2026-10-14T12:00:00Z')}
      />,
    );
    const itens = within(screen.getByRole('list')).getAllByRole('listitem');
    const cabecalhos = itens.filter((li) => li.classList.contains('lt-dia'));
    expect(cabecalhos).toHaveLength(2);
  });
});
