import type {
  ContextoItem,
  ContextoRevogacao,
  Etapa,
  ModoExecucao,
  ParametrosAd,
  ParametrosDocusign,
  ParametrosJira,
  ParametrosM365,
  ParametrosSistema,
  ParametrosSoftexpert,
} from '@gia/dominio';

/** CPF válido e fictício a partir de 9 dígitos (nenhum CPF real nas fixtures). */
export function cpfFicticio(noveDigitos: string): string {
  const numeros = [...noveDigitos].map(Number);
  const digito = (base: readonly number[]): number => {
    const soma = base.reduce((acc, n, i) => acc + n * (base.length + 1 - i), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const primeiro = digito(numeros);
  return `${noveDigitos}${primeiro}${digito([...numeros, primeiro])}`;
}

export const CPF_MARIA = cpfFicticio('100000001');
export const OU_PADRAO = 'OU=Tecnologia,DC=exemplo,DC=com,DC=br';
export const OU_INATIVOS = 'OU=Inativos,DC=exemplo,DC=com,DC=br';

export function paramsAd(extra: Partial<Omit<ParametrosAd, 'sistema'>> = {}): ParametrosAd {
  return {
    sistema: 'ad',
    login: 'maria.souza',
    upn: 'maria.souza@exemplo.com.br',
    email: 'maria.souza@exemplo.com.br',
    proxyAddresses: ['SMTP:maria.souza@exemplo.com.br'],
    nome: 'Maria',
    sobrenome: 'Souza',
    nomeExibicao: 'Maria Ficticia Souza',
    ou: OU_PADRAO,
    grupos: ['GG-Tecnologia', 'GG-VPN'],
    cargo: 'Analista',
    departamento: 'Tecnologia',
    empresa: 'Exemplo',
    escritorio: null,
    scriptLogon: null,
    gerente: null,
    cpf: CPF_MARIA,
    controleConta: null,
    ...extra,
  };
}

export function paramsM365(extra: Partial<Omit<ParametrosM365, 'sistema'>> = {}): ParametrosM365 {
  return {
    sistema: 'm365',
    upn: 'maria.souza@exemplo.com.br',
    email: 'maria.souza@exemplo.com.br',
    nome: 'Maria Ficticia Souza',
    planosLicenca: ['E3', 'EMS'],
    paisUso: 'BR',
    grupo: 'M365-Tecnologia',
    ...extra,
  };
}

export function paramsDocusign(
  extra: Partial<Omit<ParametrosDocusign, 'sistema'>> = {},
): ParametrosDocusign {
  return {
    sistema: 'docusign',
    email: 'maria.souza@exemplo.com.br',
    nome: 'Maria Ficticia Souza',
    empresa: 'Exemplo',
    cargo: 'Analista',
    perfil: 'Remetente',
    grupo: 'Tecnologia',
    idioma: 'pt_BR',
    endereco: null,
    ...extra,
  };
}

export function paramsSoftexpert(
  extra: Partial<Omit<ParametrosSoftexpert, 'sistema'>> = {},
): ParametrosSoftexpert {
  return {
    sistema: 'softexpert',
    identificador: 'M1001',
    login: 'maria.souza',
    nome: 'Maria Ficticia Souza',
    email: 'maria.souza@exemplo.com.br',
    area: 'Tecnologia',
    funcao: 'Analista',
    grupoAcesso: 'Colaboradores',
    ...extra,
  };
}

export function paramsJira(extra: Partial<Omit<ParametrosJira, 'sistema'>> = {}): ParametrosJira {
  return {
    sistema: 'jira',
    email: 'maria.souza@exemplo.com.br',
    nome: 'Maria Ficticia Souza',
    grupos: ['jira-software-users', 'jira-ti'],
    ...extra,
  };
}

export function contexto(
  parametros: ParametrosSistema,
  extra: { etapaInicial?: Etapa | null; modo?: ModoExecucao } = {},
): ContextoItem {
  return {
    operacaoId: '00000000-0000-4000-8000-000000000001',
    itemId: '00000000-0000-4000-8000-000000000002',
    chaveIdempotencia: 'gia:teste:1',
    modo: extra.modo ?? 'simulado',
    parametros,
    etapaInicial: extra.etapaInicial ?? null,
  };
}

export function contextoRevogacao(
  parametros: ParametrosSistema,
  extra: { etapaInicial?: Etapa | null } = {},
): ContextoRevogacao {
  return { ...contexto(parametros, extra), motivo: 'Desligamento de teste' };
}

/** Recursos que existem nos simuladores para os parâmetros das fábricas acima. */
export const CADASTROS = {
  ad: { ous: [OU_PADRAO, OU_INATIVOS], grupos: ['GG-Tecnologia', 'GG-VPN'] },
  m365: { planos: ['E3', 'EMS'], grupos: ['M365-Tecnologia'] },
  docusign: { perfis: ['Remetente'], grupos: ['Tecnologia'] },
  softexpert: { areas: ['Tecnologia'], funcoes: ['Analista'], grupos: ['Colaboradores'] },
  jira: { grupos: ['jira-software-users', 'jira-ti'] },
} as const;
