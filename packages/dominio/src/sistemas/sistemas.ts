/** Sistemas de destino em que o Gia provisiona acessos. */
export type Sistema = 'ad' | 'm365' | 'docusign' | 'softexpert' | 'jira';

export const SISTEMAS: readonly Sistema[] = ['ad', 'm365', 'docusign', 'softexpert', 'jira'];

export const NOMES_SISTEMA: Readonly<Record<Sistema, string>> = {
  ad: 'Active Directory',
  m365: 'Microsoft 365',
  docusign: 'DocuSign',
  softexpert: 'SoftExpert',
  jira: 'Jira',
};

export type TipoVinculo = 'celetista' | 'terceiro';

export const TIPOS_VINCULO: readonly TipoVinculo[] = ['celetista', 'terceiro'];

// ---------------------------------------------------------------------------
// Parâmetros tipados por sistema (nunca um dicionário de strings livre).
// Nenhum tipo aceita senha: a credencial inicial é gerada pelo conector a
// partir do cofre e nunca passa pelo domínio (regra 12).
// ---------------------------------------------------------------------------

export interface ParametrosAd {
  readonly sistema: 'ad';
  readonly login: string;
  readonly upn: string;
  readonly email: string;
  readonly proxyAddresses: readonly string[];
  readonly nome: string;
  readonly sobrenome: string;
  readonly nomeExibicao: string;
  readonly ou: string;
  readonly grupos: readonly string[];
  readonly cargo: string;
  readonly departamento: string;
  readonly empresa: string;
  readonly escritorio: string | null;
  readonly scriptLogon: string | null;
  readonly gerente: string | null;
  readonly cpf: string;
  readonly controleConta: number | null;
}

/** Regra 7: não há campos de criação de usuário; o M365 só licencia a identidade sincronizada. */
export interface ParametrosM365 {
  readonly sistema: 'm365';
  readonly upn: string;
  readonly email: string;
  readonly nome: string;
  readonly planosLicenca: readonly string[];
  readonly paisUso: string;
  readonly grupo: string | null;
}

export interface ParametrosDocusign {
  readonly sistema: 'docusign';
  readonly email: string;
  readonly nome: string;
  readonly empresa: string;
  readonly cargo: string;
  readonly perfil: string;
  readonly grupo: string;
  readonly idioma: string;
  readonly endereco: string | null;
}

export interface ParametrosSoftexpert {
  readonly sistema: 'softexpert';
  /** Matrícula ou CPF. */
  readonly identificador: string;
  readonly login: string;
  readonly nome: string;
  readonly email: string;
  readonly area: string;
  readonly funcao: string;
  readonly grupoAcesso: string;
}

export interface ParametrosJira {
  readonly sistema: 'jira';
  readonly email: string;
  readonly nome: string;
  readonly grupos: readonly string[];
}

export type ParametrosSistema =
  ParametrosAd | ParametrosM365 | ParametrosDocusign | ParametrosSoftexpert | ParametrosJira;

export type ParametrosDe<S extends Sistema> = Extract<ParametrosSistema, { sistema: S }>;

// ---------------------------------------------------------------------------
// Etapas: todo resultado de conector informa a etapa alcançada, para que uma
// falha parcial seja retomada só no que falta (regra 4).
// ---------------------------------------------------------------------------

export const ETAPAS_PROVISIONAR = {
  ad: ['criarContaDesabilitada', 'definirSenha', 'habilitarConta', 'adicionarGrupos'],
  m365: ['aguardarIdentidadeSincronizada', 'definirPais', 'atribuirLicencas', 'adicionarGrupo'],
  docusign: ['criarUsuarioComPerfilEGrupo'],
  softexpert: ['criarUsuario'],
  jira: ['criarConta', 'adicionarGrupos'],
} as const satisfies Readonly<Record<Sistema, readonly string[]>>;

export const ETAPAS_REVOGAR = {
  ad: ['desabilitarConta', 'moverParaOuInativos'],
  m365: ['removerLicencas'],
  docusign: ['encerrarUsuario'],
  softexpert: ['inativarUsuario'],
  jira: ['removerGrupos'],
} as const satisfies Readonly<Record<Sistema, readonly string[]>>;

