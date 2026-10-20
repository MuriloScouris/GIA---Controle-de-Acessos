export const sistemas = ['ad', 'm365', 'docusign', 'softexpert', 'jira', 'oidc', 'global'] as const;
export type SistemaProntidao = (typeof sistemas)[number];

export const comandos = {
  configuracao: 'pnpm --filter @gia/worker preflight --offline --saida <novo-offline.json>',
  leitura: 'pnpm --filter @gia/worker preflight --saida <novo-online.json>',
  matriz: 'pnpm --filter @gia/worker prontidao --revisao <SHA-40> --saida <nova-matriz.json>',
  oidc: 'pnpm --filter @gia/api exec vitest run src/oidc.test.ts',
  gates: 'pnpm check',
  e2e: 'pnpm test:e2e',
  administrativo:
    'Conferir evidência no repositório corporativo restrito; registrar somente referência opaca e checksum.',
  ensaio:
    'Solicitar janela e aprovação explícita; executar procedimento corporativo com identidade de ensaio. Este CLI não executa operações.',
  rollback:
    'No procedimento autorizado: desligar chave mestra/lista/flags locais; reiniciar API e worker; conferir fila, gates e auditoria; repetir preflight.',
} as const;

type Comando = keyof typeof comandos;
export interface Requisito {
  readonly id: string;
  readonly sistema: SistemaProntidao;
  readonly etapa: string;
  readonly responsavel: string;
  readonly decisaoNecessaria: string;
  readonly comandos: readonly Comando[];
  readonly implementacao: readonly number[];
  readonly checks?: readonly string[];
}

const donos = {
  ad: 'Administracao AD',
  m365: 'Administracao Entra/M365',
  docusign: 'Administracao DocuSign',
  softexpert: 'Administracao SoftExpert',
  jira: 'Administracao Jira',
} as const;
const prs = {
  ad: [12, 20, 22],
  m365: [18, 20, 22],
  docusign: [13, 19, 20, 22],
  softexpert: [14, 20, 22],
  jira: [15, 20, 22],
} as const;
const etapas: readonly {
  etapa: string;
  decisao: string;
  comandos: readonly Comando[];
  checks?: readonly string[];
}[] = [
  {
    etapa: 'credenciais',
    decisao: 'Montar arquivos do cofre, conferir rotacao, validade e ACL; nao registrar valores.',
    comandos: ['configuracao', 'leitura'],
    checks: ['configuracao', 'cofre', 'autenticacaoLeitura'],
  },
  {
    etapa: 'redeCa',
    decisao:
      'Aprovar DNS, rotas/firewall, endpoints e CA/nome por destino; validar no ambiente de producao.',
    comandos: ['leitura'],
    checks: ['dns', 'tcp', 'tls'],
  },
  {
    etapa: 'consentimentos',
    decisao:
      'Administrador confirma consentimentos ou nao aplicabilidade justificada, com evidencia restrita.',
    comandos: ['administrativo'],
  },
  {
    etapa: 'contaServico',
    decisao:
      'Confirmar titular corporativo, conta/aplicacao aprovada, uso exclusivo, ACL e rotacao.',
    comandos: ['administrativo'],
  },
  {
    etapa: 'permissoes',
    decisao:
      'Aprovar escopo minimo por operacao; GET/autenticacao nao comprovam permissao de escrita.',
    comandos: ['administrativo', 'ensaio'],
  },
  {
    etapa: 'campos',
    decisao: 'Aprovar catalogos, atributos, grupos e mapeamentos reais com amostras autorizadas.',
    comandos: ['administrativo', 'leitura'],
  },
  {
    etapa: 'ensaio',
    decisao:
      'Registrar autorizacao, janela, identidade restrita, auditoria, idempotencia, falha parcial e reconciliacao.',
    comandos: ['ensaio'],
  },
  {
    etapa: 'rollback',
    decisao:
      'Ensaiar desligamento de gates, fila bloqueada e reconciliacao de efeitos; nao apagar auditoria nem reenviar incertos.',
    comandos: ['rollback'],
  },
  {
    etapa: 'escrita',
    decisao:
      'Decidir sistema/operacao e janela somente apos ensaio real aprovado; manter todas as flags desligadas ate entao.',
    comandos: ['administrativo', 'leitura'],
  },
];

