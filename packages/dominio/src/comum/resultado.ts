import { sanitizar } from './sanitizacao.js';

/**
 * Códigos estáveis de recusa. A API devolve o código e a mensagem em
 * português; a interface decide o que mostrar a partir do código.
 */
export type CodigoErro =
  | 'DADO_INVALIDO'
  | 'CONFLITO_DE_VERSAO'
  | 'TRANSICAO_INVALIDA'
  | 'PERMISSAO_NEGADA'
  | 'ATOR_INFORMADO_PELO_CLIENTE'
  | 'SEGREDO_NAO_PERMITIDO'
  | 'CPF_INVALIDO'
  | 'MOTIVO_OBRIGATORIO'
  | 'OBSERVACAO_OBRIGATORIA'
  | 'ORIGEM_DIVERGENTE'
  | 'EMAIL_CORPORATIVO_INVALIDO'
  | 'LOGIN_EXCEDE_LIMITE'
  | 'IDENTIDADE_AUSENTE'
  | 'IDENTIDADE_NAO_VERIFICADA'
  | 'IDENTIDADE_EM_USO'
  | 'REVISAO_IMUTAVEL'
  | 'REVISAO_NAO_CORRENTE'
  | 'SISTEMA_DUPLICADO_NA_REVISAO'
  | 'SISTEMA_NAO_HABILITADO_PARA_VINCULO'
  | 'PARAMETROS_DE_OUTRO_SISTEMA'
  | 'NENHUM_ITEM_ELEGIVEL'
  | 'ITEM_JA_CONFIRMADO'
  | 'ITEM_EM_EXECUCAO'
  | 'ITEM_AGUARDANDO_CONFERENCIA'
  | 'ITEM_FORA_DO_PEDIDO'
  | 'ESCRITA_NAO_LIBERADA'
  | 'OPERACAO_JA_FINALIZADA'
  | 'LEASE_INDISPONIVEL'
  | 'LEASE_INVALIDO'
  | 'DEPENDENCIA_PENDENTE'
  | 'DEPENDENCIA_INVALIDA'
  | 'DEPENDENCIA_NAO_COMPROVADA'
  | 'DEPENDENCIA_DE_SISTEMA_AUSENTE'
  | 'ETAPA_DESCONHECIDA'
  | 'M365_NAO_CRIA_USUARIO'
  | 'CONFERENCIA_SIMULADA'
  | 'DESFECHO_DIVERGE_DA_CONFERENCIA'
  | 'EXISTENCIA_INCOMPLETA'
  | 'ETAPA_DE_RETOMADA_NAO_COMPROVADA'
  | 'DOCUMENTO_INDISPONIVEL'
  | 'EVENTO_DUPLICADO'
  | 'EVENTO_INEXISTENTE'
  | 'EVENTO_SEM_ATOR'
  // Fronteira HTTP: sessão, CSRF, recurso, ação ainda não disponível e falha inesperada.
  | 'NAO_AUTENTICADO'
  | 'CSRF_INVALIDO'
  | 'NAO_ENCONTRADO'
  | 'ACAO_INDISPONIVEL'
  | 'ERRO_INTERNO';

