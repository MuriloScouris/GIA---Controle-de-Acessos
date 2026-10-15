import { ErroConfiguracao, type VariaveisAmbiente } from '@gia/contratos';
import type { Autenticacao } from '../app.js';
import type { EventoLogin } from '../http/rotas-oidc.js';
import { VARIAVEIS_OIDC, carregarConfiguracaoOidc, criarClienteOidc } from './oidc.js';

export const VARIAVEL_SESSAO_SIMULADA = 'GIA_AUTH_SIMULADA';

/** Obrigatórias para o OIDC; em produção, a falta delas impede a API de subir. */
const OBRIGATORIAS_OIDC = [
  VARIAVEIS_OIDC.clientId,
  VARIAVEIS_OIDC.arquivoSegredo,
  VARIAVEIS_OIDC.redirectUri,
  VARIAVEIS_OIDC.tenantId,
].sort();

/** Linha JSON de auditoria do login (sem token, código, e-mail ou nome). */
function auditarNoStdout(ambiente: string): (evento: EventoLogin) => void {
  return (evento) => {
    process.stdout.write(
      `${JSON.stringify({ instante: new Date().toISOString(), servico: 'api', ambiente, ...evento })}\n`,
    );
  };
}

/**
 * Como as pessoas entram, a partir do ambiente:
 *
 * - com `GIA_OIDC_*` → Entra ID (OIDC); configuração parcial é erro;
 * - `desenvolvimento` → sessão simulada;
 * - `teste` → sessão simulada só com `GIA_AUTH_SIMULADA=true` (testes automatizados);
 * - `producao` → exige OIDC e recusa `GIA_AUTH_SIMULADA`.
 */
export function autenticacaoDoAmbiente(
  env: VariaveisAmbiente,
  ambiente: 'desenvolvimento' | 'teste' | 'producao',
  auditar: (evento: EventoLogin) => void = auditarNoStdout(ambiente),
): Autenticacao {
  const simulada = env[VARIAVEL_SESSAO_SIMULADA]?.trim() ?? '';
  if (simulada !== '' && simulada !== 'true' && simulada !== 'false') {
    throw new ErroConfiguracao([VARIAVEL_SESSAO_SIMULADA]);
  }
  if (ambiente === 'producao' && simulada === 'true') {
    throw new ErroConfiguracao([VARIAVEL_SESSAO_SIMULADA]);
  }
  const oidcConfigurado = Object.values(VARIAVEIS_OIDC).some(
    (nome) => (env[nome]?.trim() ?? '') !== '',
  );
  if (oidcConfigurado) {
    return {
      modo: 'oidc',
      cliente: criarClienteOidc(carregarConfiguracaoOidc(env)),
      auditarLogin: auditar,
    };
  }
  if (ambiente === 'producao') throw new ErroConfiguracao(OBRIGATORIAS_OIDC);
  if (ambiente === 'desenvolvimento' || simulada === 'true') return { modo: 'simulada' };
  return { modo: 'indisponivel' };
}
