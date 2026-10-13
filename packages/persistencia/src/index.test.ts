import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACOTE, criarUnidadeDeTrabalhoEmMemoria } from './index.js';

describe('@gia/persistencia', () => {
  it('expõe o identificador do pacote', () => {
    expect(PACOTE).toBe('@gia/persistencia');
  });

  it('confirma todas as mudanças quando o trabalho termina bem', async () => {
    const { uow, confirmados } = criarUnidadeDeTrabalhoEmMemoria<string>();
    await uow.executar(async (tx) => {
      tx.push('estado', 'evento');
    });
    expect(confirmados()).toEqual(['estado', 'evento']);
  });

  it('descarta tudo quando o trabalho falha (atomicidade estado + evento)', async () => {
    const { uow, confirmados } = criarUnidadeDeTrabalhoEmMemoria<string>();
    await expect(
      uow.executar(async (tx) => {
        tx.push('estado');
        throw new Error('falha antes do evento');
      }),
    ).rejects.toThrow('falha antes do evento');
    expect(confirmados()).toEqual([]);
  });

  it('não depende de driver de banco nem de rede', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).toEqual(['@gia/contratos']);
  });
});