export const MENSAGENS_ERRO: Readonly<Record<CodigoErro, string>> = {
  DADO_INVALIDO: 'Dados inválidos.',
  CONFLITO_DE_VERSAO:
    'O registro foi alterado por outra pessoa. Recarregue e revise antes de continuar.',
  TRANSICAO_INVALIDA: 'Esta ação não é permitida no status atual.',
  PERMISSAO_NEGADA: 'Você não tem permissão para esta ação.',
  ATOR_INFORMADO_PELO_CLIENTE:
    'O autor da ação é identificado pela sessão e não pode ser enviado na requisição.',
  SEGREDO_NAO_PERMITIDO: 'Senhas, tokens e chaves não podem ser registrados no Gia.',
  CPF_INVALIDO: 'CPF inválido.',
  MOTIVO_OBRIGATORIO: 'Informe o motivo.',
  OBSERVACAO_OBRIGATORIA: 'Informe uma observação.',
  ORIGEM_DIVERGENTE: 'O pedido informado não corresponde à origem do chamado.',
  EMAIL_CORPORATIVO_INVALIDO:
    'E-mail corporativo ausente ou inválido. Corrija a identidade antes de aprovar.',
  LOGIN_EXCEDE_LIMITE:
    'O login derivado do e-mail passa de 20 caracteres. Ajuste a identidade manualmente.',
  IDENTIDADE_AUSENTE: 'A proposta não tem identidade definida.',
  IDENTIDADE_NAO_VERIFICADA: 'Verifique o uso da identidade nos sistemas antes de aprovar.',
  IDENTIDADE_EM_USO:
    'Login, e-mail ou UPN já está em uso por outra pessoa. Ajuste a identidade manualmente.',
  REVISAO_IMUTAVEL:
    'A revisão aprovada não pode ser alterada. Reabra o pedido para criar uma nova revisão.',
  REVISAO_NAO_CORRENTE: 'A revisão informada não é a revisão corrente do pedido.',
  SISTEMA_DUPLICADO_NA_REVISAO: 'Cada sistema pode aparecer uma única vez na revisão.',
  SISTEMA_NAO_HABILITADO_PARA_VINCULO: 'Sistema não habilitado para o tipo de vínculo do pedido.',
  PARAMETROS_DE_OUTRO_SISTEMA: 'Os parâmetros informados pertencem a outro sistema.',
  NENHUM_ITEM_ELEGIVEL: 'Nenhum item está elegível para esta ação.',
  ITEM_JA_CONFIRMADO: 'Item já confirmado; ele não é executado de novo.',
  ITEM_EM_EXECUCAO: 'O item já tem uma operação em andamento.',
  ITEM_AGUARDANDO_CONFERENCIA:
    'Resultado desconhecido: confira o item no sistema antes de tentar de novo.',
  ITEM_FORA_DO_PEDIDO: 'O item não pertence à revisão corrente do pedido.',
  ESCRITA_NAO_LIBERADA: 'A escrita neste sistema não está liberada.',
  OPERACAO_JA_FINALIZADA: 'A operação já foi finalizada.',
  LEASE_INDISPONIVEL: 'A operação não está disponível para reserva.',
  LEASE_INVALIDO: 'A reserva desta operação pertence a outro executor ou expirou.',
  DEPENDENCIA_PENDENTE: 'A operação aguarda a conclusão de uma dependência.',
  DEPENDENCIA_INVALIDA:
    'O item informado como dependência não é o item do qual a operação depende.',
  DEPENDENCIA_NAO_COMPROVADA:
    'O AD precisa estar confirmado pelo Gia antes do M365. Acesso registrado manualmente não comprova a identidade; comprove-o por conferência.',
  DEPENDENCIA_DE_SISTEMA_AUSENTE:
    'O Microsoft 365 exige o Active Directory junto: ele só licencia a identidade criada pelo AD e rastreada no mesmo pedido.',
  ETAPA_DESCONHECIDA: 'Etapa não reconhecida para o sistema.',
  M365_NAO_CRIA_USUARIO:
    'O Microsoft 365 não cria usuários; ele licencia a identidade sincronizada pelo AD.',
  CONFERENCIA_SIMULADA: 'Conferência simulada não serve de prova para reconciliação.',
  DESFECHO_DIVERGE_DA_CONFERENCIA:
    'O desfecho informado não corresponde ao que foi conferido no sistema.',
  EXISTENCIA_INCOMPLETA:
    'A conta existe, mas nem todos os acessos esperados foram encontrados no destino.',
  ETAPA_DE_RETOMADA_NAO_COMPROVADA:
    'A conferência não comprova até que etapa o acesso foi feito; sem esse ponto seguro, nada é escrito de novo.',
  DOCUMENTO_INDISPONIVEL: 'O documento de acessos só é emitido para pedidos concluídos.',
  EVENTO_DUPLICADO: 'Evento já registrado; eventos não são regravados.',
  EVENTO_INEXISTENTE: 'Evento não encontrado.',
  EVENTO_SEM_ATOR: 'Eventos originados no Gia precisam de ator.',
  NAO_AUTENTICADO: 'Sessão ausente ou expirada. Entre novamente.',
  CSRF_INVALIDO: 'Requisição de escrita sem a proteção contra falsificação (CSRF).',
  NAO_ENCONTRADO: 'Registro não encontrado.',
  ACAO_INDISPONIVEL: 'Esta ação ainda não está disponível nesta versão do Gia.',
  ERRO_INTERNO: 'Não foi possível concluir a ação. Recarregue e confira antes de tentar de novo.',
};

export interface ErroDominio {
  readonly codigo: CodigoErro;
  readonly mensagem: string;
  readonly detalhes?: Readonly<Record<string, unknown>>;
}

export type Resultado<T> =
  { readonly ok: true; readonly valor: T } | { readonly ok: false; readonly erro: ErroDominio };

export function sucesso<T>(valor: T): Resultado<T> {
  return { ok: true, valor };
}

export function falha<T = never>(
  codigo: CodigoErro,
  detalhes?: Readonly<Record<string, unknown>>,
): Resultado<T> {
  const erro: ErroDominio =
    detalhes === undefined
      ? { codigo, mensagem: MENSAGENS_ERRO[codigo] }
      : { codigo, mensagem: MENSAGENS_ERRO[codigo], detalhes: sanitizar(detalhes) };
  return { ok: false, erro };
}

/** Propaga uma falha de um tipo de resultado para outro. */
export function repassar<T>(resultado: {
  readonly ok: false;
  readonly erro: ErroDominio;
}): Resultado<T> {
  return resultado;
}
