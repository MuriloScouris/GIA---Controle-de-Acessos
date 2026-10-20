import type { Sistema } from '@gia/dominio';

export type Estado = 'ok' | 'bloqueado' | 'pendente' | 'naoExecutado';
export type Codigo =
  | 'OK'
  | 'ESCRITA_DEVE_ESTAR_DESLIGADA'
  | 'SEGREDO_INLINE_RECUSADO'
  | 'AMBIENTE_INVALIDO'
  | 'CONFIGURACAO_INVALIDA'
  | 'REAL_NAO_SELECIONADO'
  | 'ARQUIVO_AUSENTE_OU_INVALIDO'
  | 'ARQUIVO_PERMISSAO_ABERTA'
  | 'DNS_INDISPONIVEL'
  | 'TCP_INDISPONIVEL'
  | 'TLS_INVALIDO'
  | 'TEMPO_ESGOTADO'
  | 'DEPENDENCIA_BLOQUEADA'
  | 'OFFLINE_NAO_VALIDA_REDE'
  | 'AUTENTICACAO_RECUSADA'
  | 'CREDENCIAL_EXPIRADA'
  | 'LIMITE_DE_TAXA'
  | 'CONSENTIMENTO_PENDENTE'
  | 'CONTA_SEM_ACESSO'
  | 'PERMISSAO_LEITURA_NEGADA'
  | 'RESPOSTA_INVALIDA'
  | 'SERVICO_INDISPONIVEL'
  | 'LEITURA_NAO_VALIDADA'
  | 'CAMPOS_INVALIDOS'
  | 'SEM_AMOSTRA_DOS_DOIS_VINCULOS'
  | 'API_NAO_CONFIGURADA'
  | 'API_INTERNA_NAO_CONFIGURADA'
  | 'API_NAO_PRONTA'
  | 'API_ESCRITA_HABILITADA'
  | 'API_PROTECAO_INVALIDA'
  | 'WORKER_SEM_BATIMENTO'
  | 'REVISAO_ADMINISTRATIVA_NECESSARIA'
  | 'ENSAIO_AUTORIZADO_PENDENTE';
export type NomeCheck =
  | 'ambiente'
  | 'gates'
  | 'cofreBanco'
  | 'segredosInline'
  | 'configuracao'
  | 'cofre'
  | 'dns'
  | 'tcp'
  | 'tls'
  | 'autenticacaoLeitura'
  | 'camposOrigem'
  | 'vivacidadeApi'
  | 'prontidaoApi'
  | 'autorizacaoApi'
  | 'batimentoWorker'
  | 'contaServico'
  | 'permissoesEscrita'
  | 'consentimentos'
  | 'homologacao'
  | 'rollback';

export interface Check {
  readonly nome: NomeCheck;
  readonly estado: Estado;
  readonly codigo: Codigo;
  /** Índice do destino configurado; nunca hostname, DN, conta, caminho ou payload. */
  readonly destino?: number;
  readonly recurso?: 'credencial' | 'ca' | 'chavePrivada' | 'banco';
  readonly variaveis?: readonly string[];
}
export interface ResultadoSistema {
  readonly sistema: Sistema;
  readonly checks: readonly Check[];
}
export interface EvidenciaPreflight {
  readonly schema: 'gia.preflight.v1';
  readonly execucaoId: string;
  readonly geradoEm: string;
  readonly revisao: string | null;
  readonly ambiente: 'producao' | 'teste' | 'invalido';
  readonly somenteLeitura: true;
  readonly escritaHabilitada: false;
  /** Estado observado, distinto da garantia de que este comando não habilita escrita. */
  readonly gatesObservados: {
    readonly configuracao: 'desligada' | 'insegura';
    readonly api: 'desligada' | 'ligada' | 'naoConfirmada';
  };
  readonly producaoPronta: false;
  readonly leiturasValidadas: boolean;
  /** 1 = bloqueio técnico; 2 = leituras aprovadas, homologação manual pendente. */
  readonly codigoSaida: 1 | 2;
  readonly checks: readonly Check[];
  readonly sistemas: readonly ResultadoSistema[];
}
