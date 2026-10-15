// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiProvider } from '../api/ApiProvider.js';
import { rotas } from '../rotas.js';
import { PERFIS_DEMO } from '../sessao/perfis.js';
import { SessaoProvider } from '../sessao/Sessao.js';
import { criarApiFalsa, erroApi } from '../teste/apoio.js';

function renderizarLogin(api = criarApiFalsa()) {
  const router = createMemoryRouter(rotas, { initialEntries: ['/login'] });
  render(
    <ApiProvider api={api}>
      <SessaoProvider>
        <RouterProvider router={router} />
      </SessaoProvider>
    </ApiProvider>,
  );
  return { router, api };
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('tela de login', () => {
  it('renderiza a marca GIA, o card e o aviso de ambiente de demonstração', () => {
    renderizarLogin();
    expect(screen.getByRole('heading', { level: 1, name: 'Bem-vindo ao GIA' })).toBeTruthy();
    expect(
      screen.getByText(
        (_, el) => el?.textContent === 'Gestão do ciclo de vida de acessos.' && el.tagName === 'P',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeTruthy();
    expect(screen.getByText(/Ambiente de demonstração/)).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByText('Pular para o conteúdo')).toBeTruthy();
  });

  it('não menciona o produto ou a empresa errados', () => {
    renderizarLogin();
    expect(document.body.textContent).not.toMatch(/Onboarding|Quanta/i);
  });

  it('Entrar oferece os perfis demo e escolher um abre a sessão no servidor e leva ao painel', async () => {
    const { router, api } = renderizarLogin();
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));

    for (const perfil of PERFIS_DEMO) {
      expect(screen.getByRole('button', { name: new RegExp(perfil.nome) })).toBeTruthy();
    }
    await userEvent.click(screen.getByRole('button', { name: /Auditor/ }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(await screen.findByRole('heading', { name: 'Painel de chamados' })).toBeTruthy();
    expect(screen.getByText('Auditor')).toBeTruthy();
    expect(window.localStorage.getItem('gia.sessaoSimulada')).toBe('auditor');
    // O cliente só informa o papel escolhido; o ator é definido pelo servidor.
    expect(api.abrirSessaoSimulada).toHaveBeenCalledWith('auditor');
  });

  it('se a API não abre a sessão, mostra o erro e não entra', async () => {
    const api = criarApiFalsa({ abrirSessaoSimulada: async () => Promise.reject(erroApi(500)) });
    const { router } = renderizarLogin(api);
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    await userEvent.click(screen.getByRole('button', { name: /Auditor/ }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Não foi possível abrir a sessão',
    );
    expect(router.state.location.pathname).toBe('/login');
    expect(window.localStorage.getItem('gia.sessaoSimulada')).toBeNull();
  });

  it('Voltar fecha a escolha de perfis sem criar sessão', async () => {
    const { router, api } = renderizarLogin();
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/login');
    expect(window.localStorage.getItem('gia.sessaoSimulada')).toBeNull();
    expect(api.abrirSessaoSimulada).not.toHaveBeenCalled();
  });

  it('com sessão simulada já armazenada, /login vai direto para o painel', () => {
    window.localStorage.setItem('gia.sessaoSimulada', 'revisor');
    const { router } = renderizarLogin();
    expect(router.state.location.pathname).toBe('/');
    expect(screen.getByText('Revisor/aprovador')).toBeTruthy();
  });

  it('ignora valor desconhecido no armazenamento', () => {
    window.localStorage.setItem('gia.sessaoSimulada', 'root');
    const { router } = renderizarLogin();
    expect(router.state.location.pathname).toBe('/login');
  });
});
