import {
  ErroConfiguracao,
  carregarGatesDeEscrita,
  exigirSegredosForaDoAmbiente,
  type VariaveisAmbiente,
} from '@gia/contratos';
import {
  POLITICA_EXECUCAO_PADRAO,
  SISTEMAS,
  type Conector,
  type ContextoItem,
  type PoliticaExecucao,
  type Sistema,
} from '@gia/dominio';
import { criarConectorAd, type ClienteAd } from './adaptadores/ad.js';
import { criarConectorDocusign } from './adaptadores/docusign.js';
import { criarConectorM365, type ClienteGraph } from './adaptadores/m365.js';
import { criarConsultaDiretorioReal } from './diretorio.js';
import { criarClienteDocusignReal } from './docusign/cliente.js';
import { carregarChaveDocusign, carregarConfiguracaoDocusign } from './docusign/configuracao.js';
import { criarJiraDoAmbiente } from './jira/ambiente.js';
import { ClienteGraphHttp } from './m365/cliente.js';
import { carregarConfiguracaoM365, lerSegredoM365 } from './m365/configuracao.js';
import { dentroDoPrazo, fetchComPrazo } from './prazo.js';
import { carregarConfiguracaoSoftexpert } from './softexpert/configuracao.js';
import { criarConectorSoftexpertReal } from './softexpert/real.js';
import { criarClienteAdLdap } from './transportes/ad-real.js';
import { carregarConfiguracaoAd, lerSegredoDeArquivo } from './transportes/configuracao-ad.js';

export interface EventoIntegracao {
  readonly sistema: Sistema;
  readonly acao: 'validar' | 'conferirExistencia' | 'provisionar' | 'revogar';
  readonly operacaoId: string;
  readonly itemId: string;
  readonly desfecho: 'concluida' | 'falhou';
  readonly codigo: string;
}

/** Seleção explícita, independente da liberação da escrita. Nunca inferida de uma credencial. */
export function carregarSelecaoIntegracoes(env: VariaveisAmbiente): readonly Sistema[] {
  exigirSegredosForaDoAmbiente(env);
  const gates = carregarGatesDeEscrita(env);
  const erros = new Set<string>();
  const reais = SISTEMAS.filter((s) => {
    const nome = `GIA_${s.toUpperCase()}_MODO`;
    const modo = env[nome] ?? 'simulado';
    if (!['simulado', 'real'].includes(modo)) erros.add(nome);
    return modo === 'real';
  });
  for (const liberacao of gates.liberadas) {
    const sistema = liberacao.split(':')[0] as Sistema;
    if (!reais.includes(sistema)) erros.add(`GIA_${sistema.toUpperCase()}_MODO`);
  }
  for (const s of ['jira', 'docusign'] as const) {
    const nome = `GIA_${s.toUpperCase()}_ESCRITA_HABILITADA`;
    const flag = env[nome] ?? 'false';
    const liberado = gates.liberadas.some((l) => l.startsWith(`${s}:`));
    if (
      !['true', 'false'].includes(flag) ||
      (flag === 'true' && (!reais.includes(s) || !liberado)) ||
      (liberado && flag !== 'true')
    )
      erros.add(nome);
  }
  if (
    gates.liberadas.includes('softexpert:revogar') &&
    env['GIA_SOFTEXPERT_REVOGACAO_CONFERIDA'] !== 'true'
  )
    erros.add('GIA_SOFTEXPERT_REVOGACAO_CONFERIDA');
  if (erros.size) throw new ErroConfiguracao([...erros].sort());
  return reais;
}

