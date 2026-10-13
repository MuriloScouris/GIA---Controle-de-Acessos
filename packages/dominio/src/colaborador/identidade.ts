import { normalizarCpf } from '../comum/cpf.js';
import { falha, sucesso, type Resultado } from '../comum/resultado.js';
import { textoPreenchido, type Instante } from '../comum/tipos.js';

/**
 * Identidade do colaborador nos sistemas. A base é o e-mail corporativo
 * sugerido pelo RH: login, UPN e endereços saem dele. O Gia apenas verifica
 * colisão e uso; ele nunca gera outro login automaticamente. Se houver
 * colisão ou o e-mail não servir, um humano ajusta a identidade.
 */

/** Limite do `sAMAccountName` no Active Directory. */
export const LIMITE_LOGIN = 20;

export type OrigemIdentidade = 'emailCorporativoRh' | 'ajusteManual';

export interface IdentidadeProposta {
  readonly login: string;
  readonly upn: string;
  readonly email: string;
  readonly proxyAddresses: readonly string[];
  readonly nomeExibicao: string;
  readonly origem: OrigemIdentidade;
}

const PARTE_LOCAL = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const DOMINIO = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export function normalizarEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Valida o e-mail e separa parte local e domínio. */
function analisarEmail(
  email: string,
): Resultado<{ local: string; dominio: string; email: string }> {
  const normalizado = normalizarEmail(email);
  const partes = normalizado.split('@');
  if (partes.length !== 2) return falha('EMAIL_CORPORATIVO_INVALIDO');
  const [local = '', dominio = ''] = partes;
  if (!PARTE_LOCAL.test(local) || local.includes('..') || !DOMINIO.test(dominio)) {
    return falha('EMAIL_CORPORATIVO_INVALIDO');
  }
  return sucesso({ local, dominio, email: normalizado });
}

function normalizarNome(nome: string): string {
  return nome.trim().replace(/\s+/g, ' ');
}

function montarIdentidade(
  login: string,
  email: string,
  nomeExibicao: string,
  origem: OrigemIdentidade,
  upn?: string,
): Resultado<IdentidadeProposta> {
  if (login.length > LIMITE_LOGIN) {
    return falha('LOGIN_EXCEDE_LIMITE', { login, limite: LIMITE_LOGIN });
  }
  if (!textoPreenchido(nomeExibicao)) return falha('DADO_INVALIDO', { campo: 'nomeExibicao' });
  return sucesso({
    login,
    upn: upn ?? email,
    email,
    proxyAddresses: [`SMTP:${email}`],
    nomeExibicao: normalizarNome(nomeExibicao),
    origem,
  });
}

/**
 * Deriva a identidade do e-mail corporativo sugerido pelo RH. Não há
 * alternativa automática: e-mail inválido ou login acima do limite viram
 * pendência para ajuste humano.
 */
export function derivarIdentidadeDoEmail(entrada: {
  readonly emailCorporativo: string | null;
  readonly nomeCompleto: string;
}): Resultado<IdentidadeProposta> {
  if (!textoPreenchido(entrada.emailCorporativo)) return falha('EMAIL_CORPORATIVO_INVALIDO');
  const email = analisarEmail(entrada.emailCorporativo);
  if (!email.ok) return email;
  return montarIdentidade(
    email.valor.local,
    email.valor.email,
    entrada.nomeCompleto,
    'emailCorporativoRh',
  );
}

export interface AjusteManualIdentidade {
  readonly login: string;
  readonly email: string;
  readonly nomeExibicao: string;
  readonly upn?: string;
}

/** Identidade definida pelo operador na revisão (ex.: após colisão). */
export function ajustarIdentidade(ajuste: AjusteManualIdentidade): Resultado<IdentidadeProposta> {
  const email = analisarEmail(ajuste.email);
  if (!email.ok) return email;
  const login = ajuste.login.trim().toLowerCase();
  if (!PARTE_LOCAL.test(login) || login.includes('..')) {
    return falha('DADO_INVALIDO', { campo: 'login' });
  }
  let upn: string | undefined;
  if (ajuste.upn !== undefined) {
    const upnAnalisado = analisarEmail(ajuste.upn);
    if (!upnAnalisado.ok) return falha('DADO_INVALIDO', { campo: 'upn' });
    upn = upnAnalisado.valor.email;
  }
  return montarIdentidade(login, email.valor.email, ajuste.nomeExibicao, 'ajusteManual', upn);
}

