import type { ModoExecucao } from '@gia/dominio';
import type { ConsultaDiretorio, FonteChamadosJira, Persistencia } from './portas.js';
import type { RegrasProposta } from './regras-proposta.js';

/** O que os casos de uso recebem de fora. Nenhum deles fala com sistema de destino. */
export interface DependenciasCasosDeUso {
  readonly persistencia: Persistencia;
  readonly fonteJira: FonteChamadosJira;
  readonly diretorio: ConsultaDiretorio;
  readonly regras: RegrasProposta;
  /**
   * Modo das operações enfileiradas. Com a escrita externa desligada (padrão
   * e único valor aceito hoje pela configuração), é `simulado`: o worker usará
   * os simuladores e nada é escrito nos destinos (regras 8 e 9).
   */
  readonly modoExecucao: ModoExecucao;
}
