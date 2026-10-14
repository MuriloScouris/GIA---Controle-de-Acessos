// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PERFIL_AUDITOR,
  PERFIL_REVISOR,
  criarApiFalsa,
  erroApi,
  importacao,
  renderizarApp,
  resumo,
} from '../teste/apoio.js';
import { TAMANHO_PAGINA } from './PainelPedidos.js';

afterEach(cleanup);

describe('painel de chamados (onboarding)', () => {
  it('mostra o carregamento e depois a lista com totais e links para o detalhe', async () => {
    const api = criarApiFalsa({
      listarPedidos: async () => ({
        pedidos: [
          resumo(1),
          resumo(2, { status: 'concluido', tipoVinculo: 'terceiro' }),
          resumo(3, { status: 'concluidoComErros' }),
        ],
      }),
    });
    renderizarApp('/', api);
    expect(screen.getByText('Carregando pedidos…')).toBeTruthy();

    const tabela = await screen.findByRole('table', { name: 'Pedidos de onboarding' });
    const linhas = within(tabela).getAllByRole('row');
    expect(linhas).toHaveLength(4); // cabeçalho + 3 pedidos
    expect(within(tabela).getByRole('link', { name: 'RH-1001' }).getAttribute('href')).toBe(
      '/pedidos/aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
    );
    expect(within(tabela).getByText('Terceiro')).toBeTruthy();
    // Estado com texto, sem depender só de cor.
    expect(within(tabela).getByText('Concluído com erros')).toBeTruthy();

    const totais = screen.getByRole('list', { name: 'Totais por status' });
    expect(within(totais).getByText(/Pendente de aprovação/).textContent).toMatch(/^1/);
    expect(within(totais).getByText(/Concluído$/).textContent).toMatch(/^1/);
  });

  it('estado vazio orienta a importar do Jira', async () => {
    renderizarApp('/', criarApiFalsa());
    expect(await screen.findByText(/Nenhum pedido de onboarding ainda/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Importar do Jira' })).toBeTruthy();
  });

  it('filtra por status e por texto; sem correspondência mostra o estado "nenhum resultado"', async () => {
    const api = criarApiFalsa({
      listarPedidos: async () => ({
        pedidos: [resumo(1), resumo(2, { status: 'aprovado' }), resumo(3, { status: 'aprovado' })],
      }),
    });
    renderizarApp('/', api);
    await screen.findByRole('table');

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'aprovado');
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3);

    await userEvent.type(screen.getByLabelText('Buscar por nome ou chamado'), 'RH-1003');
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);

    await userEvent.clear(screen.getByLabelText('Buscar por nome ou chamado'));
    await userEvent.type(screen.getByLabelText('Buscar por nome ou chamado'), 'não existe');
    expect(screen.getByText('Nenhum pedido corresponde aos filtros.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('pagina de 25 em 25', async () => {
    const pedidos = Array.from({ length: TAMANHO_PAGINA + 5 }, (_, i) => resumo(i + 1));
    renderizarApp('/', criarApiFalsa({ listarPedidos: async () => ({ pedidos }) }));
    await screen.findByRole('table');
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(TAMANHO_PAGINA + 1);
    expect(screen.getByText(/Página 1 de 2/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Anterior' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(6);
    expect(screen.getByText(/Página 2 de 2/)).toBeTruthy();
  });

  it('erro de leitura oferece tentar de novo e recarrega', async () => {
    let chamadas = 0;
    const api = criarApiFalsa({
      listarPedidos: async () => {
        chamadas += 1;
        if (chamadas === 1) throw erroApi(500);
        return { pedidos: [resumo(1)] };
      },
    });
    renderizarApp('/', api);
    expect(await screen.findByText(/Não foi possível carregar os dados/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('table')).toBeTruthy();
  });

  it('sem permissão (403) e sessão expirada (401) têm mensagens distintas', async () => {
    renderizarApp('/', criarApiFalsa({ listarPedidos: async () => Promise.reject(erroApi(403)) }));
    expect(await screen.findByText(/não tem permissão/)).toBeTruthy();
    cleanup();

    const { router } = renderizarApp(
      '/',
      criarApiFalsa({ listarPedidos: async () => Promise.reject(erroApi(401)) }),
    );
    expect(await screen.findByText(/sessão expirou/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Entrar novamente' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });

  describe('importar do Jira', () => {
    it('pede confirmação, só chama a API ao confirmar e mostra o resumo', async () => {
      let lista = [resumo(1)];
      const api = criarApiFalsa({
        listarPedidos: async () => ({ pedidos: lista }),
        importarDoJira: async () => {
          lista = [resumo(1), resumo(2)];
          return importacao({
            criados: [
              {
                chave: 'RH-1002',
                pedidoId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
                tipoVinculo: 'celetista',
                status: 'pendenteAprovacao',
                versao: 1,
                sistemasPropostos: ['ad'],
                sistemasDescartados: [],
                pendenciaIdentidade: null,
              },
            ],
            ignorados: [{ chave: 'RH-1004', tipoSolicitacao: 'Desligamento' }],
            recusados: [
              {
                chave: 'RH-1005',
                codigo: 'CPF_INVALIDO',
                mensagem: 'CPF inválido.',
                campos: ['cpf'],
              },
            ],
          });
        },
      });
      renderizarApp('/', api);
      await screen.findByRole('table');

      await userEvent.click(screen.getByRole('button', { name: 'Importar do Jira' }));
      const dialogo = await screen.findByRole('dialog');
      expect(within(dialogo).getByText(/Nenhum acesso é criado/)).toBeTruthy();
      await userEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));
      expect(api.importarDoJira).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole('button', { name: 'Importar do Jira' }));
      await userEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Importar' }),
      );

      expect(
        await screen.findByText(
          /1 criado\(s\), 0 já importado\(s\), 1 ignorado\(s\) por não serem de onboarding e 1 recusado\(s\)/,
        ),
      ).toBeTruthy();
      expect(screen.getByText(/RH-1005:/).closest('li')?.textContent).toContain('CPF inválido.');
      await waitFor(() =>
        expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3),
      );
      expect(api.importarDoJira).toHaveBeenCalledTimes(1);
    });

    it('falha na importação mantém o diálogo aberto com a mensagem da API', async () => {
      const api = criarApiFalsa({
        importarDoJira: async () =>
          Promise.reject(erroApi(403, 'Você não tem permissão para esta ação.')),
      });
      renderizarApp('/', api);
      await userEvent.click(await screen.findByRole('button', { name: 'Importar do Jira' }));
      await userEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Importar' }),
      );
      expect((await screen.findByRole('alert')).textContent).toContain('não tem permissão');
      expect(screen.getByRole('dialog')).toBeTruthy();
    });

    it('perfil sem permissão de criar pedido não vê o botão (o servidor revalida)', async () => {
      renderizarApp('/', criarApiFalsa(), PERFIL_AUDITOR);
      await screen.findByText(/Nenhum pedido/);
      expect(screen.queryByRole('button', { name: 'Importar do Jira' })).toBeNull();
      expect(screen.getByText(/não importa chamados/)).toBeTruthy();
    });

    it('o revisor pode importar', async () => {
      renderizarApp('/', criarApiFalsa(), PERFIL_REVISOR);
      expect(await screen.findByRole('button', { name: 'Importar do Jira' })).toBeTruthy();
    });
  });

  it('a aba Offboarding informa o standby, sem funcionalidade', async () => {
    renderizarApp('/', criarApiFalsa());
    await userEvent.click(screen.getByRole('tab', { name: 'Offboarding' }));
    expect(screen.getByText(/em standby/)).toBeTruthy();
  });
});