// ---------------------------------------------------------------------------
// Verificação de colisão e uso.
// ---------------------------------------------------------------------------

export type CampoIdentidade = 'login' | 'email' | 'upn' | 'proxyAddress';

/** Um valor de identidade já existente em alguma fonte (AD, M365, Gia). */
export interface UsoIdentidade {
  readonly fonte: 'ad' | 'm365' | 'gia';
  readonly campo: CampoIdentidade;
  readonly valor: string;
  /** CPF do titular, se conhecido. Sem CPF, o uso é tratado como de outra pessoa. */
  readonly cpfTitular: string | null;
}

export type SituacaoIdentidade = 'livre' | 'emUsoPelaMesmaPessoa' | 'emUsoPorOutraPessoa';

export interface ConflitoIdentidade {
  readonly fonte: UsoIdentidade['fonte'];
  readonly campo: CampoIdentidade;
  readonly valor: string;
}

export interface VerificacaoIdentidade {
  readonly situacao: SituacaoIdentidade;
  readonly conflitos: readonly ConflitoIdentidade[];
  readonly usosDaMesmaPessoa: readonly ConflitoIdentidade[];
  /** Valores conferidos; se a identidade mudar, a verificação deixa de valer. */
  readonly valoresVerificados: {
    readonly login: string;
    readonly email: string;
    readonly upn: string;
  };
  readonly verificadaEm: Instante;
}

function chaveComparacao(campo: CampoIdentidade, valor: string): string {
  const normalizado = valor.trim().toLowerCase();
  return campo === 'proxyAddress' ? normalizado.replace(/^smtp:/, '') : normalizado;
}

/**
 * Cruza a identidade proposta com os usos encontrados nas fontes. Apenas
 * classifica: não propõe outro login. Login é comparado com login; e-mail,
 * UPN e proxyAddresses são comparados entre si, porque disputam o mesmo endereço.
 */
export function verificarUsoDaIdentidade(
  identidade: IdentidadeProposta,
  usos: readonly UsoIdentidade[],
  cpfDoColaborador: string,
  verificadaEm: Instante,
): VerificacaoIdentidade {
  const login = chaveComparacao('login', identidade.login);
  const enderecos = new Set(
    [identidade.email, identidade.upn, ...identidade.proxyAddresses].map((valor) =>
      chaveComparacao('proxyAddress', valor),
    ),
  );
  const cpf = normalizarCpf(cpfDoColaborador);
  const conflitos: ConflitoIdentidade[] = [];
  const usosDaMesmaPessoa: ConflitoIdentidade[] = [];

  for (const uso of usos) {
    const valor = chaveComparacao(uso.campo, uso.valor);
    const colide = uso.campo === 'login' ? valor === login : enderecos.has(valor);
    if (!colide) continue;
    const registro: ConflitoIdentidade = { fonte: uso.fonte, campo: uso.campo, valor: uso.valor };
    const mesmaPessoa = uso.cpfTitular !== null && normalizarCpf(uso.cpfTitular) === cpf;
    (mesmaPessoa ? usosDaMesmaPessoa : conflitos).push(registro);
  }

  const situacao: SituacaoIdentidade =
    conflitos.length > 0
      ? 'emUsoPorOutraPessoa'
      : usosDaMesmaPessoa.length > 0
        ? 'emUsoPelaMesmaPessoa'
        : 'livre';
  return {
    situacao,
    conflitos,
    usosDaMesmaPessoa,
    valoresVerificados: { login: identidade.login, email: identidade.email, upn: identidade.upn },
    verificadaEm,
  };
}

/** A verificação vale para esta identidade e não aponta uso por outra pessoa? */
export function exigirIdentidadeLiberada(
  identidade: IdentidadeProposta | null,
  verificacao: VerificacaoIdentidade | null,
): Resultado<IdentidadeProposta> {
  if (identidade === null) return falha('IDENTIDADE_AUSENTE');
  if (
    verificacao?.valoresVerificados.login !== identidade.login ||
    verificacao.valoresVerificados.email !== identidade.email ||
    verificacao.valoresVerificados.upn !== identidade.upn
  ) {
    return falha('IDENTIDADE_NAO_VERIFICADA');
  }
  if (verificacao.situacao === 'emUsoPorOutraPessoa') {
    return falha('IDENTIDADE_EM_USO', { conflitos: verificacao.conflitos });
  }
  return sucesso(identidade);
}
