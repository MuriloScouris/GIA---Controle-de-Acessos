import {
  derivarIdentidadeDoEmail,
  normalizarCpf,
  type DadosRh,
  type ItemProposto,
} from '@gia/dominio';

/**
 * Regras de área e cargo que sugerem os itens da proposta (módulo "Regras e
 * proposta"). Ficam versionadas: a revisão guarda `versao` e, depois de
 * aprovada, não muda quando as regras mudam. Os valores abaixo são fictícios;
 * a edição pela tela de Configurações (com simulação e auditoria) vem depois.
 */
export interface RegraSistemas {
  readonly departamento: string;
  readonly ou: string;
  readonly gruposAd: readonly string[];
  readonly docusign: { readonly perfil: string; readonly grupo: string };
  readonly softexpert: {
    readonly area: string;
    readonly funcao: string;
    readonly grupoAcesso: string;
  };
  readonly gruposJira: readonly string[];
  readonly m365: { readonly planosLicenca: readonly string[]; readonly grupo: string | null };
}

export interface RegraArea extends RegraSistemas {
  readonly area: string;
}

/** Complementa a regra da área; o que não vier aqui segue a área. */
export interface RegraCargo {
  readonly cargo: string;
  readonly gruposAd: readonly string[];
  readonly gruposJira: readonly string[];
  readonly funcaoSoftexpert: string | null;
  readonly perfilDocusign: string | null;
}

export interface RegrasProposta {
  readonly versao: string;
  readonly empresa: string;
  readonly paisUso: string;
  readonly idiomaDocusign: string;
  /** Aplicada quando a área do RH não tem mapeamento. */
  readonly padrao: RegraSistemas;
  readonly areas: readonly RegraArea[];
  readonly cargos: readonly RegraCargo[];
}

export const REGRAS_PROPOSTA_FICTICIAS: RegrasProposta = {
  versao: 'regras-ficticias-2026.10-1',
  empresa: 'Empresa Exemplo',
  paisUso: 'BR',
  idiomaDocusign: 'pt_BR',
  padrao: {
    departamento: 'Geral',
    ou: 'OU=Geral,OU=Usuarios,DC=exemplo,DC=local',
    gruposAd: ['GG_Todos'],
    docusign: { perfil: 'Remetente', grupo: 'Geral' },
    softexpert: { area: 'Geral', funcao: 'Colaborador', grupoAcesso: 'Leitores' },
    gruposJira: ['jira-usuarios'],
    m365: { planosLicenca: ['PLANO_BASICO'], grupo: null },
  },
  areas: [
    {
      area: 'Tecnologia',
      departamento: 'Tecnologia da Informação',
      ou: 'OU=Tecnologia,OU=Usuarios,DC=exemplo,DC=local',
      gruposAd: ['GG_Todos', 'GG_Tecnologia'],
      docusign: { perfil: 'Remetente', grupo: 'Tecnologia' },
      softexpert: { area: 'Tecnologia', funcao: 'Analista', grupoAcesso: 'Editores' },
      gruposJira: ['jira-usuarios', 'jira-tecnologia'],
      m365: { planosLicenca: ['PLANO_PADRAO'], grupo: 'Tecnologia' },
    },
    {
      area: 'Financeiro',
      departamento: 'Financeiro',
      ou: 'OU=Financeiro,OU=Usuarios,DC=exemplo,DC=local',
      gruposAd: ['GG_Todos', 'GG_Financeiro'],
      docusign: { perfil: 'Assinante', grupo: 'Financeiro' },
      softexpert: { area: 'Financeiro', funcao: 'Analista', grupoAcesso: 'Leitores' },
      gruposJira: ['jira-usuarios'],
      m365: { planosLicenca: ['PLANO_PADRAO'], grupo: 'Financeiro' },
    },
  ],
  cargos: [
    {
      cargo: 'Coordenador',
      gruposAd: ['GG_Gestores'],
      gruposJira: ['jira-gestores'],
      funcaoSoftexpert: 'Gestor',
      perfilDocusign: 'Administrador de Grupo',
    },
  ],
};

function chaveRegra(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
}

function unicos(valores: readonly string[]): string[] {
  return [...new Set(valores)];
}

