import { readFile } from 'node:fs/promises';
import { ErroConfiguracao, type VariaveisAmbiente } from './configuracao.js';

/**
 * Segredos fora de tudo (regra 12): senha, token e chave chegam por ARQUIVO
 * montado pelo cofre (`<NOME>_ARQUIVO`), nunca pelo valor na variável de
 * ambiente — que vaza em `ps`, `/proc/<pid>/environ`, dumps e logs de deploy.
 */

/** Nomes que, sem o sufixo `_ARQUIVO`, indicam segredo passado por valor. */
const NOME_DE_SEGREDO =
  /^GIA_[A-Z0-9_]*(SENHA|PASSWORD|PASSWD|TOKEN|SECRET|SEGREDO|CHAVE|API_KEY|APIKEY|CREDENCIAL)(_[A-Z0-9]+)*$/;

/** URL de conexão com senha embutida (`esquema://usuario:senha@host`). */
const URL_COM_SENHA = /^[a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:[^@\s]+@/i;

/** Variáveis que aceitam o valor vindo de arquivo (`<NOME>_ARQUIVO`). */
export const SEGREDOS_EM_ARQUIVO = ['GIA_DATABASE_URL'] as const;

/** Nomes (nunca valores) das variáveis com segredo passado por valor. */
export function segredosNoAmbiente(env: VariaveisAmbiente): readonly string[] {
  const achados = new Set<string>();
  for (const [nome, valor] of Object.entries(env)) {
    if (valor === undefined || valor.trim() === '') continue;
    if (!nome.startsWith('GIA_') || nome.endsWith('_ARQUIVO')) continue;
    // Valor que `resolverSegredosDeArquivo` leu do cofre: não veio do ambiente.
    if ((env[`${nome}_ARQUIVO`]?.trim() ?? '') !== '') continue;
    // Variáveis de teste ficam fora: apontam para serviços efêmeros do CI.
    if (/_TESTE(_|$)/.test(nome)) continue;
    if (NOME_DE_SEGREDO.test(nome) || URL_COM_SENHA.test(valor.trim())) achados.add(nome);
  }
  return [...achados].sort();
}

/**
 * Em produção, recusa subir com segredo passado por valor. Nos demais
 * ambientes devolve os nomes para o chamador registrar como aviso.
 */
export function exigirSegredosForaDoAmbiente(env: VariaveisAmbiente): readonly string[] {
  const achados = segredosNoAmbiente(env);
  if (achados.length > 0 && env['GIA_AMBIENTE']?.trim() === 'producao') {
    throw new ErroConfiguracao(achados);
  }
  return achados;
}

/**
 * Devolve uma cópia do ambiente com os segredos de `SEGREDOS_EM_ARQUIVO` lidos
 * do arquivo do cofre. Informar o valor e o arquivo ao mesmo tempo é erro.
 */
export async function resolverSegredosDeArquivo(
  env: VariaveisAmbiente,
): Promise<VariaveisAmbiente> {
  const resolvido: Record<string, string | undefined> = { ...env };
  const erros: string[] = [];
  for (const nome of SEGREDOS_EM_ARQUIVO) {
    const arquivo = env[`${nome}_ARQUIVO`]?.trim();
    if (arquivo === undefined || arquivo === '') continue;
    if ((env[nome]?.trim() ?? '') !== '') {
      erros.push(nome);
      continue;
    }
    try {
      const valor = (await readFile(arquivo, 'utf8')).replace(/\r?\n$/, '');
      if (valor === '' || /[\r\n]/.test(valor)) throw new Error();
      resolvido[nome] = valor;
    } catch {
      erros.push(`${nome}_ARQUIVO`);
    }
  }
  if (erros.length > 0) throw new ErroConfiguracao(erros.sort());
  return resolvido;
}
