import { ErroConfiguracao } from '@gia/contratos';
import { describe, expect, it } from 'vitest';
import { iniciar } from './index.js';

describe('@gia/worker', () => {
  it('inicia com escrita externa desligada', () => {
    expect(iniciar({})).toContain('escrita externa desligada');
  });

  it('recusa ligar a escrita externa', () => {
    expect(() => iniciar({ GIA_ESCRITA_EXTERNA: 'true' })).toThrow(ErroConfiguracao);
  });

  it('recusa ambiente inválido', () => {
    expect(() => iniciar({ GIA_AMBIENTE: 'x' })).toThrow(ErroConfiguracao);
  });
});
