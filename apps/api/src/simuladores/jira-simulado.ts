import type { FonteChamadosJira } from '../aplicacao/portas.js';
import { cpfFicticio } from './cpf-ficticio.js';

/**
 * Jira simulado: devolve uma fixture fixa e nunca abre conexão de rede. A
 * leitura real (REST + JQL, paginação) fica para o worker de ingestão.
 */
export function criarJiraSimulado(chamados: readonly unknown[] = CHAMADOS_JIRA_FICTICIOS): {
  readonly fonte: FonteChamadosJira;
  readonly leituras: () => number;
} {
  let leituras = 0;
  return {
    fonte: {
      async buscarChamadosOnboarding() {
        leituras += 1;
        return structuredClone(chamados);
      },
    },
    leituras: () => leituras,
  };
}

function chamado(
  key: string,
  tipoSolicitacao: string,
  campos: {
    nomeCompleto: string;
    cpf: string;
    matricula: string | null;
    emailCorporativo: string | null;
    area: string;
    cargo: string;
  },
): unknown {
  return {
    key,
    fields: {
      tipoSolicitacao,
      ...campos,
      dataAdmissao: '2026-11-03',
      gestor: 'Gestora Fictícia',
      // Campo que a normalização descarta.
      customfield_10099: 'ignorado',
    },
  };
}

/** Todos os dados são fictícios (nomes, CPFs gerados, domínio `exemplo.com.br`). */
export const CHAMADOS_JIRA_FICTICIOS: readonly unknown[] = [
  chamado('RH-1001', 'Admissão - Celetista', {
    nomeCompleto: 'Maria Ficticia Souza',
    cpf: cpfFicticio('100000001'),
    matricula: 'M1001',
    emailCorporativo: 'maria.souza@exemplo.com.br',
    area: 'Tecnologia',
    cargo: 'Analista',
  }),
  chamado('RH-1002', 'Admissão - Terceiro', {
    nomeCompleto: 'Carlos Ficticio Lima',
    cpf: cpfFicticio('100000002'),
    matricula: null,
    emailCorporativo: 'carlos.lima@exemplo.com.br',
    area: 'Financeiro',
    cargo: 'Consultor',
  }),
  // E-mail já usado no AD por outra pessoa: a aprovação exige ajuste humano.
  chamado('RH-1003', 'Admissão - Celetista', {
    nomeCompleto: 'Joao Ficticio Pereira',
    cpf: cpfFicticio('100000003'),
    matricula: 'M1003',
    emailCorporativo: 'joao.pereira@exemplo.com.br',
    area: 'Financeiro',
    cargo: 'Coordenador',
  }),
  // Mesma issue lida de novo (ex.: outra página da busca): não gera outro pedido.
  chamado('RH-1001', 'Admissão - Celetista', {
    nomeCompleto: 'Maria Ficticia Souza',
    cpf: cpfFicticio('100000001'),
    matricula: 'M1001',
    emailCorporativo: 'maria.souza@exemplo.com.br',
    area: 'Tecnologia',
    cargo: 'Analista',
  }),
  // Offboarding está em standby: o tipo é ignorado.
  chamado('RH-1004', 'Desligamento', {
    nomeCompleto: 'Pessoa Ficticia Desligada',
    cpf: cpfFicticio('100000004'),
    matricula: 'M1004',
    emailCorporativo: null,
    area: 'Geral',
    cargo: 'Assistente',
  }),
  chamado('RH-1005', 'Admissão - Celetista', {
    nomeCompleto: 'Pessoa Ficticia Cpf Invalido',
    cpf: '111.111.111-11',
    matricula: null,
    emailCorporativo: 'cpf.invalido@exemplo.com.br',
    area: 'Geral',
    cargo: 'Assistente',
  }),
  { key: 'RH-1006', fields: { tipoSolicitacao: 'Admissão - Celetista' } },
  // Sem e-mail corporativo: a proposta nasce com pendência de identidade.
  chamado('RH-1007', 'Admissão - Celetista', {
    nomeCompleto: 'Ana Ficticia Rocha',
    cpf: cpfFicticio('100000007'),
    matricula: 'M1007',
    emailCorporativo: null,
    area: 'Comercial',
    cargo: 'Vendedora',
  }),
];
