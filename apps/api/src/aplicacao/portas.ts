import type { IdentidadeProposta, Instante, UsoIdentidade } from '@gia/dominio';

/**
 * Portas que os casos de uso enxergam. Os repositórios são os de
 * `@gia/persistencia`: em memória (`persistencia/memoria.ts`) ou PostgreSQL
 * (`criarPersistenciaPostgres`), com as unicidades como restrições do banco.
 */
export type { Persistencia, Repositorios } from '@gia/persistencia';

/** Usos de login, e-mail e UPN já existentes no AD e no M365 (leitura, sem escrita). */
export interface ConsultaDiretorio {
  buscarUsos(identidade: IdentidadeProposta): Promise<readonly UsoIdentidade[]>;
}

/** Origem dos chamados de onboarding no Jira (leitura). */
export interface FonteChamadosJira {
  buscarChamadosOnboarding(): Promise<readonly unknown[]>;
}

export interface Relogio {
  agora(): Instante;
}
