/** Repositórios, migrações, fila de operações (outbox) e lease. PostgreSQL + Kysely (ADR-0003/0004). */
export const PACOTE = '@gia/persistencia';
export { criarUnidadeDeTrabalhoEmMemoria } from './unidade-de-trabalho.js';
export type { UnidadeDeTrabalho } from './unidade-de-trabalho.js';
export type { FilaOperacoes, Persistencia, Repositorios, RepositoriosComFila } from './portas.js';
export { ErroDeConcorrencia, ErroDeIntegridade } from './erros.js';
export { criarBanco, urlDoBanco, VARIAVEL_URL_BANCO } from './postgres/conexao.js';
export type { OpcoesConexao } from './postgres/conexao.js';
export type { BancoGia } from './postgres/esquema.js';
export {
  desfazerUltima,
  ErroDeMigracao,
  MIGRACOES,
  migrarParaUltima,
} from './postgres/migrador.js';
export { criarPersistenciaPostgres } from './postgres/persistencia-postgres.js';
export type { OpcoesPersistenciaPostgres } from './postgres/persistencia-postgres.js';
export { recuperarLeasesExpirados, renovarLeaseDaOperacao, reservarLote } from './fila/lease.js';
export type { Recusa, ResultadoRecuperacao, ResultadoReserva } from './fila/lease.js';
