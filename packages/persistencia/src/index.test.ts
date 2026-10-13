import { describe, expect, it } from 'vitest';
import { PACOTE } from './index.js';

describe('@gia/persistencia', () => {
  it('expõe o identificador do pacote', () => {
    expect(PACOTE).toBe('@gia/persistencia');
  });
});
