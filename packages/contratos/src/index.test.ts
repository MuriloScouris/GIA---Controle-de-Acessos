import { describe, expect, it } from 'vitest';
import {
  ErroConfiguracao,
  PACOTE,
  carregarConfiguracaoAmbiente,
  carregarConfiguracaoApi,
  configuracaoAmbienteSchema,
  saudeRespostaSchema,
} from './index.js';

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

  it('valida a resposta de saúde', () => {
    expect(saudeRespostaSchema.safeParse({ status: 'ok' }).success).toBe(true);
    expect(saudeRespostaSchema.safeParse({ status: 'x' }).success).toBe(false);
  });
});

describe('carregarConfiguracaoApi', () => {
  it('aplica os padrões com ambiente vazio', () => {
    expect(carregarConfiguracaoApi({})).toEqual({
      ambiente: 'desenvolvimento',
      escritaExterna: false,
      porta: 3000,
    });
  });

  it('aceita porta e ambiente válidos', () => {
    expect(carregarConfiguracaoApi({ PORT: '8080', GIA_AMBIENTE: 'teste' })).toMatchObject({
      porta: 8080,
      ambiente: 'teste',
    });
  });

  it.each(['abc', '0', '-1', '1.5', '65536', '3000x', ' '])('rejeita PORT=%j', (porta) => {
    expect(() => carregarConfiguracaoApi({ PORT: porta })).toThrow(ErroConfiguracao);
  });

  it('rejeita ambiente desconhecido', () => {
    expect(() => carregarConfiguracaoApi({ GIA_AMBIENTE: 'x' })).toThrow(ErroConfiguracao);
  });

  it('rejeita ligar a escrita externa', () => {
    expect(() => carregarConfiguracaoApi({ GIA_ESCRITA_EXTERNA: 'true' })).toThrow(
      ErroConfiguracao,
    );
    expect(() => carregarConfiguracaoAmbiente({ GIA_ESCRITA_EXTERNA: 'true' })).toThrow(
      ErroConfiguracao,
    );
  });

  it('não vaza valores na mensagem de erro', () => {
    try {
      carregarConfiguracaoApi({ PORT: 'segredo-123', GIA_AMBIENTE: 'valor-sensivel' });
      expect.unreachable();
    } catch (e) {
      const erro = e as ErroConfiguracao;
      expect(erro.variaveis).toEqual(['GIA_AMBIENTE', 'PORT']);
      expect(erro.message).not.toMatch(/segredo|sensivel/);
    }
  });
});
