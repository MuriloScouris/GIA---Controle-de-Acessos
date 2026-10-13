import { describe, expect, it } from 'vitest';
import { iniciar } from './index.js';

describe('@gia/worker', () => {
  it('inicia com escrita externa desligada', () => {
    expect(iniciar({})).toContain('escrita externa desligada');
  });

  it('ignora qualquer tentativa de ligar a escrita por ambiente', () => {
    expect(iniciar({ GIA_AMBIENTE: 'teste', GIA_ESCRITA_EXTERNA: 'true' })).toContain('(teste');
  });
});
