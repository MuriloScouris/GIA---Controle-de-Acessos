// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HistoricoPedido } from '@gia/contratos';
import { ErroApi } from '../api/cliente.js';
import { afterEach, expect, it, vi } from 'vitest';
import { criarApiFalsa, ID_PEDIDO, PERFIL_AUDITOR, renderizarApp } from '../teste/apoio.js';

afterEach(cleanup);

it('histórico mantém eventos em falha transitória, permite paginar e remove o histórico após perda de permissão', async () => {
  const evento = (tipo: string, id: string): HistoricoPedido['eventos'][number] => ({
    id,
    pedidoId: ID_PEDIDO,
    tipo,
    origem: 'gia',
    instante: '2026-10-15T12:00:00Z',
    ator: null,
    sistema: null,
    operacaoId: null,
    correlacaoId: null,
    corrigeEventoId: null,
  });
  const cursor = '12345678-0000-4000-8000-000000000001';
  const consultarHistorico = vi
    .fn()
    .mockResolvedValueOnce({
      pedidoId: ID_PEDIDO,
      eventos: [evento('pedidoRejeitado', cursor)],
      proximoCursor: cursor,
    })
    .mockRejectedValueOnce(new ErroApi('Indisponível', 503))
    .mockResolvedValueOnce({
      pedidoId: ID_PEDIDO,
      eventos: [evento('pedidoRecebido', '12345678-0000-4000-8000-000000000002')],
      proximoCursor: null,
    })
    .mockRejectedValueOnce(new ErroApi('Sem permissão', 403));
  renderizarApp(`/pedidos/${ID_PEDIDO}`, criarApiFalsa({ consultarHistorico }), PERFIL_AUDITOR);
  const usuario = userEvent.setup();
  expect(await screen.findByText('Pedido rejeitado')).toBeTruthy();
  await usuario.click(screen.getByRole('button', { name: 'Carregar eventos anteriores' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByText('Pedido rejeitado')).toBeTruthy();
  await usuario.click(screen.getByRole('button', { name: 'Carregar eventos anteriores' }));
  expect(
    await within(screen.getByRole('list', { name: 'Histórico persistido do pedido' })).findByText(
      'Pedido recebido',
    ),
  ).toBeTruthy();
  expect(screen.getByText('Pedido rejeitado')).toBeTruthy();
  await usuario.click(screen.getByRole('button', { name: 'Atualizar histórico' }));
  expect(await screen.findByText('Você não tem permissão para ver esta informação.')).toBeTruthy();
  expect(screen.queryByText('Pedido rejeitado')).toBeNull();
});

it('auditor lê o evento persistido em vez de reconstruir o histórico do estado corrente', async () => {
  const api = Object.assign(criarApiFalsa(), {
    consultarHistorico: vi.fn(async () => ({
      pedidoId: ID_PEDIDO,
      eventos: [
        {
          id: '12345678-0000-4000-8000-000000000001',
          pedidoId: ID_PEDIDO,
          tipo: 'pedidoRejeitado',
          origem: 'gia',
          instante: '2026-10-15T12:00:00Z',
          ator: { tipo: 'humano', nome: 'Revisora Fictícia' },
          sistema: null,
          operacaoId: null,
          correlacaoId: 'correlacao-teste',
          corrigeEventoId: null,
        },
      ],
      proximoCursor: null,
    })),
  });
  renderizarApp(`/pedidos/${ID_PEDIDO}`, api, PERFIL_AUDITOR);
  expect(await screen.findByText('Pedido rejeitado')).toBeTruthy();
  expect(screen.getByText('Revisora Fictícia')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Aprovar' })).toBeNull();
});

const eventoPersistido = (
  sobrescrita: Partial<HistoricoPedido['eventos'][number]>,
): HistoricoPedido['eventos'][number] => ({
  id: '12345678-0000-4000-8000-0000000000a1',
  pedidoId: ID_PEDIDO,
  tipo: 'pedidoRejeitado',
  origem: 'gia',
  instante: '2026-10-15T12:00:00Z',
  ator: { tipo: 'humano', nome: 'Revisora Fictícia' },
  sistema: null,
  operacaoId: null,
  correlacaoId: null,
  corrigeEventoId: null,
  ...sobrescrita,
});

function apiComHistorico(eventos: HistoricoPedido['eventos']) {
  return Object.assign(criarApiFalsa(), {
    consultarHistorico: vi.fn(async () => ({
      pedidoId: ID_PEDIDO,
      eventos,
      proximoCursor: null,
    })),
  });
}

it('separa evento, categoria, estado, hora, ator e sistema, e recolhe os identificadores técnicos', async () => {
  const api = apiComHistorico([
    eventoPersistido({
      tipo: 'operacaoEncaminhadaParaReconciliacao',
      origem: 'sincronizacaoAd',
      ator: { tipo: 'servico', nome: 'Worker GIA' },
      sistema: 'ad',
      operacaoId: '12345678-0000-4000-8000-0000000000b2',
      correlacaoId: 'correlacao-xyz',
      corrigeEventoId: '12345678-0000-4000-8000-0000000000c3',
    }),
  ]);
  renderizarApp(`/pedidos/${ID_PEDIDO}`, api, PERFIL_AUDITOR);
  const lista = await screen.findByRole('list', { name: 'Histórico persistido do pedido' });
  const item = within(lista).getAllByRole('listitem').at(-1)!;
  expect(within(item).getByText('Operação encaminhada para reconciliação')).toBeTruthy();
  // "Operação" é a categoria no topo e também o rótulo do identificador técnico.
  expect(within(item).getAllByText('Operação')).toHaveLength(2);
  expect(within(item).getByText('Em reconciliação')).toBeTruthy();
  expect(within(item).getByText('Worker GIA')).toBeTruthy();
  expect(within(item).getByText('Ator')).toBeTruthy();
  expect(within(item).getByText('Sistema')).toBeTruthy();
  const hora = item.querySelector('time')!;
  expect(hora.getAttribute('datetime')).toBe('2026-10-15T12:00:00Z');
  const tecnicos = item.querySelector('details')!;
  expect(tecnicos.open).toBe(false);
  expect(within(tecnicos).getByText('Detalhes técnicos')).toBeTruthy();
  for (const valor of [
    '12345678-0000-4000-8000-0000000000a1',
    'Sincronização AD',
    '12345678-0000-4000-8000-0000000000b2',
    'correlacao-xyz',
    '12345678-0000-4000-8000-0000000000c3',
  ]) {
    expect(within(tecnicos).getByText(valor)).toBeTruthy();
  }
});

it('tipo de evento desconhecido usa o rótulo genérico e atores ausentes viram sincronização externa', async () => {
  renderizarApp(
    `/pedidos/${ID_PEDIDO}`,
    apiComHistorico([eventoPersistido({ tipo: 'tipoQueNaoExiste', ator: null })]),
    PERFIL_AUDITOR,
  );
  expect(await screen.findByText('Evento registrado')).toBeTruthy();
  expect(screen.getByText('Sincronização externa')).toBeTruthy();
});

it('sem eventos mostra o estado vazio, sem lista nem botão de paginar', async () => {
  renderizarApp(`/pedidos/${ID_PEDIDO}`, apiComHistorico([]), PERFIL_AUDITOR);
  expect(await screen.findByText('Nenhum evento registrado para este pedido.')).toBeTruthy();
  expect(screen.queryByRole('list', { name: 'Histórico persistido do pedido' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Carregar eventos anteriores' })).toBeNull();
  expect(screen.getByText('0 eventos carregados')).toBeTruthy();
});

it('mostra o carregamento enquanto o histórico não chega', async () => {
  const api = Object.assign(criarApiFalsa(), {
    consultarHistorico: vi.fn(() => new Promise<never>(() => {})),
  });
  renderizarApp(`/pedidos/${ID_PEDIDO}`, api, PERFIL_AUDITOR);
  expect(await screen.findByText('Carregando histórico…')).toBeTruthy();
});

it('erro ao carregar o histórico oferece tentar de novo', async () => {
  const consultarHistorico = vi
    .fn()
    .mockRejectedValueOnce(new ErroApi('Indisponível', 503))
    .mockResolvedValueOnce({
      pedidoId: ID_PEDIDO,
      eventos: [eventoPersistido({})],
      proximoCursor: null,
    });
  renderizarApp(`/pedidos/${ID_PEDIDO}`, criarApiFalsa({ consultarHistorico }), PERFIL_AUDITOR);
  const usuario = userEvent.setup();
  await usuario.click(await screen.findByRole('button', { name: /tentar de novo/i }));
  expect(await screen.findByText('Pedido rejeitado')).toBeTruthy();
  expect(screen.getByText('1 evento carregado')).toBeTruthy();
});
