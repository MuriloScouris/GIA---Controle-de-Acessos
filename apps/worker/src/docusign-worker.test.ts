import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criarCatalogoSimulado } from '@gia/conectores';
import { ErroConfiguracao } from '@gia/contratos';
import { POLITICA_EXECUCAO_PADRAO, type ContextoItem, type ModoExecucao } from '@gia/dominio';
import { criarPersistenciaPostgres } from '@gia/persistencia';
import {
  criarBancoDeTeste,
  TEM_BANCO,
  TEMPO_BANCO_MS,
  type BancoDeTeste,
} from '@gia/persistencia/teste';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CODIGO_DOCUSIGN_REAL_INDISPONIVEL,
  comDocusignReal,
  docusignRealConfigurado,
  montarDocusignReal,
  validarDocusignReal,
} from './docusign.js';
import { criarExecutor } from './executor.js';
import { iniciar } from './index.js';
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

const envCompleto = () => ({
  GIA_DOCUSIGN_AMBIENTE: 'demo',
  GIA_DOCUSIGN_INTEGRACAO_ID: ID,
  GIA_DOCUSIGN_USUARIO_ID: ID,
  GIA_DOCUSIGN_CONTA_ID: ID,
  GIA_DOCUSIGN_CHAVE_PRIVADA_ARQUIVO: arquivoChave,
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

describe('DocuSign real no worker: montagem', () => {
  it('sem nenhuma GIA_DOCUSIGN_* nada muda: sem conector real', async () => {
    expect(docusignRealConfigurado({ GIA_DOCUSIGN_AMBIENTE: ' ' })).toBe(false);
    expect(await montarDocusignReal({}, POLITICA_EXECUCAO_PADRAO)).toBeNull();
    expect(iniciar({})).toBe('worker pronto (desenvolvimento, escrita externa desligada)');
  });

  it('configuração pela metade impede o worker de subir, citando só os nomes', () => {
    const parcial = { GIA_DOCUSIGN_AMBIENTE: 'demo', GIA_DOCUSIGN_CONTA_ID: 'nao-e-uuid' };
    expect(() => validarDocusignReal(parcial)).toThrow(ErroConfiguracao);
    expect(() => iniciar(parcial)).toThrow(/GIA_DOCUSIGN_CONTA_ID/);
    try {
      iniciar(parcial);
    } catch (erro) {
      expect((erro as Error).message).not.toContain('nao-e-uuid');
    }
  });

  it('configuração completa monta o conector real, lendo a chave do arquivo do cofre', async () => {
    expect(iniciar(envCompleto())).toContain('DocuSign real configurado');
    const conector = await montarDocusignReal(envCompleto(), POLITICA_EXECUCAO_PADRAO);
    expect(conector).not.toBeNull();
    await expect(
      montarDocusignReal(
        { ...envCompleto(), GIA_DOCUSIGN_CHAVE_PRIVADA_ARQUIVO: join(pasta, 'nao-existe') },
        POLITICA_EXECUCAO_PADRAO,
      ),
    ).rejects.toMatchObject({ variaveis: ['GIA_DOCUSIGN_CHAVE_PRIVADA_ARQUIVO'] });
  });
});

describe('DocuSign real no worker: roteamento por modo (fail-closed)', () => {
  it('operação simulada vai ao simulador; real vai ao conector real', async () => {
    const simulados = conectoresProgramados('simulado');
    const reais = conectoresProgramados('real');
    const conectores = comDocusignReal(simulados.conectores, reais.conectores.docusign);
    await conectores.docusign.provisionar(ctx('simulado'));
    await conectores.docusign.provisionar(ctx('real'));
    expect(simulados.chamadas.map((c) => c.ctx.modo)).toEqual(['simulado']);
    expect(reais.chamadas.map((c) => c.ctx.modo)).toEqual(['real']);
    // Os outros sistemas não são tocados.
    expect(conectores.ad).toBe(simulados.conectores.ad);
  });

  it('operação real sem conector real: semEfeito sem chamar ninguém, nunca o simulador', async () => {
    const simulados = conectoresProgramados('simulado');
    const conectores = comDocusignReal(simulados.conectores, null);
    for (const resultado of [
      await conectores.docusign.provisionar(ctx('real')),
      await conectores.docusign.revogar({ ...ctx('real'), motivo: 'teste' }),
    ]) {
      expect(resultado).toMatchObject({
        efeito: 'semEfeito',
        modo: 'real',
        codigo: CODIGO_DOCUSIGN_REAL_INDISPONIVEL,
      });
    }
    expect(simulados.chamadas).toHaveLength(0);
    expect(() => conectores.docusign.conferirExistencia(ctx('real'))).toThrow(
      CODIGO_DOCUSIGN_REAL_INDISPONIVEL,
    );
  });
});

let banco: BancoDeTeste;
describe.skipIf(!TEM_BANCO)(
  'DocuSign real no worker: executor sobre PostgreSQL',
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
        conectores: comDocusignReal(criarCatalogoSimulado().conectores, null),
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
        codigo: CODIGO_DOCUSIGN_REAL_INDISPONIVEL,
      });
    });
  },
);