/** Montagem sem rede. Pré-valida arquivos e limites antes de qualquer consumo da fila. */
export async function criarIntegracoesDoAmbiente(
  env: VariaveisAmbiente,
  politica: PoliticaExecucao = POLITICA_EXECUCAO_PADRAO,
  aoOperar: (evento: EventoIntegracao) => void = () => undefined,
) {
  const selecionados = carregarSelecaoIntegracoes(env);
  if (selecionados.length && politica.timeoutChamadaMs < 200)
    throw new ErroConfiguracao(['GIA_EXECUCAO_TIMEOUT_CHAMADA_MS']);
  const reais: Partial<Record<Sistema, Conector>> = {};
  let ad: ClienteAd | undefined;
  let graph: ClienteGraph | undefined;
  // Prazos internos expiram antes do motor, impedindo chamadas tardias depois de timeout.
  const prazo = Math.max(100, Math.min(25000, politica.timeoutChamadaMs - 100));
  const limites = {
    timeoutChamadaMs: politica.timeoutChamadaMs,
    timeoutConexaoMs: politica.timeoutConexaoMs,
  };
  const limitar = (nome: string, padrao: number) =>
    String(Math.min(Number(env[nome] ?? padrao), prazo));
  if (selecionados.includes('ad')) {
    const config = carregarConfiguracaoAd(env);
    await lerSegredoDeArquivo(config.arquivoSenha, 'GIA_AD_SENHA_ARQUIVO');
    const cliente = await criarClienteAdLdap({
      ...config,
      timeoutConexaoMs: Math.min(config.timeoutConexaoMs, politica.timeoutConexaoMs),
      timeoutOperacaoMs: Math.min(config.timeoutOperacaoMs, prazo),
    });
    ad = cliente;
    reais.ad = criarConectorAd(cliente, {
      modo: 'real',
      ...limites,
      ouInativos: config.ouInativos,
    });
  }
  if (selecionados.includes('m365')) {
    const config = carregarConfiguracaoM365({
      ...env,
      GIA_M365_TIMEOUT_MS: limitar('GIA_M365_TIMEOUT_MS', 20000),
    });
    await lerSegredoM365(config.arquivoSegredo);
    graph = new ClienteGraphHttp(config, { fetch: fetchComPrazo });
    reais.m365 = criarConectorM365(graph, {
      modo: 'real',
      ...limites,
    });
  }
  if (selecionados.includes('docusign')) {
    const config = carregarConfiguracaoDocusign({
      ...env,
      GIA_DOCUSIGN_TIMEOUT_MS: limitar('GIA_DOCUSIGN_TIMEOUT_MS', 20000),
    });
    const chave = await carregarChaveDocusign(config.chavePrivadaArquivo);
    reais.docusign = criarConectorDocusign(
      criarClienteDocusignReal(config, chave, { fetch: fetchComPrazo }),
      { modo: 'real', ...limites },
    );
  }
  if (selecionados.includes('softexpert')) {
    const config = carregarConfiguracaoSoftexpert({
      ...env,
      GIA_SOFTEXPERT_TIMEOUT_MS: limitar('GIA_SOFTEXPERT_TIMEOUT_MS', 20000),
    });
    const auth = config.autenticacao;
    await lerSegredoDeArquivo(
      auth.modo === 'token' ? auth.arquivoToken : auth.arquivoSenha,
      auth.modo === 'token'
        ? 'GIA_SOFTEXPERT_TOKEN_ARQUIVO'
        : 'GIA_SOFTEXPERT_SENHA_SERVICO_ARQUIVO',
    );
    reais.softexpert = criarConectorSoftexpertReal(config, { ...limites, fetch: fetchComPrazo });
  }
  const jira = selecionados.includes('jira')
    ? criarJiraDoAmbiente(env, { fetch: fetchComPrazo }, limites)
    : null;
  if (jira) reais.jira = jira.destino;
  // IDs locais ligam os metadados técnicos ao evento transacional, sem parâmetros pessoais.
  for (const sistema of selecionados) {
    const conector = reais[sistema]!;
    const observar = async <T extends object>(
      acao: EventoIntegracao['acao'],
      ctx: ContextoItem,
      chamar: () => Promise<T>,
    ): Promise<T> => {
      try {
        const resultado = await dentroDoPrazo(politica.timeoutChamadaMs - 100, chamar);
        aoOperar({
          sistema,
          acao,
          operacaoId: ctx.operacaoId,
          itemId: ctx.itemId,
          desfecho: 'concluida',
          codigo:
            'codigo' in resultado && typeof resultado.codigo === 'string' ? resultado.codigo : 'OK',
        });
        return resultado;
      } catch (erro) {
        aoOperar({
          sistema,
          acao,
          operacaoId: ctx.operacaoId,
          itemId: ctx.itemId,
          desfecho: 'falhou',
          codigo: 'INTEGRACAO_FALHOU',
        });
        throw erro;
      }
    };
    reais[sistema] = {
      testarConexao: () =>
        dentroDoPrazo(Math.max(1, politica.timeoutConexaoMs - 1), () => conector.testarConexao()),
      validar: (ctx) => observar('validar', ctx, () => conector.validar(ctx)),
      conferirExistencia: (ctx) =>
        observar('conferirExistencia', ctx, () => conector.conferirExistencia(ctx)),
      provisionar: (ctx) => observar('provisionar', ctx, () => conector.provisionar(ctx)),
      revogar: (ctx) => observar('revogar', ctx, () => conector.revogar(ctx)),
    };
  }
  const consulta = ad && graph ? criarConsultaDiretorioReal(ad, graph) : undefined;
  const diretorio = consulta
    ? {
        buscarUsos: (identidade: Parameters<typeof consulta.buscarUsos>[0]) =>
          dentroDoPrazo(politica.timeoutChamadaMs - 100, () => consulta.buscarUsos(identidade)),
      }
    : undefined;
  const jiraOrigem = jira
    ? {
        buscarChamadosOnboarding: () =>
          dentroDoPrazo(politica.timeoutChamadaMs - 100, () =>
            jira.origem.buscarChamadosOnboarding(),
          ),
      }
    : undefined;
  return { reais: Object.freeze(reais), jiraOrigem, diretorio };
}
