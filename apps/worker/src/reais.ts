import type { VariaveisAmbiente } from '@gia/contratos';
import { criarIntegracoesDoAmbiente, type EventoIntegracao } from '@gia/conectores';
import type { PoliticaExecucao } from '@gia/dominio';
import type { ConectoresReais } from './gates.js';

/** Explicit factories only; constructing a client never enables writes. */
export async function conectoresReaisDoAmbiente(
  env: VariaveisAmbiente,
  politica: PoliticaExecucao,
  aoOperar?: (evento: EventoIntegracao) => void,
): Promise<ConectoresReais> {
  return (await criarIntegracoesDoAmbiente(env, politica, aoOperar)).reais;
}
