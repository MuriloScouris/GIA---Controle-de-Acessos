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
