import {
  ErroConfiguracao,
  RegistroMetricas,
  carregarConfiguracaoApi,
  carregarGatesDeEscrita,
  criarRegistrador,
  liberacaoDosGates,
  modoDosGates,
  nivelDeLog,
  portaDeMetricas,
  type ConfiguracaoApi,
  type GatesDeEscrita,
  type Registrador,
  type VariaveisAmbiente,
} from '@gia/contratos';
import { exigirSegredosForaDoAmbiente } from '@gia/contratos/segredos';
import { configuracaoPadrao, type ConfiguracaoSistemas } from '@gia/dominio';
import { VARIAVEL_URL_BANCO } from '@gia/persistencia';
import { VARIAVEL_TLS_NODE, exigirTlsVerificado } from '@gia/contratos';
import { proxiesConfiaveis } from './proxies-confiaveis.js';

export const VARIAVEL_METRICAS_PORTA = 'GIA_METRICAS_PORTA';
export const VARIAVEL_VERSAO = 'GIA_VERSAO';
/** Proxies reversos em que a API confia para ler o IP do cliente em `X-Forwarded-For` (M8). */
export const VARIAVEL_PROXY_CONFIAVEL = 'GIA_API_PROXY_CONFIAVEL';

export { proxiesConfiaveis };

/** O que a API precisa do ambiente, já validado. */
export interface AmbienteApi {
  readonly config: ConfiguracaoApi;
  readonly gates: GatesDeEscrita;
  readonly configuracaoSistemas: ConfiguracaoSistemas;
  readonly registrador: Registrador;
  readonly metricas: RegistroMetricas;
  readonly versao: string;
  readonly portaMetricas: number | null;
  /** Proxies confiáveis na frente da API (`GIA_API_PROXY_CONFIAVEL`); vazio = nenhum. */
  readonly proxiesConfiaveis: readonly string[];
  readonly urlBanco: string | null;
}

/**
 * Valida o ambiente da API de uma vez, citando só nomes de variáveis:
 *
 * - segredos por valor no ambiente são recusados em produção (regra 12);
 * - verificação TLS desligada (`NODE_TLS_REJECT_UNAUTHORIZED=0`) é recusada em
 *   produção; fora dela, a API sobe e registra o aviso;
 * - os gates de escrita valem para a API e para o worker (regra 8);
 * - produção e escrita real exigem PostgreSQL: memória do processo perderia a
 *   fila e os eventos de auditoria num reinício.
 */
export function prepararAmbienteApi(
  env: VariaveisAmbiente,
  saida?: (linha: string) => void,
): AmbienteApi {
  const erros = new Set<string>();
  const registrar = <T>(ler: () => T): T | null => {
    try {
      return ler();
    } catch (erro) {
      if (!(erro instanceof ErroConfiguracao)) throw erro;
      for (const variavel of erro.variaveis) erros.add(variavel);
      return null;
    }
  };
  const segredosPorValor = registrar(() => exigirSegredosForaDoAmbiente(env)) ?? [];
  const tlsDesligado = registrar(() => exigirTlsVerificado(env)) ?? false;
  const config = registrar(() => carregarConfiguracaoApi(env));
  const gates = registrar(() => carregarGatesDeEscrita(env));
  const porta = portaDeMetricas(env[VARIAVEL_METRICAS_PORTA]);
  if (porta === 'invalida') erros.add(VARIAVEL_METRICAS_PORTA);
  const proxies = proxiesConfiaveis(env[VARIAVEL_PROXY_CONFIAVEL]);
  if (proxies === 'invalido') erros.add(VARIAVEL_PROXY_CONFIAVEL);
  const url = env[VARIAVEL_URL_BANCO]?.trim() ?? '';
  if (config !== null && gates !== null && url === '') {
    if (config.ambiente === 'producao' || gates.escritaExterna) erros.add(VARIAVEL_URL_BANCO);
  }
  if (erros.size > 0 || config === null || gates === null) {
    throw new ErroConfiguracao([...erros].sort());
  }

  const registrador = criarRegistrador({
    servico: 'api',
    ambiente: config.ambiente,
    nivelMinimo: nivelDeLog(env['GIA_LOG_NIVEL']),
    ...(saida === undefined ? {} : { saida }),
  });
  if (segredosPorValor.length > 0) {
    registrador.aviso('segredo_no_ambiente', { variaveis: segredosPorValor });
  }
  if (tlsDesligado) {
    registrador.aviso('tls_verificacao_desligada', { variaveis: [VARIAVEL_TLS_NODE] });
  }
  const versao = env[VARIAVEL_VERSAO]?.trim() || 'desconhecida';
  // Auditoria operacional: o estado dos gates fica registrado em toda partida.
  registrador.info('api_configurada', {
    versao,
    modoExecucao: modoDosGates(gates),
    escritaExterna: gates.escritaExterna,
    escritaLiberada: [...gates.liberadas],
    persistencia: url === '' ? 'memoria' : 'postgres',
  });
  return {
    config,
    gates,
    configuracaoSistemas: { ...configuracaoPadrao(), liberacaoEscrita: liberacaoDosGates(gates) },
    registrador,
    metricas: new RegistroMetricas(),
    versao,
    portaMetricas: porta === 'invalida' ? null : porta,
    proxiesConfiaveis: proxies === 'invalido' ? [] : proxies,
    urlBanco: url === '' ? null : url,
  };
}