export const requisitos: readonly Requisito[] = [
  ...(['ad', 'm365', 'docusign', 'softexpert', 'jira'] as const).flatMap((sistema) =>
    etapas.map((e) => ({
      id: `${sistema}.${e.etapa}`,
      sistema,
      etapa: e.etapa,
      responsavel: donos[sistema],
      decisaoNecessaria: e.decisao,
      comandos: e.comandos,
      implementacao: prs[sistema],
      ...(e.checks ? { checks: e.checks } : {}),
    })),
  ),
  {
    id: 'ad.senhaInicial',
    sistema: 'ad',
    etapa: 'senhaInicial',
    responsavel: 'Administracao AD e Seguranca',
    decisaoNecessaria:
      'Decidir geracao, entrega por canal aprovado, reset inicial, expiracao e responsavel. Nunca colocar senha na matriz.',
    comandos: ['administrativo', 'ensaio'],
    implementacao: [12, 20],
  },
  {
    id: 'm365.sincronizacaoLicencas',
    sistema: 'm365',
    etapa: 'sincronizacaoLicencas',
    responsavel: donos.m365,
    decisaoNecessaria:
      'Homologar AD para Entra, assentos/SKUs, licenca herdada e ativacao assincrona; ausencia de identidade nao autoriza cria-la no Graph.',
    comandos: ['administrativo', 'ensaio'],
    implementacao: [18, 20],
  },
  {
    id: 'softexpert.wsdlRevogacao',
    sistema: 'softexpert',
    etapa: 'wsdlRevogacao',
    responsavel: donos.softexpert,
    decisaoNecessaria:
      'Conferir WSDL/versionamento e contrato disableUser no ambiente corporativo; flag REVOGACAO_CONFERIDA nao substitui evidencia/ensaio.',
    comandos: ['administrativo', 'ensaio'],
    implementacao: [14, 20],
  },
  {
    id: 'jira.vinculos',
    sistema: 'jira',
    etapa: 'vinculos',
    responsavel: 'Administracao Jira e RH',
    decisaoNecessaria:
      'Validar campos obrigatorios e amostra celetista/terceiro sem exportar dados pessoais; decidir request types/projeto e deduplicacao.',
    comandos: ['leitura', 'ensaio'],
    implementacao: [15, 22],
    checks: ['camposOrigem'],
  },
  ...[
    'credenciais',
    'redeCa',
    'consentimentos',
    'contaServico',
    'papeis',
    'ensaio',
    'rollback',
    'sessoes',
    'integracaoUi',
  ].map((etapa) => ({
    id: `oidc.${etapa}`,
    sistema: 'oidc' as const,
    etapa,
    responsavel: 'Administracao Entra e Backend/Seguranca',
    decisaoNecessaria: (
      {
        credenciais: 'Aprovar app registration/tenant, arquivo de segredo no cofre e rotacao.',
        redeCa:
          'Validar HTTPS, CA, authority/JWKS e redirect/logout registrados; nao exportar tokens nem cookies.',
        consentimentos: 'Aprovar escopos e consentimentos do aplicativo OIDC no tenant real.',
        contaServico: 'Confirmar titularidade do aplicativo confidencial e ACL do segredo.',
        papeis:
          'Homologar grupos reais mapeados por object ID em GIA_OIDC_MAPA_PAPEIS, usuario sem papel e grupo/app role nao mapeado negados, e limites por papel sem sessao simulada.',
        ensaio:
          'Ensaiar login, callback, erros, acesso negado, logout e auditoria em tenant real com autorizacao.',
        rollback:
          'Ensaiar retirada segura do login, encerramento de sessoes e recuperacao; nunca liberar sessao simulada em producao.',
        sessoes:
          'Sessoes atuais em memoria: decidir persistencia/compartilhamento, topologia, reinicio e expiracao; registrar risco e validacao autorizada.',
        integracaoUi:
          '#21/#23 integrados no DEV-291 (PR #25); validar /sessao/modo, login e logout no SHA final implantado; CI simulado nao comprova tenant real.',
      } as Record<string, string>
    )[etapa]!,
    comandos: ['oidc', 'administrativo', 'ensaio'] as const,
    implementacao: [21, 23],
  })),
  {
    id: 'global.runtime',
    sistema: 'global',
    etapa: 'runtime',
    responsavel: 'Operacoes e Backend',
    decisaoNecessaria:
      'Confirmar revisao implantada, persistencia pronta, API e gates efetivos do worker; heartbeat comprova somente vivacidade.',
    comandos: ['leitura', 'administrativo'],
    implementacao: [16, 20, 22],
    checks: [
      'ambiente',
      'gates',
      'cofreBanco',
      'vivacidadeApi',
      'prontidaoApi',
      'autorizacaoApi',
      'batimentoWorker',
    ],
  },
  {
    id: 'global.regras',
    sistema: 'global',
    etapa: 'regras',
    responsavel: 'RH e Responsavel de Acessos',
    decisaoNecessaria:
      'Aprovar regras reais de area/cargo, propostas e segregacao de papeis; regras ficticias bloqueiam producao.',
    comandos: ['administrativo', 'ensaio'],
    implementacao: [16, 17, 21],
  },
  {
    id: 'global.integracao',
    sistema: 'global',
    etapa: 'integracao',
    responsavel: 'Responsavel tecnico da sprint',
    decisaoNecessaria:
      'DEV-291 (PR #25) consolidou #12 a #24, preservando composicao #20 e login/UI #21/#23; repetir gates no SHA final implantado.',
    comandos: ['gates', 'e2e'],
    implementacao: [20, 21, 22, 23],
  },
  {
    id: 'global.goLive',
    sistema: 'global',
    etapa: 'goLive',
    responsavel: 'Responsavel de mudanca e Seguranca',
    decisaoNecessaria:
      'Nomear titulares, revisar evidencias, aprovar janela/rollback e ensaio real; NO_GO ate decisao administrativa rastreavel. Este comando nao aprova nem habilita escrita.',
    comandos: ['matriz', 'administrativo'],
    implementacao: [22],
  },
];
