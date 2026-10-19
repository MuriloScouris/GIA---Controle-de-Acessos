import { createPrivateKey, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ErroConfiguracao, type VariaveisAmbiente } from '@gia/contratos';

export interface ConfiguracaoDocusign {
  readonly ambiente: 'demo' | 'producao';
  readonly integracaoId: string;
  readonly usuarioId: string;
  readonly contaId: string;
  readonly chavePrivadaArquivo: string;
  /** Prazo total, incluindo autenticação, paginação e backoff. */
  readonly timeoutMs: number;
  readonly tentativasLeitura: number;
  readonly escritaHabilitada: boolean;
}

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** Teto que o chamador (composição do worker/API) impõe ao que o ambiente configurou. */
export interface LimitesConfiguracaoDocusign {
  /** Prazo do motor menos a folga: `timeoutMs` nunca passa disso, mas o ambiente é validado antes. */
  readonly prazoMaximoMs?: number;
}

/**
 * Configuração não contém a chave; somente o caminho de um secret montado.
 *
 * Política única de timeout (M5): `GIA_DOCUSIGN_TIMEOUT_MS` é sempre validado como veio (inteiro de
 * 100 a 25000, padrão 20000) — com ou sem composição. Só depois o teto do motor é aplicado, de modo
 * que valor inválido nunca é "consertado" em silêncio por um clamp.
 */
export function carregarConfiguracaoDocusign(
  env: VariaveisAmbiente,
  limites: LimitesConfiguracaoDocusign = {},
): ConfiguracaoDocusign {
  const erros: string[] = [];
  const texto = (nome: string): string => {
    const valor = env[nome]?.trim() ?? '';
    if (!valor) erros.push(nome);
    return valor;
  };
  const uuid = (nome: string): string => {
    const valor = texto(nome);
    if (valor && !UUID.test(valor)) erros.push(nome);
    return valor;
  };
  const inteiro = (nome: string, padrao: number, min: number, max: number): number => {
    const valor = env[nome] ?? String(padrao);
    if (!/^\d+$/.test(valor) || Number(valor) < min || Number(valor) > max) erros.push(nome);
    return Number(valor);
  };
  const ambiente = env['GIA_DOCUSIGN_AMBIENTE'];
  if (ambiente !== 'demo' && ambiente !== 'producao') erros.push('GIA_DOCUSIGN_AMBIENTE');
  if (env['GIA_AMBIENTE'] === 'producao' && ambiente !== 'producao')
    erros.push('GIA_DOCUSIGN_AMBIENTE');
  const escrita = env['GIA_DOCUSIGN_ESCRITA_HABILITADA'] ?? 'false';
  if (escrita !== 'true' && escrita !== 'false') erros.push('GIA_DOCUSIGN_ESCRITA_HABILITADA');
  const config = {
    ambiente: ambiente === 'producao' ? ('producao' as const) : ('demo' as const),
    integracaoId: uuid('GIA_DOCUSIGN_INTEGRACAO_ID'),
    usuarioId: uuid('GIA_DOCUSIGN_USUARIO_ID'),
    contaId: uuid('GIA_DOCUSIGN_CONTA_ID'),
    chavePrivadaArquivo: texto('GIA_DOCUSIGN_CHAVE_PRIVADA_ARQUIVO'),
    timeoutMs: Math.min(
      inteiro('GIA_DOCUSIGN_TIMEOUT_MS', 20_000, 100, 25_000),
      limites.prazoMaximoMs ?? Infinity,
    ),
    tentativasLeitura: inteiro('GIA_DOCUSIGN_TENTATIVAS_LEITURA', 3, 1, 3),
    escritaHabilitada: escrita === 'true',
  };
  if (erros.length) throw new ErroConfiguracao([...new Set(erros)].sort());
  return Object.freeze(config);
}

export async function carregarChaveDocusign(arquivo: string): Promise<KeyObject> {
  try {
    const chave = createPrivateKey(await readFile(arquivo));
    if (
      chave.asymmetricKeyType !== 'rsa' ||
      (chave.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      throw new Error();
    return chave;
  } catch {
    throw new ErroConfiguracao(['GIA_DOCUSIGN_CHAVE_PRIVADA_ARQUIVO']);
  }
}
