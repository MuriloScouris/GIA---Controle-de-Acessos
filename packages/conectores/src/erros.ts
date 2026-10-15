/**
 * Falha técnica ao falar com o fornecedor. Os clientes (reais ou simulados)
 * lançam este erro; o motor traduz para o resultado do contrato (regra 3).
 *
 * - `timeout` e `respostaPerdida`: a requisição saiu e a resposta não voltou; o destino pode ter agido.
 * - `conexaoRecusada` e `limiteDeTaxa`: comprovadamente nada chegou ao destino.
 * - `recusado`: o fornecedor respondeu que não fez (inclui 2xx com erro interno, DocuSign e SoftExpert).
 * - `identidadeNaoSincronizada`: só o M365; a identidade do AD ainda não chegou ao Entra ID (regra 7).
 */
export type TipoErroFornecedor =
  | 'timeout'
  | 'respostaPerdida'
  | 'conexaoRecusada'
  | 'limiteDeTaxa'
  | 'recusado'
  | 'identidadeNaoSincronizada';

export class ErroFornecedor extends Error {
  constructor(
    readonly tipo: TipoErroFornecedor,
    /** Código estável do adaptador; nunca carrega dado pessoal ou segredo. */
    readonly codigo: string = codigoPadrao(tipo),
    mensagem: string = 'Falha ao acessar o fornecedor.',
    /** `Retry-After` do fornecedor, em milissegundos. */
    readonly tentarAposMs: number | null = null,
    /** A etapa tem suboperações já confirmadas (por exemplo, um dos grupos). */
    readonly progressoConfirmado: boolean = false,
  ) {
    super(mensagem);
    this.name = 'ErroFornecedor';
  }
}

function codigoPadrao(tipo: TipoErroFornecedor): string {
  switch (tipo) {
    case 'timeout':
      return 'TIMEOUT';
    case 'respostaPerdida':
      return 'RESPOSTA_PERDIDA';
    case 'conexaoRecusada':
      return 'CONEXAO_RECUSADA';
    case 'limiteDeTaxa':
      return 'LIMITE_DE_TAXA';
    case 'recusado':
      return 'RECUSADO_PELO_FORNECEDOR';
    case 'identidadeNaoSincronizada':
      return 'IDENTIDADE_NAO_SINCRONIZADA';
  }
}
