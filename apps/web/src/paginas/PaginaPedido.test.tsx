// @vitest-environment jsdom
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ID_ITEM_AD,
  ID_ITEM_JIRA,
  ID_PEDIDO,
  PERFIL_AUDITOR,
  PERFIL_REVISOR,
  criarApiFalsa,
  detalhe,
  erroApi,
  itemResultado,
  renderizarApp,
} from '../teste/apoio.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const CAMINHO = `/pedidos/${ID_PEDIDO}`;

function operacaoSimulada(status: 'pendente' | 'reservada' | 'concluida') {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    acao: 'provisionar' as const,
    modo: 'simulado' as const,
    status,
    efeito: null,
    codigo: null,
    mensagem: null,
    tentativas: 0,
    criadaEm: '2026-10-14T12:00:00.000Z',
    atualizadaEm: '2026-10-14T12:00:00.000Z',
  };
}

function botao(nome: string | RegExp) {
  return screen.getByRole('button', { name: nome });
}

async function confirmarNoDialogo(nome: string) {
  const dialogo = await screen.findByRole('dialog');
  await userEvent.click(within(dialogo).getByRole('button', { name: nome }));
}

describe('detalhe do pedido', () => {
  it('mostra dados do RH (CPF como veio da API), identidade, verificação e itens', async () => {
    renderizarApp(CAMINHO, criarApiFalsa());
    expect(
      await screen.findByRole('heading', { level: 1, name: /RH-1001 — Maria Ficticia Souza/ }),
    ).toBeTruthy();
    expect(screen.getByText('100.***.***-09')).toBeTruthy();
    expect(screen.getByText('M1001')).toBeTruthy();
    expect(screen.getByText(/Livre nos diretórios/)).toBeTruthy();
    expect(screen.getByText('Active Directory')).toBeTruthy();
    expect(screen.getByText('GG-Tecnologia, GG-VPN')).toBeTruthy();
    expect(screen.getByText(/Regra da área Tecnologia/)).toBeTruthy();
    expect(screen.getAllByText(/nada foi executado ainda/)).toHaveLength(2);
    // Senha e segredos nunca aparecem: o contrato não os traz e a tela só mostra o que veio.
    expect(document.body.textContent).not.toMatch(/senha|password|token/i);
  });

  it('pendência e conflito de identidade ficam visíveis', async () => {
    const base = detalhe();
    renderizarApp(
      CAMINHO,
      criarApiFalsa({
        detalharPedido: async () =>
          detalhe({
            revisao: {
              ...base.revisao,
              pendenciaIdentidade: {
                codigo: 'IDENTIDADE_EM_USO',
                mensagem: 'O login já está em uso por outra pessoa.',
              },
              verificacaoIdentidade: {
                situacao: 'emUsoPorOutraPessoa',
                verificadaEm: base.criadoEm,
                conflitos: [{ fonte: 'ad', campo: 'login', valor: 'joao.pereira' }],
              },
            },
          }),
      }),
    );
    expect((await screen.findByRole('alert')).textContent).toContain('já está em uso');
    expect(screen.getByRole('list', { name: 'Conflitos de identidade' }).textContent).toContain(
      'AD: login joao.pereira',
    );
    expect(screen.getByText(/ajuste a identidade/)).toBeTruthy();
  });

  it('404 mostra "não encontrado" e link de volta', async () => {
    renderizarApp(
      CAMINHO,
      criarApiFalsa({ detalharPedido: async () => Promise.reject(erroApi(404)) }),
    );
    expect(await screen.findByText(/Não encontrado/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voltar ao painel' })).toBeTruthy();
  });

  describe('pendente de aprovação', () => {
    it('o revisor aprova depois de confirmar, enviando a versão vista e nenhum ator', async () => {
      let atual = detalhe();
      const api = criarApiFalsa({
        detalharPedido: async () => atual,
        executarComando: async () => {
          atual = detalhe({ status: 'aprovado', versao: 4 });
          return { ok: true, status: 'aprovado', versao: 4, operacaoId: null };
        },
      });
      renderizarApp(CAMINHO, api, PERFIL_REVISOR);
      await screen.findByRole('heading', { level: 1 });

      await userEvent.click(botao('Aprovar'));
      expect(await screen.findByText(/Aprovar só registra a decisão/)).toBeTruthy();
      expect(api.executarComando).not.toHaveBeenCalled();
      await confirmarNoDialogo('Aprovar');

      expect(api.executarComando).toHaveBeenCalledWith(ID_PEDIDO, 3, {
        acao: 'aprovar',
        dados: {},
      });
      expect(await screen.findByText('Ação registrada.')).toBeTruthy();
      // Recarrega: agora aprovado, sem botão de aprovar.
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Aprovar' })).toBeNull());
      expect(screen.getByText('Aprovado')).toBeTruthy();
    });

    it('rejeitar exige motivo e o envia', async () => {
      const api = criarApiFalsa();
      renderizarApp(CAMINHO, api, PERFIL_REVISOR);
      await screen.findByRole('heading', { level: 1 });
      await userEvent.click(botao('Rejeitar'));
      const dialogo = await screen.findByRole('dialog');
      const confirmar = within(dialogo).getByRole('button', { name: 'Rejeitar' });
      expect((confirmar as HTMLButtonElement).disabled).toBe(true);

      await userEvent.type(
        within(dialogo).getByLabelText('Motivo da rejeição'),
        'Dados incompletos',
      );
      await userEvent.click(confirmar);
      expect(api.executarComando).toHaveBeenCalledWith(ID_PEDIDO, 3, {
        acao: 'rejeitar',
        dados: { motivo: 'Dados incompletos' },
      });
    });

    it('edita a identidade e recalcula', async () => {
      const api = criarApiFalsa();
      renderizarApp(CAMINHO, api, PERFIL_REVISOR);
      await screen.findByRole('heading', { level: 1 });

      await userEvent.click(botao('Editar identidade'));
      const dialogo = await screen.findByRole('dialog');
      const login = within(dialogo).getByLabelText('Login');
      expect((login as HTMLInputElement).value).toBe('maria.souza');
      await userEvent.clear(login);
      await userEvent.type(login, 'maria.s2');
      await userEvent.click(within(dialogo).getByRole('button', { name: 'Salvar identidade' }));
      expect(api.executarComando).toHaveBeenLastCalledWith(ID_PEDIDO, 3, {
        acao: 'editarProposta',
        dados: {
          identidade: {
            login: 'maria.s2',
            email: 'maria.souza@exemplo.com.br',
            nomeExibicao: 'Maria Ficticia Souza',
          },
        },
      });

      await userEvent.click(await screen.findByRole('button', { name: 'Recalcular identidade' }));
      await confirmarNoDialogo('Recalcular');
      expect(api.executarComando).toHaveBeenLastCalledWith(ID_PEDIDO, 3, {
        acao: 'recalcularIdentidade',
        dados: {},
      });
    });

    it('conflito de versão mantém a mensagem, recarrega e não perde a tela', async () => {
      const api = criarApiFalsa({
        executarComando: async () =>
          Promise.reject(
            erroApi(
              409,
              'O registro foi alterado por outra pessoa. Recarregue e revise antes de continuar.',
              'CONFLITO_DE_VERSAO',
            ),
          ),
      });
      renderizarApp(CAMINHO, api, PERFIL_REVISOR);
      await screen.findByRole('heading', { level: 1 });
      await userEvent.click(botao('Aprovar'));
      await confirmarNoDialogo('Aprovar');

      expect((await screen.findByRole('alert')).textContent).toContain('alterado por outra pessoa');
      await waitFor(() => expect(api.detalharPedido).toHaveBeenCalledTimes(2));
    });

    it('o auditor só consulta: nenhuma ação de escrita aparece', async () => {
      renderizarApp(CAMINHO, criarApiFalsa(), PERFIL_AUDITOR);
      await screen.findByRole('heading', { level: 1 });
      for (const nome of ['Aprovar', 'Rejeitar', 'Editar identidade', 'Reabrir para revisão']) {
        expect(screen.queryByRole('button', { name: nome })).toBeNull();
      }
    });
  });

  describe('execução', () => {
    const aprovado = () =>
      detalhe({
        status: 'aprovado',
        itens: [itemResultado(), itemResultado({ id: ID_ITEM_JIRA, sistema: 'jira' })],
      });

    it('provisiona todos: execução aceita é só a intenção na fila', async () => {
      const api = criarApiFalsa({
        detalharPedido: async () => aprovado(),
        executarComando: async () => ({
          ok: true,
          status: 'aprovado',
          versao: 4,
          operacaoId: '77777777-7777-4777-8777-777777777777',
          operacaoIds: [
            '77777777-7777-4777-8777-777777777777',
            '88888888-8888-4888-8888-888888888888',
          ],
        }),
      });
      renderizarApp(CAMINHO, api);
      await userEvent.click(
        await screen.findByRole('button', { name: 'Provisionar todos os itens' }),
      );
      expect(screen.getByText(/Resultado simulado nunca vira confirmação/)).toBeTruthy();
      await confirmarNoDialogo('Solicitar execução');
      expect(api.executarComando).toHaveBeenCalledWith(ID_PEDIDO, 3, {
        acao: 'solicitarExecucao',
        dados: { itemIds: [ID_ITEM_AD, ID_ITEM_JIRA] },
      });
      expect(await screen.findByText(/Execução aceita: 2 operação\(ões\) na fila/)).toBeTruthy();
    });

    it('lote misto: item ocupado fica de fora e só os livres seguem em itemIds', async () => {
      const api = criarApiFalsa({
        detalharPedido: async () =>
          detalhe({
            status: 'aprovado',
            itens: [
              itemResultado({ operacoes: [operacaoSimulada('pendente')] }),
              itemResultado({ id: ID_ITEM_JIRA, sistema: 'jira' }),
            ],
          }),
        executarComando: async () => ({
          ok: true,
          status: 'aprovado',
          versao: 4,
          operacaoId: '77777777-7777-4777-8777-777777777777',
          operacaoIds: ['77777777-7777-4777-8777-777777777777'],
        }),
      });
      renderizarApp(CAMINHO, api);
      await userEvent.click(
        await screen.findByRole('button', { name: 'Provisionar todos os itens' }),
      );
      await confirmarNoDialogo('Solicitar execução');
      expect(api.executarComando).toHaveBeenCalledTimes(1);
      expect(api.executarComando).toHaveBeenCalledWith(ID_PEDIDO, 3, {
        acao: 'solicitarExecucao',
        dados: { itemIds: [ID_ITEM_JIRA] },
      });
      expect(await screen.findByText(/Execução aceita: 1 operação\(ões\) na fila/)).toBeTruthy();
    });

    it('provisiona um item só, enviando o ID do item', async () => {
      const api = criarApiFalsa({ detalharPedido: async () => aprovado() });
      renderizarApp(CAMINHO, api);
      await userEvent.click(await screen.findByRole('button', { name: 'Provisionar Jira' }));
      await confirmarNoDialogo('Solicitar execução');
      expect(api.executarComando).toHaveBeenCalledWith(ID_PEDIDO, 3, {
        acao: 'solicitarExecucao',
        dados: { itemIds: [ID_ITEM_JIRA] },
      });
    });

    it('item confirmado não oferece nova execução (regra 4); o executor só aparece com permissão', async () => {
      const api = criarApiFalsa({
        detalharPedido: async () =>
          detalhe({
            status: 'concluido',
            itens: [
              itemResultado({
                status: 'confirmado',
                idExterno: 'ad-guid-1',
                confirmadoEm: '2026-10-14T12:30:00.000Z',
              }),
            ],
          }),
      });
      renderizarApp(CAMINHO, api);
      expect(await screen.findByText('Confirmado')).toBeTruthy();
      expect(screen.getByText(/ID no destino: ad-guid-1/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Provisionar|Reprocessar/ })).toBeNull();
    });

    it('o revisor não executa operações', async () => {
      renderizarApp(
        CAMINHO,
        criarApiFalsa({ detalharPedido: async () => aprovado() }),
        PERFIL_REVISOR,
      );
      await screen.findByRole('heading', { level: 1 });
      expect(screen.queryByRole('button', { name: /Provisionar/ })).toBeNull();
      expect(screen.getByRole('button', { name: 'Reabrir para revisão' })).toBeTruthy();
    });

    it('em execução: atualiza o resultado por item sem recarregar a página', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let chamadas = 0;
      const api = criarApiFalsa({
        detalharPedido: async () => {
          chamadas += 1;
          return chamadas === 1
            ? detalhe({ status: 'emExecucao', itens: [itemResultado({ status: 'emExecucao' })] })
            : detalhe({
                status: 'concluido',
                itens: [itemResultado({ status: 'confirmado' })],
              });
        },
      });
      renderizarApp(CAMINHO, api);
      expect(await screen.findByText(/Execução em andamento/)).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      expect(await screen.findByText('Confirmado')).toBeTruthy();
      expect(screen.queryByText(/Execução em andamento/)).toBeNull();
      // Concluído: para de consultar.
      const total = api.detalharPedido.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(api.detalharPedido.mock.calls.length).toBe(total);
    });

    it('simulação: acompanha operação pendente → reservada → concluída sem confirmar acesso real', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const fases = ['pendente', 'reservada', 'concluida'] as const;
      let chamadas = 0;
      const api = criarApiFalsa({
        detalharPedido: async () => {
          const fase = fases[Math.min(chamadas, fases.length - 1)]!;
          chamadas += 1;
          return detalhe({
            status: 'aprovado',
            itens: [itemResultado({ operacoes: [operacaoSimulada(fase)] })],
          });
        },
      });
      renderizarApp(CAMINHO, api);
      expect(await screen.findByText(/Execução em andamento/)).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      await waitFor(() => expect(api.detalharPedido).toHaveBeenCalledTimes(2));
      expect(screen.getByText(/Execução em andamento/)).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      await waitFor(() => expect(api.detalharPedido).toHaveBeenCalledTimes(3));
      // Sem operação ativa: o aviso some, o item segue sem confirmação e a consulta para.
      await waitFor(() => expect(screen.queryByText(/Execução em andamento/)).toBeNull());
      expect(screen.queryByText('Confirmado')).toBeNull();
      expect(screen.getByRole('list', { name: 'Operações do item' }).textContent).toContain(
        'simulado, não confirma acesso real',
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(api.detalharPedido).toHaveBeenCalledTimes(3);
    });

    it('401 durante a atualização em segundo plano troca os dados por "sessão expirou"', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let chamadas = 0;
      const api = criarApiFalsa({
        detalharPedido: async () => {
          chamadas += 1;
          if (chamadas > 1) throw erroApi(401);
          return detalhe({
            status: 'aprovado',
            itens: [itemResultado({ operacoes: [operacaoSimulada('pendente')] })],
          });
        },
      });
      const { router } = renderizarApp(CAMINHO, api);
      expect(await screen.findByText('100.***.***-09')).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      expect(await screen.findByText(/Sua sessão expirou/)).toBeTruthy();
      expect(screen.queryByText('100.***.***-09')).toBeNull();
      expect(screen.queryByText('100.***.***-09')).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(api.detalharPedido).toHaveBeenCalledTimes(2);

      await userEvent.click(screen.getByRole('button', { name: 'Entrar novamente' }));
      expect(router.state.location.pathname).toBe('/login');
    });

    it('403 durante a atualização em segundo plano remove os dados e mostra falta de permissão', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let chamadas = 0;
      const api = criarApiFalsa({
        detalharPedido: async () => {
          chamadas += 1;
          if (chamadas > 1) throw erroApi(403);
          return detalhe({
            status: 'aprovado',
            itens: [itemResultado({ operacoes: [operacaoSimulada('reservada')] })],
          });
        },
      });
      renderizarApp(CAMINHO, api);
      expect(await screen.findByText('100.***.***-09')).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      expect(await screen.findByText(/não tem permissão/)).toBeTruthy();
      expect(screen.queryByText('100.***.***-09')).toBeNull();
    });

    it('falha transitória na atualização mantém os dados, avisa e se recupera', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let chamadas = 0;
      const api = criarApiFalsa({
        detalharPedido: async () => {
          chamadas += 1;
          if (chamadas === 2) throw erroApi(503);
          return detalhe({
            status: 'aprovado',
            itens: [itemResultado({ operacoes: [operacaoSimulada('pendente')] })],
          });
        },
      });
      renderizarApp(CAMINHO, api);
      expect(await screen.findByText('100.***.***-09')).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      expect(await screen.findByText(/Não foi possível atualizar agora/)).toBeTruthy();
      expect(screen.getByText('100.***.***-09')).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      await waitFor(() =>
        expect(screen.queryByText(/Não foi possível atualizar agora/)).toBeNull(),
      );
      expect(screen.getByText('100.***.***-09')).toBeTruthy();
    });

    it('a confirmação aberta é invalidada quando o pedido muda por atualização em segundo plano', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let chamadas = 0;
      const api = criarApiFalsa({
        detalharPedido: async () => {
          chamadas += 1;
          return detalhe({
            status: 'aprovado',
            versao: chamadas === 1 ? 3 : 4,
            itens: [itemResultado({ operacoes: [operacaoSimulada('pendente')] })],
          });
        },
      });
      renderizarApp(CAMINHO, api);
      await userEvent.click(await screen.findByRole('button', { name: 'Reabrir para revisão' }));
      expect(await screen.findByRole('dialog')).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.getByRole('alert').textContent).toContain('foi alterado');
      expect(api.executarComando).not.toHaveBeenCalled();
    });
  });

  describe('conflito de versão', () => {
    it('fecha a confirmação, avisa fora do diálogo e exige nova confirmação na versão atual', async () => {
      let chamadas = 0;
      const api = criarApiFalsa({
        detalharPedido: async () => {
          chamadas += 1;
          return chamadas === 1
            ? detalhe({ versao: 3 })
            : detalhe({
                versao: 4,
                revisao: {
                  ...detalhe().revisao,
                  identidade: { ...detalhe().revisao.identidade!, login: 'maria.souza2' },
                },
              });
        },
        executarComando: vi
          .fn()
          .mockRejectedValueOnce(
            erroApi(409, 'O registro foi alterado por outra pessoa.', 'CONFLITO_DE_VERSAO'),
          )
          .mockResolvedValue({ ok: true, status: 'aprovado', versao: 5, operacaoId: null }),
      });
      renderizarApp(CAMINHO, api, PERFIL_REVISOR);
      await screen.findByRole('heading', { level: 1 });
      await userEvent.click(botao('Aprovar'));
      await confirmarNoDialogo('Aprovar');

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      const alerta = await screen.findByRole('alert');
      expect(alerta.textContent).toContain('alterado por outra pessoa');
      expect(alerta.textContent).toContain('confirme a ação de novo');
      expect(await screen.findByText(/versão 4/)).toBeTruthy();
      expect(screen.getByText('maria.souza2')).toBeTruthy();
      // A confirmação antiga não executa na versão nova.
      expect(api.executarComando).toHaveBeenCalledTimes(1);
      expect(api.executarComando).toHaveBeenLastCalledWith(ID_PEDIDO, 3, {
        acao: 'aprovar',
        dados: {},
      });

      // Só uma nova abertura, depois de rever, vale para a versão 4.
      await userEvent.click(botao('Aprovar'));
      await confirmarNoDialogo('Aprovar');
      expect(api.executarComando).toHaveBeenCalledTimes(2);
      expect(api.executarComando).toHaveBeenLastCalledWith(ID_PEDIDO, 4, {
        acao: 'aprovar',
        dados: {},
      });
    });
  });

  describe('registro de acesso manual', () => {
    const comItens = (status: Parameters<typeof detalhe>[0] = {}) =>
      detalhe({
        status: 'aprovado',
        itens: [
          itemResultado({ status: 'pendente' }),
          itemResultado({ id: ID_ITEM_JIRA, sistema: 'jira', status: 'confirmado' }),
        ],
        ...status,
      });

    it('aparece em pedido aprovado com item pendente e lista só os itens elegíveis', async () => {
      renderizarApp(CAMINHO, criarApiFalsa({ detalharPedido: async () => comItens() }));
      await userEvent.click(await screen.findByRole('button', { name: 'Registrar acesso manual' }));
      const dialogo = await screen.findByRole('dialog');
      const opcoes = within(dialogo).getAllByRole('option');
      expect(opcoes).toHaveLength(1);
      expect((opcoes[0] as HTMLOptionElement).value).toBe(ID_ITEM_AD);
    });

    it.each(['concluido', 'rejeitado', 'pendenteAprovacao'] as const)(
      'não aparece com o pedido %s',
      async (status) => {
        renderizarApp(CAMINHO, criarApiFalsa({ detalharPedido: async () => comItens({ status }) }));
        await screen.findByRole('heading', { level: 1 });
        expect(screen.queryByRole('button', { name: 'Registrar acesso manual' })).toBeNull();
      },
    );

    it.each(['confirmado', 'desconhecido', 'emExecucao'] as const)(
      'não aparece quando o único item está %s',
      async (status) => {
        renderizarApp(
          CAMINHO,
          criarApiFalsa({
            detalharPedido: async () =>
              detalhe({ status: 'aprovado', itens: [itemResultado({ status })] }),
          }),
        );
        await screen.findByRole('heading', { level: 1 });
        expect(screen.queryByRole('button', { name: 'Registrar acesso manual' })).toBeNull();
      },
    );

    it.each(['pendente', 'reservada'] as const)(
      'não aparece quando o item tem operação %s',
      async (fase) => {
        renderizarApp(
          CAMINHO,
          criarApiFalsa({
            detalharPedido: async () =>
              detalhe({
                status: 'aprovado',
                itens: [itemResultado({ operacoes: [operacaoSimulada(fase)] })],
              }),
          }),
        );
        await screen.findByRole('heading', { level: 1 });
        expect(screen.queryByRole('button', { name: 'Registrar acesso manual' })).toBeNull();
        expect(screen.queryByRole('button', { name: /Provisionar/ })).toBeNull();
      },
    );

    it.each([
      ['revisor', PERFIL_REVISOR],
      ['auditor', PERFIL_AUDITOR],
    ] as const)('não aparece para o perfil %s', async (_nome, perfil) => {
      renderizarApp(CAMINHO, criarApiFalsa({ detalharPedido: async () => comItens() }), perfil);
      await screen.findByRole('heading', { level: 1 });
      expect(screen.queryByRole('button', { name: 'Registrar acesso manual' })).toBeNull();
    });
  });

  describe('resultado por sistema', () => {
    it('sucesso parcial nunca aparece como concluído e oferece reprocessar e registrar manual', async () => {
      const api = criarApiFalsa({
        detalharPedido: async () =>
          detalhe({
            status: 'concluidoComErros',
            itens: [
              itemResultado({
                status: 'parcial',
                etapaAlcancada: 'habilitarConta',
                mensagem: 'Grupo não adicionado.',
              }),
              itemResultado({ id: ID_ITEM_JIRA, sistema: 'jira', status: 'confirmado' }),
            ],
          }),
      });
      renderizarApp(CAMINHO, api);
      expect(await screen.findByText(/sucesso parcial não é conclusão/)).toBeTruthy();
      expect(screen.getByText('Parcial')).toBeTruthy();
      expect(screen.getByText(/Última etapa: habilitarConta/)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Reprocessar pendentes e com erro' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Reprocessar Active Directory' })).toBeTruthy();

      await userEvent.click(screen.getByRole('button', { name: 'Registrar acesso manual' }));
      const dialogo = await screen.findByRole('dialog');
      const registrar = within(dialogo).getByRole('button', { name: 'Registrar' });
      expect((registrar as HTMLButtonElement).disabled).toBe(true);
      await userEvent.selectOptions(within(dialogo).getByLabelText('Item'), ID_ITEM_AD);
      await userEvent.type(within(dialogo).getByLabelText('Observação'), 'Grupo adicionado à mão');
      await userEvent.click(registrar);
      expect(api.executarComando).toHaveBeenCalledWith(ID_PEDIDO, 3, {
        acao: 'registrarAcessoManual',
        dados: { itemId: ID_ITEM_AD, observacao: 'Grupo adicionado à mão' },
      });
    });

    it('resultado desconhecido orienta a conferir e não oferece repetir a escrita', async () => {
      renderizarApp(
        CAMINHO,
        criarApiFalsa({
          detalharPedido: async () =>
            detalhe({
              status: 'concluidoComErros',
              itens: [itemResultado({ status: 'desconhecido' })],
            }),
        }),
      );
      expect(await screen.findByText(/confira o destino antes de tentar de novo/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /^Reprocessar Active Directory$/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /Reprocessar pendentes/ })).toBeNull();
      expect(screen.getByText(/Conferir existência e reconciliar/)).toBeTruthy();
    });

    it('operações simuladas são identificadas e não confirmam acesso real', async () => {
      renderizarApp(
        CAMINHO,
        criarApiFalsa({
          detalharPedido: async () =>
            detalhe({
              status: 'aprovado',
              itens: [
                itemResultado({
                  operacoes: [
                    {
                      id: '99999999-9999-4999-8999-999999999999',
                      acao: 'provisionar',
                      modo: 'simulado',
                      status: 'concluida',
                      efeito: 'confirmado',
                      codigo: 'OK',
                      mensagem: null,
                      tentativas: 1,
                      criadaEm: '2026-10-14T12:00:00.000Z',
                      atualizadaEm: '2026-10-14T12:01:00.000Z',
                    },
                  ],
                }),
              ],
            }),
        }),
      );
      const lista = await screen.findByRole('list', { name: 'Operações do item' });
      expect(lista.textContent).toContain('simulado, não confirma acesso real');
      expect(screen.getByText('Pendente')).toBeTruthy();
    });
  });

  it('rejeitado e concluído com erros podem ser reabertos com motivo', async () => {
    const api = criarApiFalsa({
      detalharPedido: async () => detalhe({ status: 'rejeitado', motivoRejeicao: 'Duplicado' }),
    });
    renderizarApp(CAMINHO, api);
    expect(await screen.findByText(/Motivo da rejeição: Duplicado/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Reabrir para revisão' }));
    const dialogo = await screen.findByRole('dialog');
    await userEvent.type(within(dialogo).getByLabelText('Motivo'), 'Corrigido pelo RH');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Reabrir' }));
    expect(api.executarComando).toHaveBeenCalledWith(ID_PEDIDO, 3, {
      acao: 'reabrir',
      dados: { motivo: 'Corrigido pelo RH' },
    });
  });
});
