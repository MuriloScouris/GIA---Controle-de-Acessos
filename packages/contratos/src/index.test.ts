import { describe, expect, it } from 'vitest';
import { PACOTE, configuracaoAmbienteSchema } from './index.js';

describe('@gia/contratos', () => {
  it('expõe o identificador do pacote', () => {
    expect(PACOTE).toBe('@gia/contratos');
  });

  it('desliga a escrita externa por padrão', () => {
    expect(configuracaoAmbienteSchema.parse({})).toEqual({
      ambiente: 'desenvolvimento',
      escritaExterna: false,
    });
  });

  it('rejeita ambiente desconhecido', () => {
    expect(configuracaoAmbienteSchema.safeParse({ ambiente: 'x' }).success).toBe(false);
  });
});
