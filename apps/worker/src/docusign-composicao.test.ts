/**
 * Equivalência DEV-283 (#19) → DEV-287 (#20). O #19 roteava o DocuSign no
 * worker com `apps/worker/src/docusign.ts`, que ele próprio previa substituir
 * pelo registro de conectores reais. Na integração (DEV-291) o arquivo saiu e o
 * #20 assumiu: cada caso dos testes do #19 está reproduzido aqui sobre a
 * composição atual (`conectoresReaisDoAmbiente` + `aplicarGatesDeEscrita`).
 *
 * Diferença intencional: o #19 ligava o DocuSign real com qualquer
 * `GIA_DOCUSIGN_*` presente; o #20 exige `GIA_DOCUSIGN_MODO=real`, porque a
 * seleção nunca é inferida de uma credencial.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carregarGatesDeEscrita, ErroConfiguracao } from '@gia/contratos';
import { POLITICA_EXECUCAO_PADRAO, type ContextoItem, type ModoExecucao } from '@gia/dominio';
import { criarPersistenciaPostgres } from '@gia/persistencia';
import {
  criarBancoDeTeste,
  TEM_BANCO,
  TEMPO_BANCO_MS,
  type BancoDeTeste,
} from '@gia/persistencia/teste';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { criarExecutor } from './executor.js';
import {
  aplicarGatesDeEscrita,
  CODIGO_CONECTOR_REAL_INDISPONIVEL,
  ConectorRealIndisponivel,
} from './gates.js';
import { iniciar, montarConectores } from './index.js';
import { conectoresReaisDoAmbiente } from './reais.js';
import { cenario, conectoresProgramados, gravar, INICIO, operacao } from './teste/fabricas.js';

const ID = '00000000-0000-4000-8000-000000000001';
let pasta = '';
let arquivoChave = '';

beforeAll(async () => {
  pasta = await mkdtemp(join(tmpdir(), 'gia-docusign-'));
  arquivoChave = join(pasta, 'chave.pem');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(arquivoChave, privateKey.export({ type: 'pkcs8', format: 'pem' }));
});
afterAll(async () => {
  await rm(pasta, { recursive: true, force: true });
});

const envCompleto = (): Record<string, string | undefined> => ({
  GIA_AMBIENTE: 'teste',
  GIA_DOCUSIGN_MODO: 'real',
  GIA_DOCUSIGN_AMBIENTE: 'demo',
  GIA_DOCUSIGN_INTEGRACAO_ID: ID,
  GIA_DOCUSIGN_USUARIO_ID: ID,
  GIA_DOCUSIGN_CONTA_ID: ID,
  GIA_DOCUSIGN_CHAVE_PRIVADA_ARQUIVO: arquivoChave,
});

/** Chave mestra ligada e DocuSign liberado: só falta (ou não) o conector real. */
const gatesLiberados = () =>
  carregarGatesDeEscrita({
    GIA_AMBIENTE: 'teste',
    GIA_ESCRITA_EXTERNA: 'true',
    GIA_ESCRITA_LIBERADA: 'docusign:criar,docusign:revogar',
  });

function ctx(modo: ModoExecucao): ContextoItem {
  const item = cenario(['docusign'], { modo }).itens.docusign!;
  return {
    operacaoId: randomUUID(),
    itemId: item.id,
    chaveIdempotencia: `gia:${modo}:teste`,
    modo,
    parametros: item.parametros,
    etapaInicial: null,
  };
}

