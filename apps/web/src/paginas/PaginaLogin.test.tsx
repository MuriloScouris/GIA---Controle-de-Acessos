// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../api/ApiProvider.js';
import type { ClienteApi } from '../api/cliente.js';
import { rotas } from '../rotas.js';
import { PERFIS_DEMO } from '../sessao/perfis.js';
import { SessaoProvider } from '../sessao/Sessao.js';
import { criarApiFalsa, erroApi } from '../teste/apoio.js';

function renderizarLogin(
  api: ClienteApi = criarApiFalsa(),
  caminho = '/login',
  navegar: (url: string) => void = () => undefined,
) {
  const router = createMemoryRouter(rotas, { initialEntries: [caminho] });
  render(
    <ApiProvider api={api}>
      <SessaoProvider navegar={navegar}>
        <RouterProvider router={router} />
      </SessaoProvider>
    </ApiProvider>,
  );
  return { router, api };
}

const SESSAO_OIDC = {
  usuarioId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  nome: 'Pessoa Corporativa',
  papeis: ['revisor', 'auditor'] as ('revisor' | 'auditor')[],
  expiraEm: '2026-10-15T20:00:00.000Z',
};

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('tela de login — sessão simulada (desenvolvimento)', () => {
  it('renderiza a marca GIA, o card e o aviso de ambiente de demonstração', async () => {
    renderizarLogin();
    expect(screen.getByRole('heading', { level: 1, name: 'Bem-vindo ao GIA' })).toBeTruthy();
    expect(
      screen.getByText(
        (_, el) => el?.textContent === 'Gestão do ciclo de vida de acessos.' && el.tagName === 'P',
      ),
    ).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Entrar' })).toBeTruthy();
    expect(screen.getByText(/Ambiente de demonstração/)).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByText('Pular para o conteúdo')).toBeTruthy();
  });

  it('não menciona o produto ou a empresa errados', async () => {
    renderizarLogin();
    await screen.findByRole('button', { name: 'Entrar' });
    expect(document.body.textContent).not.toMatch(/Onboarding|Quanta/i);
  });

  it('Entrar oferece os perfis demo e escolher um abre a sessão no servidor e leva ao painel', async () => {
    const { router, api } = renderizarLogin();
    await userEvent.click(await screen.findByRole('button', { name: 'Entrar' }));

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
    await userEvent.click(await screen.findByRole('button', { name: 'Entrar' }));
    await userEvent.click(screen.getByRole('button', { name: /Auditor/ }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Não foi possível abrir a sessão',
    );
    expect(router.state.location.pathname).toBe('/login');
    expect(window.localStorage.getItem('gia.sessaoSimulada')).toBeNull();
  });

  it('Voltar fecha a escolha de perfis sem criar sessão', async () => {
    const { router, api } = renderizarLogin();
    await userEvent.click(await screen.findByRole('button', { name: 'Entrar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/login');
    expect(window.localStorage.getItem('gia.sessaoSimulada')).toBeNull();
    expect(api.abrirSessaoSimulada).not.toHaveBeenCalled();
  });

  it('com sessão simulada já armazenada, /login vai direto para o painel', async () => {
    window.localStorage.setItem('gia.sessaoSimulada', 'revisor');
    const { router } = renderizarLogin();
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(await screen.findByText('Revisor/aprovador')).toBeTruthy();
  });

  it('ignora valor desconhecido no armazenamento', async () => {
    window.localStorage.setItem('gia.sessaoSimulada', 'root');
    const { router } = renderizarLogin();
    await screen.findByRole('button', { name: 'Entrar' });
    expect(router.state.location.pathname).toBe('/login');
  });
});

describe('tela de login — Entra ID (produção)', () => {
  const apiOidc = (extra: Partial<ClienteApi> = {}) =>
    criarApiFalsa({ modoSessao: async () => 'oidc', ...extra });

  it('mostra carregando e depois só "Entrar com Microsoft", sem perfis de demonstração', async () => {
    renderizarLogin(apiOidc(), '/login?retorno=%2Fpedidos%2F42');
    expect(screen.getByRole('status').textContent).toContain('Carregando');
    const botao = await screen.findByRole('link', { name: 'Entrar com Microsoft' });
    expect(botao.getAttribute('href')).toBe('/api/sessao/oidc/entrar?retorno=%2Fpedidos%2F42');
    expect(screen.queryByRole('button', { name: 'Entrar' })).toBeNull();
    expect(screen.queryByText(/perfil de demonstração|Ambiente de demonstração/)).toBeNull();
    expect(screen.getByText('Acesso restrito')).toBeTruthy();
  });

  it('retorno para fora da aplicação vira a raiz', async () => {
    renderizarLogin(apiOidc(), '/login?retorno=%2F%2Fatacante.exemplo');
    const botao = await screen.findByRole('link', { name: 'Entrar com Microsoft' });
    expect(botao.getAttribute('href')).toBe('/api/sessao/oidc/entrar?retorno=%2F');
  });

  it('ACESSO_NEGADO mostra o painel de acesso negado, com o botão para tentar outra conta', async () => {
    renderizarLogin(apiOidc(), '/login?erro=ACESSO_NEGADO');
    const alerta = await screen.findByRole('alert');
    expect(alerta.textContent).toContain('Acesso negado');
    expect(alerta.textContent).toContain('não tem papel no GIA');
    expect(screen.getByRole('link', { name: 'Entrar com Microsoft' })).toBeTruthy();
  });

  it.each([
    ['LOGIN_RECUSADO_PELO_PROVEDOR', 'cancelado ou recusado pela Microsoft'],
    ['LOGIN_ESTADO_INVALIDO', 'expirou ou foi iniciado em outra aba'],
    ['LOGIN_TOKEN_INVALIDO', 'confirmar sua identidade'],
    ['CODIGO_QUALQUER', 'Não foi possível entrar'],
  ])('erro %s vira mensagem própria, sem texto do provedor', async (codigo, trecho) => {
    renderizarLogin(apiOidc(), `/login?erro=${codigo}`);
    expect((await screen.findByRole('alert')).textContent).toContain(trecho);
  });

  it('login indisponível no servidor não oferece login nenhum — nunca cai na simulada', async () => {
    renderizarLogin(criarApiFalsa({ modoSessao: async () => 'indisponivel' }));
    expect((await screen.findByRole('alert')).textContent).toContain('não está disponível');
    expect(screen.queryByRole('button', { name: 'Entrar' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Entrar com Microsoft' })).toBeNull();
  });

  it('com sessão do Entra ID aberta, entra no painel com os papéis do servidor', async () => {
    const { router } = renderizarLogin(apiOidc({ sessaoAtual: async () => SESSAO_OIDC }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(await screen.findByText('Pessoa Corporativa')).toBeTruthy();
  });

  it('página interna sem sessão manda para o login com o retorno local', async () => {
    const { router } = renderizarLogin(apiOidc(), '/pedidos/42');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toBe(`?retorno=${encodeURIComponent('/pedidos/42')}`);
  });

  it('Sair faz POST seguro, encerra a sessão e segue para o logout do Entra ID', async () => {
    const navegar = vi.fn();
    const sairOidc = vi.fn(
      async () => 'https://login.microsoftonline.com/tenant/oauth2/v2.0/logout',
    );
    const { router, api } = renderizarLogin(
      apiOidc({ sessaoAtual: async () => SESSAO_OIDC, sairOidc }),
      '/',
      navegar,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Sair' }));
    await waitFor(() =>
      expect(navegar).toHaveBeenCalledWith(
        'https://login.microsoftonline.com/tenant/oauth2/v2.0/logout',
      ),
    );
    expect(sairOidc).toHaveBeenCalledTimes(1);
    expect(api.encerrarSessao).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/login');
  });
});
