import { NOMES_SISTEMA, type Sistema, type StatusItem, type StatusPedido } from '@gia/dominio';
import type { OperacaoResumo } from '@gia/contratos';

export const ROTULO_STATUS_PEDIDO: Readonly<Record<StatusPedido, string>> = {
  pendenteAprovacao: 'Pendente de aprovação',
  aprovado: 'Aprovado',
  emExecucao: 'Em execução',
  concluidoComErros: 'Concluído com erros',
  concluido: 'Concluído',
  rejeitado: 'Rejeitado',
};

export const STATUS_PEDIDO_ORDEM: readonly StatusPedido[] = [
  'pendenteAprovacao',
  'aprovado',
  'emExecucao',
  'concluidoComErros',
  'concluido',
  'rejeitado',
];

export const ROTULO_STATUS_ITEM: Readonly<Record<StatusItem, string>> = {
  pendente: 'Pendente',
  aguardandoDependencia: 'Aguardando dependência',
  emExecucao: 'Em execução',
  parcial: 'Parcial',
  falhou: 'Falhou',
  desconhecido: 'Desconhecido: conferir antes de tentar de novo',
  confirmado: 'Confirmado',
  registradoManual: 'Registrado manualmente',
};

export const ROTULO_VINCULO = { celetista: 'Celetista', terceiro: 'Terceiro' } as const;

export const ROTULO_ACAO_OPERACAO: Readonly<Record<OperacaoResumo['acao'], string>> = {
  provisionar: 'Provisionar',
  revogar: 'Revogar',
  validar: 'Validar',
  conferirExistencia: 'Conferir existência',
};

export const ROTULO_STATUS_OPERACAO: Readonly<Record<OperacaoResumo['status'], string>> = {
  pendente: 'Na fila',
  reservada: 'Em andamento',
  aguardandoReconciliacao: 'Aguardando reconciliação',
  concluida: 'Concluída',
  reconciliada: 'Reconciliada',
  cancelada: 'Cancelada',
};

export const ROTULO_EFEITO = {
  confirmado: 'Confirmado',
  parcial: 'Parcial',
  semEfeito: 'Sem efeito',
  desconhecido: 'Desconhecido',
} as const;

export const ROTULO_ORIGEM_IDENTIDADE = {
  emailCorporativoRh: 'E-mail corporativo informado pelo RH',
  ajusteManual: 'Ajuste manual',
} as const;

export const ROTULO_SITUACAO_IDENTIDADE = {
  livre: 'Livre nos diretórios',
  emUsoPelaMesmaPessoa: 'Já em uso pela mesma pessoa',
  emUsoPorOutraPessoa: 'Em uso por outra pessoa: ajuste a identidade',
} as const;

export function nomeSistema(sistema: Sistema): string {
  return NOMES_SISTEMA[sistema];
}

export function formatarInstante(instante: string): string {
  const data = new Date(instante);
  return Number.isNaN(data.getTime())
    ? instante
    : data.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}
