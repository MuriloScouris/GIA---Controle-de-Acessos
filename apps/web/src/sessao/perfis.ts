/**
 * Perfis de demonstração da sessão simulada. Dados falsos: nenhum usuário, e-mail ou
 * credencial real. Serão substituídos pelo perfil vindo do servidor (Entra ID/OIDC).
 */
export type PerfilId = 'administradorGia' | 'revisor' | 'auditor';

export interface PerfilDemo {
  readonly id: PerfilId;
  readonly nome: string;
  readonly descricao: string;
}

export const PERFIS_DEMO: readonly PerfilDemo[] = [
  {
    id: 'administradorGia',
    nome: 'Administrador do Gia',
    descricao: 'Acompanha pedidos, decide, executa e consulta a auditoria.',
  },
  {
    id: 'revisor',
    nome: 'Revisor/aprovador',
    descricao: 'Ajusta propostas e aprova ou rejeita pedidos.',
  },
  {
    id: 'auditor',
    nome: 'Auditor',
    descricao: 'Consulta o histórico e exporta evidências, somente leitura.',
  },
];

export function encontrarPerfil(id: string | null | undefined): PerfilDemo | null {
  return PERFIS_DEMO.find((perfil) => perfil.id === id) ?? null;
}
