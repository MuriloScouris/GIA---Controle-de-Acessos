import type { Generated } from 'kysely';

/**
 * Tipos das tabelas para o Kysely (ver `migracoes/`). `dados` guarda a
 * entidade inteira do domínio; as demais colunas são derivadas dela na
 * gravação e servem a restrições e consultas.
 */
interface Linha {
  id: string;
  ordem: Generated<string>;
  dados: unknown;
}

export interface BancoGia {
  colaboradores: Linha & { cpf: string; versao: number };
  pedidos: Linha & { chave_origem: string; colaborador_id: string; status: string; versao: number };
  revisoes: Linha & { pedido_id: string; numero: number; situacao: string };
  itens: Linha & {
    pedido_id: string;
    revisao_id: string;
    sistema: string;
    status: string;
    versao: number;
  };
  operacoes: Linha & {
    pedido_id: string;
    item_id: string;
    depende_de_item_id: string | null;
    chave_idempotencia: string;
    status: string;
    disponivel_em: string;
    lease_worker_id: string | null;
    lease_expira_em: string | null;
    versao: number;
  };
  eventos: Linha & {
    tipo: string;
    instante: string;
    pedido_id: string | null;
    operacao_id: string | null;
    colaborador_id: string | null;
    corrige_evento_id: string | null;
  };
}
