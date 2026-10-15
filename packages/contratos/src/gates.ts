import {
  LIBERACAO_ESCRITA_PADRAO,
  SISTEMAS,
  type LiberacaoEscrita,
  type Sistema,
  type TipoEscrita,
} from '@gia/dominio';
import {
  ErroConfiguracao,
  carregarConfiguracaoAmbiente,
  type ConfiguracaoAmbiente,
  type VariaveisAmbiente,
} from './configuracao.js';

/**
 * Gates explícitos de escrita externa (regra 8), lidos do ambiente que o
 * administrador técnico controla:
 *
 * - `GIA_ESCRITA_EXTERNA=true` é a chave mestra (nunca em desenvolvimento);
 * - `GIA_ESCRITA_LIBERADA=ad:criar,ad:revogar,...` libera cada sistema e cada
 *   operação separadamente. Não há curinga.
 *
 * Sem a chave mestra, nada é liberado — e uma lista preenchida com a chave
 * desligada é erro, para ninguém achar que ligou o que está desligado.
 * Desligar a chave mestra e reiniciar é o rollback imediato da escrita real.
 */
export const VARIAVEL_ESCRITA_LIBERADA = 'GIA_ESCRITA_LIBERADA';

export type LiberacaoTexto = `${Sistema}:${TipoEscrita}`;

export interface GatesDeEscrita {
  readonly ambiente: ConfiguracaoAmbiente['ambiente'];
  readonly escritaExterna: boolean;
  readonly liberadas: readonly LiberacaoTexto[];
}

const TIPOS: readonly TipoEscrita[] = ['criar', 'revogar'];

export function carregarGatesDeEscrita(env: VariaveisAmbiente): GatesDeEscrita {
  const erros = new Set<string>();
  let ambiente: ConfiguracaoAmbiente | null = null;
  try {
    ambiente = carregarConfiguracaoAmbiente(env);
  } catch (erro) {
    if (!(erro instanceof ErroConfiguracao)) throw erro;
    for (const variavel of erro.variaveis) erros.add(variavel);
  }
  const bruto = env[VARIAVEL_ESCRITA_LIBERADA]?.trim() ?? '';
  const liberadas = new Set<LiberacaoTexto>();
  for (const parte of bruto === '' ? [] : bruto.split(',')) {
    const [sistema, tipo, ...resto] = parte.trim().split(':');
    if (
      resto.length > 0 ||
      !(SISTEMAS as readonly string[]).includes(sistema ?? '') ||
      !(TIPOS as readonly string[]).includes(tipo ?? '')
    ) {
      erros.add(VARIAVEL_ESCRITA_LIBERADA);
      continue;
    }
    liberadas.add(`${sistema as Sistema}:${tipo as TipoEscrita}`);
  }
  if (ambiente !== null && !ambiente.escritaExterna && liberadas.size > 0) {
    erros.add(VARIAVEL_ESCRITA_LIBERADA);
  }
  if (erros.size > 0 || ambiente === null) throw new ErroConfiguracao([...erros].sort());
  return Object.freeze({
    ambiente: ambiente.ambiente,
    escritaExterna: ambiente.escritaExterna,
    liberadas: [...liberadas].sort(),
  });
}

/** Escrita real permitida para este sistema e operação: chave mestra E liberação explícita. */
export function escritaPermitida(
  gates: GatesDeEscrita,
  sistema: Sistema,
  tipo: TipoEscrita,
): boolean {
  return gates.escritaExterna && gates.liberadas.includes(`${sistema}:${tipo}`);
}

/** A mesma decisão no formato que o domínio exige ao solicitar a execução (regra 8). */
export function liberacaoDosGates(gates: GatesDeEscrita): LiberacaoEscrita {
  if (!gates.escritaExterna) return LIBERACAO_ESCRITA_PADRAO;
  return Object.fromEntries(
    SISTEMAS.map((sistema) => [
      sistema,
      {
        criar: escritaPermitida(gates, sistema, 'criar'),
        revogar: escritaPermitida(gates, sistema, 'revogar'),
      },
    ]),
  ) as LiberacaoEscrita;
}

/** Modo das operações novas: só nascem `real` com a chave mestra ligada. */
export function modoDosGates(gates: GatesDeEscrita): 'real' | 'simulado' {
  return gates.escritaExterna ? 'real' : 'simulado';
}