export type EtapaProvisionar = (typeof ETAPAS_PROVISIONAR)[Sistema][number];
export type EtapaRevogar = (typeof ETAPAS_REVOGAR)[Sistema][number];
export type Etapa = EtapaProvisionar | EtapaRevogar;

export function etapasDe(sistema: Sistema, acao: 'provisionar' | 'revogar'): readonly Etapa[] {
  return acao === 'provisionar' ? ETAPAS_PROVISIONAR[sistema] : ETAPAS_REVOGAR[sistema];
}

export function ehEtapaDoSistema(
  sistema: Sistema,
  acao: 'provisionar' | 'revogar',
  etapa: string,
): etapa is Etapa {
  return (etapasDe(sistema, acao) as readonly string[]).includes(etapa);
}

/**
 * Próxima etapa a executar depois da última concluída, ou `null` se todas
 * terminaram. Uma reexecução após sucesso parcial começa daqui.
 */
export function proximaEtapa(
  sistema: Sistema,
  acao: 'provisionar' | 'revogar',
  ultimaConcluida: Etapa | null,
): Etapa | null {
  const etapas = etapasDe(sistema, acao);
  if (ultimaConcluida === null) return etapas[0] ?? null;
  const indice = etapas.indexOf(ultimaConcluida);
  return indice < 0 ? (etapas[0] ?? null) : (etapas[indice + 1] ?? null);
}

/**
 * Regra 7: o M365 depende da identidade criada no AD e sincronizada para o
 * Entra ID fora do Gia. Nenhum sistema além destes tem dependência.
 */
export const DEPENDENCIA_DE_SISTEMA: Readonly<Partial<Record<Sistema, Sistema>>> = { m365: 'ad' };

/**
 * Sistemas do conjunto cuja dependência não está no mesmo conjunto (ex.: M365
 * sem AD). Vale para configuração por vínculo, revisão e execução: o M365 só
 * existe ancorado num item AD rastreável do mesmo pedido.
 */
export function sistemasSemDependencia(
  sistemas: readonly Sistema[],
): readonly { readonly sistema: Sistema; readonly exige: Sistema }[] {
  return sistemas.flatMap((sistema) => {
    const exige = DEPENDENCIA_DE_SISTEMA[sistema];
    return exige !== undefined && !sistemas.includes(exige) ? [{ sistema, exige }] : [];
  });
}

/** Etapas que criam conta de usuário; o M365 não tem nenhuma (regra 7). */
export const ETAPAS_DE_CRIACAO_DE_USUARIO: readonly string[] = [
  'criarContaDesabilitada',
  'criarUsuarioComPerfilEGrupo',
  'criarUsuario',
  'criarConta',
];

/**
 * Lista do que precisa existir no destino para o item ser considerado
 * completo. Usada pela conferência: encontrar a conta não basta (regra 6).
 */
export function acessosEsperados(parametros: ParametrosSistema): readonly string[] {
  const lista = ((): string[] => {
    switch (parametros.sistema) {
      case 'ad':
        return ['conta', ...parametros.grupos.map((grupo) => `grupo:${grupo}`)];
      case 'm365':
        return [
          'conta',
          ...parametros.planosLicenca.map((plano) => `licenca:${plano}`),
          ...(parametros.grupo === null ? [] : [`grupo:${parametros.grupo}`]),
        ];
      case 'docusign':
        return ['conta', `perfil:${parametros.perfil}`, `grupo:${parametros.grupo}`];
      case 'softexpert':
        return [
          'conta',
          `area:${parametros.area}`,
          `funcao:${parametros.funcao}`,
          `grupoAcesso:${parametros.grupoAcesso}`,
        ];
      case 'jira':
        return ['conta', ...parametros.grupos.map((grupo) => `grupo:${grupo}`)];
    }
  })();
  return [...new Set(lista.map(normalizarAcesso))];
}

export function normalizarAcesso(acesso: string): string {
  return acesso.trim().toLowerCase();
}
