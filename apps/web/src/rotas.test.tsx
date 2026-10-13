// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rotas } from './rotas.js';
import { PERFIS_DEMO } from './sessao/perfis.js';
import { SessaoProvider } from './sessao/Sessao.js';

function renderizar(caminho: string, perfilInicial = null as (typeof PERFIS_DEMO)[number] | null) {
  const router = createMemoryRouter(rotas, { initialEntries: [caminho] });
  render(
    <SessaoProvider perfilInicial={perfilInicial}>
      <RouterProvider router={router} />
    </SessaoProvider>,
  );
  return router;
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('rotas do web', () => {
  it('renderiza a página inicial com landmark principal e link de pular conteúdo', () => {
    renderizar('/', PERFIS_DEMO[0]!);
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByText('Pular para o conteúdo')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Verificar API' })).toBeTruthy();
  });

  it('renderiza página não encontrada em rota desconhecida', () => {
    renderizar('/nao-existe', PERFIS_DEMO[0]!);
    expect(screen.getByText('Página não encontrada')).toBeTruthy();
  });

  it('sem sessão, a página inicial redireciona para /login', () => {
    const router = renderizar('/');
    expect(router.state.location.pathname).toBe('/login');
  });

  it('declara as rotas explicitamente', () => {
    expect(createMemoryRouter(rotas).routes).toHaveLength(2);
  });

  it('Sair encerra a sessão simulada e volta ao login', async () => {
    const router = renderizar('/', PERFIS_DEMO[1]!);
    await userEvent.click(screen.getByRole('button', { name: 'Sair' }));
    expect(router.state.location.pathname).toBe('/login');
  });
});
