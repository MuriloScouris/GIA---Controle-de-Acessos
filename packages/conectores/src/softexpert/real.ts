import { pathToFileURL } from 'node:url';
import type { VariaveisAmbiente } from '@gia/contratos';
import type { Conector, ResultadoConexao } from '@gia/dominio';
import { criarConectorSoftexpert } from '../adaptadores/softexpert.js';
import type { OpcoesConector } from '../motor.js';
import { ClienteSoftexpertSoap, type DependenciasSoftexpert } from './cliente.js';
import { carregarConfiguracaoSoftexpert, type ConfiguracaoSoftexpert } from './configuracao.js';

export type OpcoesSoftexpertReal = Pick<
  OpcoesConector,
  'agora' | 'timeoutChamadaMs' | 'timeoutConexaoMs'
> &
  DependenciasSoftexpert;

/**
 * Conector SoftExpert de produção (`modo: 'real'`). Montá-lo não libera escrita:
 * a liberação por sistema e por operação (regra 8) continua sendo do domínio.
 */
export function criarConectorSoftexpertReal(
  config: ConfiguracaoSoftexpert,
  opcoes: OpcoesSoftexpertReal = {},
): Conector {
  const { agora, timeoutChamadaMs, timeoutConexaoMs, ...dependencias } = opcoes;
  return criarConectorSoftexpert(new ClienteSoftexpertSoap(config, dependencias), {
    modo: 'real',
    ...(agora === undefined ? {} : { agora }),
    ...(timeoutChamadaMs === undefined ? {} : { timeoutChamadaMs }),
    // O testarConexao faz uma consulta SOAP completa: precisa do prazo de uma chamada.
    timeoutConexaoMs: timeoutConexaoMs ?? config.timeoutMs,
  });
}

/**
 * Homologação somente leitura: valida a configuração, autentica no API Gateway
 * e consulta um IDUSER que não existe. Não cria nem altera nada.
 */
export async function verificarConexaoSoftexpert(
  env: VariaveisAmbiente,
): Promise<ResultadoConexao> {
  return criarConectorSoftexpertReal(carregarConfiguracaoSoftexpert(env)).testarConexao();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verificarConexaoSoftexpert(process.env)
    .then((resultado) => {
      console.log(
        `SoftExpert: ${resultado.disponivel ? 'disponível' : 'indisponível'} (${resultado.codigo})`,
      );
      if (!resultado.disponivel) process.exitCode = 1;
    })
    .catch((erro: unknown) => {
      console.error(erro instanceof Error ? erro.message : 'falha ao verificar o SoftExpert');
      process.exitCode = 1;
    });
}
