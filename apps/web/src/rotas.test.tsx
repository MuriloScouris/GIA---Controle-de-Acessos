// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiProvider } from './api/ApiProvider.js';
import { rotas } from './rotas.js';
import { PERFIS_DEMO } from './sessao/perfis.js';
import { SessaoProvider } from './sessao/Sessao.js';
import { criarApiFalsa } from './teste/apoio.js';

function renderizar(caminho: string, perfilInicial = null as (typeof PERFIS_DEMO)[number] | null) {
  const api = criarApiFalsa();
  const router = createMemoryRouter(rotas, { initialEntries: [caminho] });
  render(
    <ApiProvider api={api}>
      <SessaoProvider perfilInicial={perfilInicial}>
        <RouterProvider router={router} />
      </SessaoProvider>
    </ApiProvider>,
  );
  return { router, api };
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('rotas do web', () => {
  it('renderiza o painel com landmark principal e link de pular conteúdo', async () => {
    renderizar('/', PERFIS_DEMO[0]!);
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByText('Pular para o conteúdo')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Painel de chamados' })).toBeTruthy();
    expect(await screen.findByText(/Nenhum pedido de onboarding/)).toBeTruthy();
  });

  it('o detalhe do pedido tem rota própria', async () => {
    const { router } = renderizar('/pedidos/11111111-1111-4111-8111-111111111111', PERFIS_DEMO[0]!);
    expect(await screen.findByRole('heading', { level: 1, name: /RH-1001/ })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/pedidos/11111111-1111-4111-8111-111111111111');
  });

  it('renderiza página não encontrada em rota desconhecida', () => {
    renderizar('/nao-existe', PERFIS_DEMO[0]!);
    expect(screen.getByText('Página não encontrada')).toBeTruthy();
  });

  it('sem sessão, o painel e o detalhe redirecionam para /login', () => {
    expect(renderizar('/').router.state.location.pathname).toBe('/login');
    cleanup();
    expect(renderizar('/pedidos/x').router.state.location.pathname).toBe('/login');
  });

  it('declara as rotas explicitamente', () => {
    expect(createMemoryRouter(rotas).routes).toHaveLength(2);
  });

  it('Sair encerra a sessão no servidor e na interface e volta ao login', async () => {
    const { router, api } = renderizar('/', PERFIS_DEMO[1]!);
    await userEvent.click(screen.getByRole('button', { name: 'Sair' }));
    expect(router.state.location.pathname).toBe('/login');
    expect(api.encerrarSessao).toHaveBeenCalledTimes(1);
  });
});
