import { readFile } from 'node:fs/promises';
import { ErroConfiguracao, type VariaveisAmbiente } from '@gia/contratos';

/**
 * Configuração do transporte SOAP do SoftExpert SE Suite (API Gateway),
 * validada no arranque. Nenhum segredo passa por variável de ambiente: o token
 * do gateway e a senha da conta de serviço vêm de ARQUIVOS montados pelo cofre
 * (regra 12) e são relidos a cada chamada para acompanhar a rotação. Erros
 * citam só o nome das variáveis, nunca os valores.
 */
export const VARIAVEIS_SOFTEXPERT = {
  url: 'GIA_SOFTEXPERT_URL',
  autenticacao: 'GIA_SOFTEXPERT_AUTENTICACAO',
  arquivoToken: 'GIA_SOFTEXPERT_TOKEN_ARQUIVO',
  usuarioServico: 'GIA_SOFTEXPERT_USUARIO_SERVICO',
  arquivoSenhaServico: 'GIA_SOFTEXPERT_SENHA_SERVICO_ARQUIVO',
  idioma: 'GIA_SOFTEXPERT_IDIOMA',
  timeoutMs: 'GIA_SOFTEXPERT_TIMEOUT_MS',
  tentativasLeitura: 'GIA_SOFTEXPERT_TENTATIVAS_LEITURA',
  revogacaoConferida: 'GIA_SOFTEXPERT_REVOGACAO_CONFERIDA',
} as const;

/** Caminho do web service de administração dentro do API Gateway (conferido no ambiente real). */
export const CAMINHO_ADM_WS = '/apigateway/se/ws/adm_ws.php';

export type AutenticacaoSoftexpert =
  | { readonly modo: 'token'; readonly arquivoToken: string }
  | {
      readonly modo: 'contaServico';
      readonly usuario: string;
      readonly arquivoSenha: string;
    };

export interface ConfiguracaoSoftexpert {
  /** URL completa do `adm_ws.php`, sempre HTTPS. */
  readonly endpoint: string;
  readonly autenticacao: AutenticacaoSoftexpert;
  /** LANGUAGE do `newUser`; `null` omite o campo e o SE Suite usa o padrão da conta. */
  readonly idioma: string | null;
  /** Prazo de cada requisição HTTP, abaixo do timeout de chamada do motor (ADR-0004). */
  readonly timeoutMs: number;
  /** Tentativas de uma LEITURA em falha transitória. Escritas nunca são repetidas aqui. */
  readonly tentativasLeitura: number;
  /**
   * O `disableUser` ainda não foi conferido contra o WSDL do ambiente. Enquanto
   * `false`, a revogação é recusada sem chamar o SE Suite.
   */
  readonly revogacaoConferida: boolean;
}

function texto(env: VariaveisAmbiente, nome: string): string {
  return env[nome]?.trim() ?? '';
}

export function carregarConfiguracaoSoftexpert(env: VariaveisAmbiente): ConfiguracaoSoftexpert {
  const erros = new Set<string>();
  const V = VARIAVEIS_SOFTEXPERT;

  let endpoint = '';
  const url = texto(env, V.url);
  try {
    const lida = new URL(url);
    if (
      lida.protocol !== 'https:' ||
      lida.username !== '' ||
      lida.password !== '' ||
      lida.search !== '' ||
      lida.hash !== '' ||
      !/^\/?$/.test(lida.pathname)
    ) {
      erros.add(V.url);
    }
    endpoint = `${lida.origin}${CAMINHO_ADM_WS}`;
  } catch {
    erros.add(V.url);
  }

  const obrigatorio = (nome: string): string => {
    const valor = texto(env, nome);
    if (valor === '') erros.add(nome);
    return valor;
  };
  const inteiro = (nome: string, padrao: number, min: number, max: number): number => {
    const bruto = texto(env, nome);
    const valor = bruto === '' ? padrao : /^\d+$/.test(bruto) ? Number(bruto) : NaN;
    if (!(valor >= min && valor <= max)) erros.add(nome);
    return valor;
  };
  const booleano = (nome: string): boolean => {
    const bruto = texto(env, nome) || 'false';
    if (bruto !== 'true' && bruto !== 'false') erros.add(nome);
    return bruto === 'true';
  };

  let autenticacao: AutenticacaoSoftexpert;
  const modo = texto(env, V.autenticacao);
  if (modo === 'token') {
    autenticacao = { modo, arquivoToken: obrigatorio(V.arquivoToken) };
    // O token do gateway é pessoal: morre com o desligamento de quem o gerou.
    if (texto(env, 'GIA_AMBIENTE') === 'producao') erros.add(V.autenticacao);
  } else if (modo === 'contaServico') {
    const usuario = obrigatorio(V.usuarioServico);
    if (usuario !== '' && !/^[\w.@-]{1,64}$/.test(usuario)) erros.add(V.usuarioServico);
    autenticacao = { modo, usuario, arquivoSenha: obrigatorio(V.arquivoSenhaServico) };
  } else {
    erros.add(V.autenticacao);
    autenticacao = { modo: 'token', arquivoToken: '' };
  }

  const idioma = texto(env, V.idioma);
  if (idioma !== '' && !/^[\w-]{1,20}$/.test(idioma)) erros.add(V.idioma);

  const config: ConfiguracaoSoftexpert = {
    endpoint,
    autenticacao,
    idioma: idioma === '' ? null : idioma,
    timeoutMs: inteiro(V.timeoutMs, 20_000, 100, 25_000),
    tentativasLeitura: inteiro(V.tentativasLeitura, 2, 1, 3),
    revogacaoConferida: booleano(V.revogacaoConferida),
  };
  if (erros.size > 0) throw new ErroConfiguracao([...erros].sort());
  return Object.freeze(config);
}

/** Lê um segredo do arquivo do cofre. Nunca guarda nem registra o valor. */
export async function lerSegredoSoftexpert(caminho: string, variavel: string): Promise<string> {
  let conteudo: string;
  try {
    conteudo = await readFile(caminho, 'utf8');
  } catch {
    throw new ErroConfiguracao([variavel]);
  }
  const segredo = conteudo.replace(/\r?\n$/, '');
  if (segredo === '' || /[\r\n]/.test(segredo)) throw new ErroConfiguracao([variavel]);
  return segredo;
}

/**
 * Valor do header `Authorization`. O JWT do gateway vai **cru**, sem `Bearer`
 * (com o prefixo o gateway responde 401 como se não houvesse token); a conta de
 * serviço vai como Basic.
 */
export async function cabecalhoAutorizacao(autenticacao: AutenticacaoSoftexpert): Promise<string> {
  if (autenticacao.modo === 'token') {
    const token = await lerSegredoSoftexpert(
      autenticacao.arquivoToken,
      VARIAVEIS_SOFTEXPERT.arquivoToken,
    );
    return token.replace(/^Bearer\s+/i, '');
  }
  const senha = await lerSegredoSoftexpert(
    autenticacao.arquivoSenha,
    VARIAVEIS_SOFTEXPERT.arquivoSenhaServico,
  );
  return `Basic ${Buffer.from(`${autenticacao.usuario}:${senha}`, 'utf8').toString('base64')}`;
}