/**
 * Sugere um item por sistema a partir das regras. A identidade sai do e-mail
 * corporativo do RH pela mesma regra do domínio; se não puder ser derivada,
 * os campos de identidade ficam vazios e a revisão nasce com a pendência,
 * para um humano ajustar. A filtragem por vínculo e a dependência M365 → AD
 * são aplicadas pelo domínio ao receber o chamado.
 *
 * `dadosRh` deve chegar já sanitizado: o item vira evento e resposta.
 */
export function proporItens(dadosRh: DadosRh, regras: RegrasProposta): readonly ItemProposto[] {
  const regraArea = regras.areas.find((r) => chaveRegra(r.area) === chaveRegra(dadosRh.area));
  const regraCargo = regras.cargos.find((r) => chaveRegra(r.cargo) === chaveRegra(dadosRh.cargo));
  const base: RegraSistemas = regraArea ?? regras.padrao;
  const origemSugestao = [
    regraArea ? `Regra da área "${regraArea.area}"` : 'Regra padrão (área sem mapeamento)',
    regraCargo ? `cargo "${regraCargo.cargo}"` : null,
  ]
    .filter((parte) => parte !== null)
    .join(' + ')
    .concat(` (${regras.versao})`);

  const identidade = derivarIdentidadeDoEmail({
    emailCorporativo: dadosRh.emailCorporativoSugerido,
    nomeCompleto: dadosRh.nomeCompleto,
  });
  const login = identidade.ok ? identidade.valor.login : '';
  const email = identidade.ok ? identidade.valor.email : '';
  const upn = identidade.ok ? identidade.valor.upn : '';
  const nomeCompleto = dadosRh.nomeCompleto.trim().replace(/\s+/g, ' ');
  const nomeExibicao = identidade.ok ? identidade.valor.nomeExibicao : nomeCompleto;
  const [primeiroNome = nomeCompleto, ...sobrenomes] = nomeCompleto.split(' ');
  const cpf = normalizarCpf(dadosRh.cpf);

  return [
    {
      sistema: 'ad',
      origemSugestao,
      parametros: {
        sistema: 'ad',
        login,
        upn,
        email,
        proxyAddresses: identidade.ok ? identidade.valor.proxyAddresses : [],
        nome: primeiroNome,
        sobrenome: sobrenomes.join(' ') || primeiroNome,
        nomeExibicao,
        ou: base.ou,
        grupos: unicos([...base.gruposAd, ...(regraCargo?.gruposAd ?? [])]),
        cargo: dadosRh.cargo,
        departamento: base.departamento,
        empresa: regras.empresa,
        escritorio: null,
        scriptLogon: null,
        gerente: dadosRh.gestor,
        cpf,
        controleConta: null,
      },
    },
    {
      sistema: 'm365',
      origemSugestao,
      parametros: {
        sistema: 'm365',
        upn,
        email,
        nome: nomeExibicao,
        planosLicenca: [...base.m365.planosLicenca],
        paisUso: regras.paisUso,
        grupo: base.m365.grupo,
      },
    },
    {
      sistema: 'docusign',
      origemSugestao,
      parametros: {
        sistema: 'docusign',
        email,
        nome: nomeExibicao,
        empresa: regras.empresa,
        cargo: dadosRh.cargo,
        perfil: regraCargo?.perfilDocusign ?? base.docusign.perfil,
        grupo: base.docusign.grupo,
        idioma: regras.idiomaDocusign,
        endereco: null,
      },
    },
    {
      sistema: 'softexpert',
      origemSugestao,
      parametros: {
        sistema: 'softexpert',
        identificador: dadosRh.matricula ?? cpf,
        login,
        nome: nomeExibicao,
        email,
        area: base.softexpert.area,
        funcao: regraCargo?.funcaoSoftexpert ?? base.softexpert.funcao,
        grupoAcesso: base.softexpert.grupoAcesso,
      },
    },
    {
      sistema: 'jira',
      origemSugestao,
      parametros: {
        sistema: 'jira',
        email,
        nome: nomeExibicao,
        grupos: unicos([...base.gruposJira, ...(regraCargo?.gruposJira ?? [])]),
      },
    },
  ];
}
