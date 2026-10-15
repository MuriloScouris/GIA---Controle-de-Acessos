import type { VariaveisAmbiente } from '@gia/contratos';
import type { PoliticaExecucao } from '@gia/dominio';
import type { ConectoresReais } from './gates.js';

/**
 * Conectores de produção disponíveis para o worker, montados a partir do
 * ambiente. Nesta versão nenhum transporte real está integrado ao worker: cada
 * PR de conector (AD, DocuSign, SoftExpert, Jira) registra o seu aqui, por
 * sistema, e o omite quando não configurado. Sistema sem entrada aqui faz toda
 * operação `real` sair `CONECTOR_REAL_INDISPONIVEL`, sem chamar nada
 * (ver `gates.ts`).
 */
export function conectoresReaisDoAmbiente(
  _env: VariaveisAmbiente,
  _politica: PoliticaExecucao,
): ConectoresReais {
  return {};
}
