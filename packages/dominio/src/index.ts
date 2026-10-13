/**
 * @gia/dominio — entidades, estados, transições e regras de negócio do Gia.
 * Puro: sem banco, rede, conectores, relógio ou framework.
 */
export * from './comum/cpf.js';
export * from './comum/imutavel.js';
export * from './comum/maquina-estados.js';
export * from './comum/resultado.js';
export * from './comum/sanitizacao.js';
export * from './comum/tipos.js';
export * from './comum/versao.js';

export * from './autorizacao/ator.js';
export * from './autorizacao/permissoes.js';

export * from './sistemas/configuracao.js';
export * from './sistemas/sistemas.js';

export * from './conectores/conector.js';

export * from './colaborador/colaborador.js';
export * from './colaborador/identidade.js';

export * from './admissao/item-acesso.js';
export * from './admissao/pedido-admissao.js';
export * from './admissao/revisao.js';

export * from './execucao/execucao.js';
export * from './execucao/operacao.js';
export * from './execucao/politica.js';

export * from './eventos/evento.js';