describe('DocuSign real no worker: montagem (casos do #19)', () => {
  it('sem seleção nada muda: sem conector real, nem com GIA_DOCUSIGN_* soltas', async () => {
    expect(await conectoresReaisDoAmbiente({}, POLITICA_EXECUCAO_PADRAO)).toEqual({});
    const semModo = { ...envCompleto(), GIA_DOCUSIGN_MODO: undefined };
    expect(
      (await conectoresReaisDoAmbiente(semModo, POLITICA_EXECUCAO_PADRAO)).docusign,
    ).toBeUndefined();
    expect(iniciar({})).toBe('worker pronto (desenvolvimento, escrita externa desligada)');
  });

  it('configuração pela metade impede o worker de subir, citando só os nomes', async () => {
    const parcial = {
      GIA_AMBIENTE: 'teste',
      GIA_DOCUSIGN_MODO: 'real',
      GIA_DOCUSIGN_AMBIENTE: 'demo',
      GIA_DOCUSIGN_CONTA_ID: 'nao-e-uuid',
    };
    const erro = await conectoresReaisDoAmbiente(parcial, POLITICA_EXECUCAO_PADRAO).catch(
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(ErroConfiguracao);
    expect((erro as ErroConfiguracao).variaveis).toContain('GIA_DOCUSIGN_CONTA_ID');
    expect((erro as Error).message).not.toContain('nao-e-uuid');
  });

  it('configuração completa monta o conector real, lendo a chave do arquivo do cofre', async () => {
    const reais = await conectoresReaisDoAmbiente(envCompleto(), POLITICA_EXECUCAO_PADRAO);
    expect(Object.keys(reais)).toEqual(['docusign']);
    await expect(
      conectoresReaisDoAmbiente(
        { ...envCompleto(), GIA_DOCUSIGN_CHAVE_PRIVADA_ARQUIVO: join(pasta, 'nao-existe') },
        POLITICA_EXECUCAO_PADRAO,
      ),
    ).rejects.toMatchObject({ variaveis: ['GIA_DOCUSIGN_CHAVE_PRIVADA_ARQUIVO'] });
  });
});

describe('DocuSign real no worker: roteamento por modo, fail-closed (casos do #19)', () => {
  it('operação simulada vai ao simulador; real vai ao conector real', async () => {
    const simulados = conectoresProgramados('simulado');
    const reais = conectoresProgramados('real');
    const conectores = aplicarGatesDeEscrita(
      simulados.conectores,
      { docusign: reais.conectores.docusign },
      gatesLiberados(),
    );
    await conectores.docusign.provisionar(ctx('simulado'));
    await conectores.docusign.provisionar(ctx('real'));
    expect(simulados.chamadas.map((c) => c.ctx.modo)).toEqual(['simulado']);
    expect(reais.chamadas.map((c) => c.ctx.modo)).toEqual(['real']);
  });

  it('operação real sem conector real: semEfeito sem chamar ninguém, nunca o simulador', async () => {
    const simulados = conectoresProgramados('simulado');
    const conectores = aplicarGatesDeEscrita(simulados.conectores, {}, gatesLiberados());
    for (const resultado of [
      await conectores.docusign.provisionar(ctx('real')),
      await conectores.docusign.revogar({ ...ctx('real'), motivo: 'teste' }),
    ]) {
      expect(resultado).toMatchObject({
        efeito: 'semEfeito',
        modo: 'real',
        codigo: CODIGO_CONECTOR_REAL_INDISPONIVEL,
      });
    }
    expect(simulados.chamadas).toHaveLength(0);
    expect(() => conectores.docusign.conferirExistencia(ctx('real'))).toThrow(
      ConectorRealIndisponivel,
    );
  });
});

let banco: BancoDeTeste;
describe.skipIf(!TEM_BANCO)(
  'DocuSign real no worker: executor sobre PostgreSQL (caso do #19)',
  { timeout: TEMPO_BANCO_MS },
  () => {
    beforeAll(async () => {
      banco = await criarBancoDeTeste();
    }, TEMPO_BANCO_MS);
    afterAll(async () => {
      await banco?.descartar();
    }, TEMPO_BANCO_MS);

    it('operação real sem DocuSign configurado é registrada sem efeito e não toca o destino', async () => {
      const persistencia = criarPersistenciaPostgres(banco.db);
      const c = cenario(['docusign'], { modo: 'real' });
      const op = operacao(c, 'docusign');
      await gravar(persistencia, c, [op]);
      const executor = criarExecutor({
        persistencia,
        conectores: aplicarGatesDeEscrita(
          montarConectores(POLITICA_EXECUCAO_PADRAO).conectores,
          {},
          gatesLiberados(),
        ),
        politica: POLITICA_EXECUCAO_PADRAO,
        workerId: `teste-${randomUUID()}`,
        agora: () => INICIO,
        novoId: randomUUID,
      });
      const relatorio = await executor.processarLote();
      expect(relatorio.desfechos.map((d) => d.tipo)).toEqual(['registrada']);
      const registrada = await persistencia.executar((tx) => tx.fila.operacaoPorId(op.id));
      expect(registrada).toMatchObject({
        modo: 'real',
        efeito: 'semEfeito',
        codigo: CODIGO_CONECTOR_REAL_INDISPONIVEL,
      });
    });
  },
);
