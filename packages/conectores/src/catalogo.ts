import type { Conector, Instante, Sistema } from '@gia/dominio';
import { criarConectorAd } from './adaptadores/ad.js';
import { criarConectorDocusign } from './adaptadores/docusign.js';
import { criarConectorJiraDestino } from './adaptadores/jira-destino.js';
import { criarJiraOrigem, type JiraOrigem } from './adaptadores/jira-origem.js';
import { criarConectorM365 } from './adaptadores/m365.js';
import { criarConectorSoftexpert } from './adaptadores/softexpert.js';
import { AdSimulado, type EstadoInicialAd } from './simuladores/ad.js';
import { DocusignSimulado, type EstadoInicialDocusign } from './simuladores/docusign.js';
import {
  JiraDestinoSimulado,
  JiraOrigemSimulado,
  type EstadoInicialJira,
} from './simuladores/jira.js';
import { GraphSimulado, type EstadoInicialM365 } from './simuladores/m365.js';
import type { CenarioPronto } from './simuladores/roteiro.js';
import { SoftexpertSimulado, type EstadoInicialSoftexpert } from './simuladores/softexpert.js';

export interface OpcoesCatalogoSimulado {
  readonly ad?: EstadoInicialAd;
  readonly m365?: EstadoInicialM365;
  readonly docusign?: EstadoInicialDocusign;
  readonly softexpert?: EstadoInicialSoftexpert;
  readonly jira?: EstadoInicialJira;
  /** Chamados crus que o Jira de origem simulado devolve. */
  readonly chamadosJira?: readonly unknown[];
  readonly ouInativos?: string;
  readonly tiposSolicitacaoJira?: readonly string[];
  readonly agora?: () => Instante;
  readonly timeoutChamadaMs?: number;
}

export interface CatalogoSimulado {
  /** Conectores prontos para o executor; todos devolvem `modo: 'simulado'` (regra 9). */
  readonly conectores: Readonly<Record<Sistema, Conector>>;
  readonly jiraOrigem: JiraOrigem;
  readonly simuladores: {
    readonly ad: AdSimulado;
    readonly m365: GraphSimulado;
    readonly docusign: DocusignSimulado;
    readonly softexpert: SoftexpertSimulado;
    readonly jira: JiraDestinoSimulado;
    readonly jiraOrigem: JiraOrigemSimulado;
  };
  /** Aplica o mesmo cenário pronto a todos os simuladores de destino. */
  aplicarCenario(cenario: CenarioPronto): void;
}

/**
 * Monta todos os conectores sobre simuladores em memória, para desenvolvimento
 * e testes. Não abre rede, não lê segredos e nunca devolve resultado `real`.
 */
export function criarCatalogoSimulado(opcoes: OpcoesCatalogoSimulado = {}): CatalogoSimulado {
  const simuladores = {
    ad: new AdSimulado(opcoes.ad),
    m365: new GraphSimulado(opcoes.m365),
    docusign: new DocusignSimulado(opcoes.docusign),
    softexpert: new SoftexpertSimulado(opcoes.softexpert),
    jira: new JiraDestinoSimulado(opcoes.jira),
    jiraOrigem: new JiraOrigemSimulado(opcoes.chamadosJira),
  };
  const comum = {
    modo: 'simulado',
    ...(opcoes.agora === undefined ? {} : { agora: opcoes.agora }),
    ...(opcoes.timeoutChamadaMs === undefined ? {} : { timeoutChamadaMs: opcoes.timeoutChamadaMs }),
  } as const;
  return {
    conectores: {
      ad: criarConectorAd(simuladores.ad, {
        ...comum,
        ouInativos: opcoes.ouInativos ?? 'OU=Inativos',
      }),
      m365: criarConectorM365(simuladores.m365, comum),
      docusign: criarConectorDocusign(simuladores.docusign, comum),
      softexpert: criarConectorSoftexpert(simuladores.softexpert, comum),
      jira: criarConectorJiraDestino(simuladores.jira, comum),
    },
    jiraOrigem: criarJiraOrigem(simuladores.jiraOrigem, {
      modo: 'simulado',
      tiposSolicitacao: opcoes.tiposSolicitacaoJira ?? [
        'Admissão - Celetista',
        'Admissão - Terceiro',
      ],
    }),
    simuladores,
    aplicarCenario(cenario) {
      for (const chave of ['ad', 'm365', 'docusign', 'softexpert', 'jira'] as const) {
        simuladores[chave].roteiro.aplicar(cenario);
      }
    },
  };
}
