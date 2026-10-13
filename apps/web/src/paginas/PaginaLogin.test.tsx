// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rotas } from '../rotas.js';
import { PERFIS_DEMO } from '../sessao/perfis.js';
import { SessaoProvider } from '../sessao/Sessao.js';

function renderizarLogin() {
  const router = createMemoryRouter(rotas, { initialEntries: ['/login'] });
  render(
    <SessaoProvider>
      <RouterProvider router={router} />
    </SessaoProvider>,
  );
  return router;
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('tela de login', () => {
  it('renderiza a marca Gia, o card e o aviso de ambiente de demonstração', () => {
    renderizarLogin();
    expect(screen.getByRole('heading', { level: 1, name: 'Bem-vindo ao Gia' })).toBeTruthy();
    expect(screen.getByText('Gestão do ciclo de vida de acessos.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeTruthy();
    expect(screen.getByText(/Ambiente de demonstração/)).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByText('Pular para o conteúdo')).toBeTruthy();
  });

  it('não menciona o produto ou a empresa errados', () => {
    renderizarLogin();
    expect(document.body.textContent).not.toMatch(/Onboarding|Quanta/i);
  });

  it('Entrar oferece os perfis demo e escolher um leva à página inicial com o perfil ativo', async () => {
    const router = renderizarLogin();
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));

    for (const perfil of PERFIS_DEMO) {
      expect(screen.getByRole('button', { name: new RegExp(perfil.nome) })).toBeTruthy();
    }
    await userEvent.click(screen.getByRole('button', { name: /Auditor/ }));

    expect(router.state.location.pathname).toBe('/');
    expect(screen.getByRole('heading', { name: 'Início' })).toBeTruthy();
    expect(screen.getByText(/Perfil ativo:/).textContent).toContain('Auditor');
    expect(window.localStorage.getItem('gia.sessaoSimulada')).toBe('auditor');
  });

  it('Voltar fecha a escolha de perfis sem criar sessão', async () => {
    const router = renderizarLogin();
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/login');
    expect(window.localStorage.getItem('gia.sessaoSimulada')).toBeNull();
  });

  it('com sessão simulada já armazenada, /login vai direto para a página inicial', () => {
    window.localStorage.setItem('gia.sessaoSimulada', 'revisor');
    const router = renderizarLogin();
    expect(router.state.location.pathname).toBe('/');
    expect(screen.getByText(/Perfil ativo:/).textContent).toContain('Revisor/aprovador');
  });

  it('ignora valor desconhecido no armazenamento', () => {
    window.localStorage.setItem('gia.sessaoSimulada', 'root');
    const router = renderizarLogin();
    expect(router.state.location.pathname).toBe('/login');
  });
});
