import { describe, expect, it } from 'vitest';
import {
  ErroConfiguracao,
  VARIAVEL_TLS_NODE,
  exigirTlsVerificado,
  tlsVerificacaoDesligada,
} from './index.js';

const DESLIGADO = { [VARIAVEL_TLS_NODE]: '0' };
// Processo limpo: o teste não depende do ambiente de quem roda a suíte.
const LIMPO = {};

describe('verificação TLS (M6)', () => {
  it('só NODE_TLS_REJECT_UNAUTHORIZED=0 desliga a verificação, no ambiente ou no processo', () => {
    expect(tlsVerificacaoDesligada({}, LIMPO)).toBe(false);
    expect(tlsVerificacaoDesligada({ [VARIAVEL_TLS_NODE]: '1' }, LIMPO)).toBe(false);
    expect(tlsVerificacaoDesligada({ [VARIAVEL_TLS_NODE]: '' }, LIMPO)).toBe(false);
    expect(tlsVerificacaoDesligada(DESLIGADO, LIMPO)).toBe(true);
    expect(tlsVerificacaoDesligada({ [VARIAVEL_TLS_NODE]: ' 0 ' }, LIMPO)).toBe(true);
    // O Node consulta o ambiente do processo, mesmo que a cópia recebida não traga a variável.
    expect(tlsVerificacaoDesligada({}, DESLIGADO)).toBe(true);
  });

  it('produção recusa subir, citando só o nome da variável', () => {
    for (const [env, processo] of [
      [{ GIA_AMBIENTE: 'producao', ...DESLIGADO }, LIMPO],
      [{ GIA_AMBIENTE: ' producao ' }, DESLIGADO],
    ] as const) {
      let erro: unknown;
      try {
        exigirTlsVerificado(env, processo);
      } catch (e) {
        erro = e;
      }
      expect(erro).toBeInstanceOf(ErroConfiguracao);
      expect((erro as ErroConfiguracao).variaveis).toEqual([VARIAVEL_TLS_NODE]);
      expect((erro as Error).message).toBe(`Configuração inválida: ${VARIAVEL_TLS_NODE}`);
    }
  });

  it('desenvolvimento, teste e ambiente não declarado não bloqueiam, mas avisam', () => {
    for (const env of [{ GIA_AMBIENTE: 'desenvolvimento' }, { GIA_AMBIENTE: 'teste' }, {}])
      expect(exigirTlsVerificado({ ...env, ...DESLIGADO }, LIMPO)).toBe(true);
    expect(exigirTlsVerificado({ GIA_AMBIENTE: 'producao' }, LIMPO)).toBe(false);
  });
});
