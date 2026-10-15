import type {
  ListaPedidos,
  PedidoDetalhe,
  ResultadoImportacao,
  ResultadoItem,
  ResumoPedido,
} from '@gia/contratos';
import { render } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { ApiProvider } from '../api/ApiProvider.js';
import { ErroApi, type ClienteApi } from '../api/cliente.js';
import { rotas } from '../rotas.js';
import { PERFIS_DEMO, type PerfilDemo } from '../sessao/perfis.js';
import { SessaoProvider } from '../sessao/Sessao.js';

export const ID_PEDIDO = '11111111-1111-4111-8111-111111111111';
export const ID_ITEM_AD = '22222222-2222-4222-8222-222222222222';
export const ID_ITEM_JIRA = '33333333-3333-4333-8333-333333333333';
export const AGORA = '2026-10-14T12:00:00.000Z';

export const PERFIL_ADMIN = PERFIS_DEMO.find((p) => p.id === 'administradorGia')!;
export const PERFIL_REVISOR = PERFIS_DEMO.find((p) => p.id === 'revisor')!;
export const PERFIL_AUDITOR = PERFIS_DEMO.find((p) => p.id === 'auditor')!;

export function resumo(n: number, extra: Partial<ResumoPedido> = {}): ResumoPedido {
  const sufixo = String(n).padStart(12, '0');
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${sufixo}`,
    idExterno: `RH-${1000 + n}`,
    tipoVinculo: 'celetista',
    status: 'pendenteAprovacao',
    versao: 1,
    nomeColaborador: `Pessoa Ficticia ${n}`,
    criadoEm: AGORA,
    atualizadoEm: AGORA,
    ...extra,
  };
}

export function itemResultado(extra: Partial<ResultadoItem> = {}): ResultadoItem {
  return {
    id: ID_ITEM_AD,
    sistema: 'ad',
    status: 'pendente',
    versao: 1,
    idExterno: null,
    mensagem: null,
    etapaAlcancada: null,
    confirmadoEm: null,
    observacaoManual: null,
    herdadoDeItemId: null,
    operacoes: [],
    ...extra,
  };
}

export function detalhe(extra: Partial<PedidoDetalhe> = {}): PedidoDetalhe {
  return {
    id: ID_PEDIDO,
    origem: { sistema: 'jira', idExterno: 'RH-1001' },
    tipoVinculo: 'celetista',
    status: 'pendenteAprovacao',
    versao: 3,
    motivoRejeicao: null,
    criadoEm: AGORA,
    atualizadoEm: AGORA,
    colaboradorId: '44444444-4444-4444-8444-444444444444',
    dadosRh: {
      nomeCompleto: 'Maria Ficticia Souza',
      cpf: '100.***.***-09',
      matricula: 'M1001',
      emailCorporativoSugerido: 'maria.souza@exemplo.com.br',
      area: 'Tecnologia',
      cargo: 'Analista',
      dataAdmissao: '2026-11-03',
      gestor: 'Gestora Ficticia',
    },
    revisao: {
      id: '55555555-5555-4555-8555-555555555555',
      numero: 1,
      situacao: 'rascunho',
      versaoRegras: 'regras-1',
      identidade: {
        login: 'maria.souza',
        upn: 'maria.souza@exemplo.com.br',
        email: 'maria.souza@exemplo.com.br',
        proxyAddresses: [],
        nomeExibicao: 'Maria Ficticia Souza',
        origem: 'emailCorporativoRh',
      },
      pendenciaIdentidade: null,
      verificacaoIdentidade: {
        situacao: 'livre',
        conflitos: [],
        verificadaEm: AGORA,
      },
      itens: [
        {
          sistema: 'ad',
          parametros: { sistema: 'ad', login: 'maria.souza', grupos: ['GG-Tecnologia', 'GG-VPN'] },
          origemSugestao: 'Regra da área Tecnologia',
        },
        {
          sistema: 'jira',
          parametros: { sistema: 'jira', email: 'maria.souza@exemplo.com.br', grupos: [] },
          origemSugestao: 'Regra do cargo Analista',
        },
      ],
      aprovadaPor: null,
      aprovadaEm: null,
    },
    itens: [],
    ...extra,
  };
}

export function importacao(extra: Partial<ResultadoImportacao> = {}): ResultadoImportacao {
  return { criados: [], duplicados: [], ignorados: [], recusados: [], ...extra };
}

type Falsa = { [K in keyof ClienteApi]: Mock<ClienteApi[K]> };

/** Cliente da API falso: cada método é um `vi.fn` com resposta padrão de sucesso. */
export function criarApiFalsa(sobrescritas: Partial<ClienteApi> = {}): Falsa {
  const lista: ListaPedidos = { pedidos: [] };
  const base: ClienteApi = {
    saude: async () => ({ status: 'ok' }),
    abrirSessaoSimulada: async () => ({
      usuarioId: '66666666-6666-4666-8666-666666666666',
      nome: 'Pessoa Ficticia',
      papeis: ['revisor'],
      expiraEm: '2026-10-14T20:00:00.000Z',
    }),
    encerrarSessao: async () => undefined,
    listarPedidos: async () => lista,
    detalharPedido: async () => detalhe(),
    consultarHistorico: async () => ({ pedidoId: ID_PEDIDO, eventos: [], proximoCursor: null }),
    importarDoJira: async () => importacao(),
    executarComando: async () => ({ ok: true, status: 'aprovado', versao: 4, operacaoId: null }),
  };
  const todas = { ...base, ...sobrescritas };
  return Object.fromEntries(
    Object.entries(todas).map(([nome, fn]) => [nome, vi.fn(fn)]),
  ) as unknown as Falsa;
}

export function erroApi(status: number, mensagem = 'Falha', codigo?: string): ErroApi {
  return new ErroApi(mensagem, status, codigo);
}

export function renderizarApp(
  caminho: string,
  api: ClienteApi,
  perfil: PerfilDemo | null = PERFIL_ADMIN,
): { router: ReturnType<typeof createMemoryRouter> } {
  const router = createMemoryRouter(rotas, { initialEntries: [caminho] });
  render(
    <ApiProvider api={api}>
      <SessaoProvider perfilInicial={perfil}>
        <RouterProvider router={router} />
      </SessaoProvider>
    </ApiProvider>,
  );
  return { router };
}
