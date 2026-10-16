import { pathToFileURL } from 'node:url';
import type { VariaveisAmbiente } from '@gia/contratos';
import type { Conector, ResultadoConexao } from '@gia/dominio';
import { criarConectorM365 } from '../adaptadores/m365.js';
import type { OpcoesConector } from '../motor.js';
import { ClienteGraphHttp, type DependenciasGraph } from './cliente.js';
import { carregarConfiguracaoM365, type ConfiguracaoM365 } from './configuracao.js';

export type OpcoesM365Real = Pick<
  OpcoesConector,
  'agora' | 'timeoutChamadaMs' | 'timeoutConexaoMs'
> &
  DependenciasGraph;

/**
 * Conector Microsoft 365 de produção (`modo: 'real'`). Montá-lo não libera
 * escrita (regra 8), e a dependência do AD (regra 7) continua no domínio e no
 * worker: o M365 só roda depois do item AD confirmado.
 */
export function criarConectorM365Real(
  config: ConfiguracaoM365,
  opcoes: OpcoesM365Real = {},
): Conector {
  const { agora, timeoutChamadaMs, timeoutConexaoMs, ...dependencias } = opcoes;
  return criarConectorM365(new ClienteGraphHttp(config, dependencias), {
    modo: 'real',
    ...(agora === undefined ? {} : { agora }),
    ...(timeoutChamadaMs === undefined ? {} : { timeoutChamadaMs }),
    // O testarConexao obtém token e lê a organização: precisa do prazo de uma chamada.
    timeoutConexaoMs: timeoutConexaoMs ?? config.timeoutMs,
  });
}

/**
 * Homologação somente leitura: valida a configuração, obtém o token do app e
 * lê a organização. Não lê pessoas nem altera nada.
 */
export async function verificarConexaoM365(env: VariaveisAmbiente): Promise<ResultadoConexao> {
  return criarConectorM365Real(carregarConfiguracaoM365(env)).testarConexao();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verificarConexaoM365(process.env)
    .then((resultado) => {
      console.log(
        `M365: ${resultado.disponivel ? 'disponível' : 'indisponível'} (${resultado.codigo})`,
      );
      if (!resultado.disponivel) process.exitCode = 1;
    })
    .catch((erro: unknown) => {
      console.error(erro instanceof Error ? erro.message : 'falha ao verificar o M365');
      process.exitCode = 1;
    });
}
