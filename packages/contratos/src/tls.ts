import { ErroConfiguracao, type VariaveisAmbiente } from './configuracao.js';

/**
 * Variável do Node que desliga a verificação de certificado TLS do processo
 * inteiro: LDAPS do AD, HTTPS dos conectores, OIDC/JWKS e PostgreSQL passariam
 * a aceitar qualquer certificado, inclusive de um intermediário (pendência M6).
 */
export const VARIAVEL_TLS_NODE = 'NODE_TLS_REJECT_UNAUTHORIZED';

/**
 * A verificação TLS está desligada? Olha o ambiente recebido e também o do
 * processo, porque é o do processo que o Node consulta ao abrir conexões.
 */
export function tlsVerificacaoDesligada(
  env: VariaveisAmbiente,
  processo: VariaveisAmbiente = process.env,
): boolean {
  return [env, processo].some((origem) => origem[VARIAVEL_TLS_NODE]?.trim() === '0');
}

/**
 * Em `producao`, recusa subir com a verificação TLS desligada; o erro cita só
 * o nome da variável. Nos demais ambientes não bloqueia e devolve `true` para
 * o chamador registrar o aviso.
 */
export function exigirTlsVerificado(
  env: VariaveisAmbiente,
  processo: VariaveisAmbiente = process.env,
): boolean {
  const desligada = tlsVerificacaoDesligada(env, processo);
  if (desligada && env['GIA_AMBIENTE']?.trim() === 'producao') {
    throw new ErroConfiguracao([VARIAVEL_TLS_NODE]);
  }
  return desligada;
}
