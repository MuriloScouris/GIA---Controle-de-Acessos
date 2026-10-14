/** Violação de unicidade ou do "somente inserção": nunca deveria passar pelas guardas do domínio. */
export class ErroDeIntegridade extends Error {
  constructor(motivo: string) {
    super(`Integridade violada: ${motivo}`);
    this.name = 'ErroDeIntegridade';
  }
}

/**
 * Outra transação gravou o mesmo registro antes desta (controle otimista por
 * `versao`). Nada desta transação é confirmado; quem chamou relê e decide.
 */
export class ErroDeConcorrencia extends Error {
  constructor(
    readonly tabela: string,
    readonly registroId: string,
  ) {
    super(`Conflito de concorrência: ${tabela} ${registroId} mudou durante a transação`);
    this.name = 'ErroDeConcorrencia';
  }
}
