import { ErroConfiguracao } from '@gia/contratos';
import { describe, expect, it } from 'vitest';
import { carregarConfiguracaoWorker, executarWorker, iniciar } from './index.js';

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

  it('identidade e intervalo do worker vêm do ambiente, com padrões', () => {
    expect(carregarConfiguracaoWorker({})).toMatchObject({
      ambiente: 'desenvolvimento',
      escritaExterna: false,
      intervaloMs: 1_000,
    });
    expect(carregarConfiguracaoWorker({}).workerId).toMatch(/^worker-/);
    expect(
      carregarConfiguracaoWorker({ GIA_WORKER_ID: ' worker-7 ', GIA_WORKER_INTERVALO_MS: '250' }),
    ).toMatchObject({ workerId: 'worker-7', intervaloMs: 250 });
  });

  it('intervalo inválido: o erro cita só o nome da variável', () => {
    for (const valor of ['0', '-5', 'rapido', '1.5']) {
      expect(() => carregarConfiguracaoWorker({ GIA_WORKER_INTERVALO_MS: valor })).toThrow(
        new ErroConfiguracao(['GIA_WORKER_INTERVALO_MS']),
      );
    }
  });

  it('sem URL do banco o worker não sobe', async () => {
    await expect(executarWorker({}, new AbortController().signal, () => undefined)).rejects.toThrow(
      'Configuração inválida: GIA_DATABASE_URL',
    );
  });
});
