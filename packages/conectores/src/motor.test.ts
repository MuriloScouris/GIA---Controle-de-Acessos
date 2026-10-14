import {
  ETAPAS_PROVISIONAR,
  ETAPAS_REVOGAR,
  type ParametrosSistema,
  type Sistema,
} from '@gia/dominio';
import { describe, expect, it } from 'vitest';
import { criarFornecedorAd } from './adaptadores/ad.js';
import { criarFornecedorDocusign } from './adaptadores/docusign.js';
import { criarFornecedorJiraDestino } from './adaptadores/jira-destino.js';
import { criarFornecedorM365 } from './adaptadores/m365.js';
import { criarFornecedorSoftexpert } from './adaptadores/softexpert.js';
import { ErroFornecedor } from './erros.js';
import { comLimite, criarConector, type Fornecedor } from './motor.js';
import { AdSimulado } from './simuladores/ad.js';
import { DocusignSimulado } from './simuladores/docusign.js';
import { JiraDestinoSimulado } from './simuladores/jira.js';
import { GraphSimulado } from './simuladores/m365.js';
import { SoftexpertSimulado } from './simuladores/softexpert.js';
import {
  CADASTROS,
  OU_INATIVOS,
  contexto,
  contextoRevogacao,
  paramsAd,
  paramsDocusign,
  paramsJira,
  paramsM365,
  paramsSoftexpert,
} from './teste/fabricas.js';

describe('motor dos conectores', () => {
  it('cada adaptador cobre exatamente as etapas do domínio, na ordem (regra 4)', () => {
    const casos: readonly (readonly [Sistema, unknown, ParametrosSistema])[] = [
      ['ad', criarFornecedorAd(new AdSimulado(), { ouInativos: OU_INATIVOS }), paramsAd()],
      ['m365', criarFornecedorM365(new GraphSimulado()), paramsM365()],
      ['docusign', criarFornecedorDocusign(new DocusignSimulado()), paramsDocusign()],
      ['softexpert', criarFornecedorSoftexpert(new SoftexpertSimulado()), paramsSoftexpert()],
      ['jira', criarFornecedorJiraDestino(new JiraDestinoSimulado()), paramsJira()],
    ];
    for (const [sistema, fornecedor, parametros] of casos) {
      const f = fornecedor as unknown as Fornecedor<Sistema>;
      const p = parametros as never;
      expect(f.passos('provisionar', p).map((passo) => passo.etapa)).toEqual(
        ETAPAS_PROVISIONAR[sistema],
      );
      expect(f.passos('revogar', p).map((passo) => passo.etapa)).toEqual(ETAPAS_REVOGAR[sistema]);
    }
  });

  it('chamada que estoura o tempo vira timeout e resultado desconhecido (regra 3)', async () => {
    const simulador = new AdSimulado(CADASTROS.ad);
    // Cliente que nunca responde.
    const travado = Object.assign(Object.create(simulador) as AdSimulado, {
      criarContaDesabilitada: () => new Promise<string>(() => undefined),
    });
    const conector = criarConector(criarFornecedorAd(travado, { ouInativos: OU_INATIVOS }), {
      modo: 'simulado',
      timeoutChamadaMs: 20,
    });
    expect(await conector.provisionar(contexto(paramsAd()))).toMatchObject({
      efeito: 'desconhecido',
      codigo: 'TIMEOUT',
      etapa: null,
    });
  });

  it('testarConexao respeita o timeout de conexão', async () => {
    const travado = Object.assign(Object.create(new AdSimulado()) as AdSimulado, {
      testar: () => new Promise<void>(() => undefined),
    });
    const conector = criarConector(criarFornecedorAd(travado, { ouInativos: OU_INATIVOS }), {
      modo: 'simulado',
      timeoutConexaoMs: 20,
    });
    expect(await conector.testarConexao()).toMatchObject({ disponivel: false, codigo: 'TIMEOUT' });
  });

  it('comLimite devolve o valor quando a chamada termina a tempo', async () => {
    await expect(comLimite(() => Promise.resolve(42), 1_000)).resolves.toBe(42);
    await expect(comLimite(() => new Promise<number>(() => undefined), 10)).rejects.toBeInstanceOf(
      ErroFornecedor,
    );
  });

  it('erro que não é do fornecedor numa escrita é tratado como desconhecido, sem vazar a mensagem', async () => {
    const simulador = new AdSimulado(CADASTROS.ad);
    const quebrado = Object.assign(Object.create(simulador) as AdSimulado, {
      criarContaDesabilitada: () => Promise.reject(new Error('senha=Abc123 vazou do driver')),
    });
    const conector = criarConector(criarFornecedorAd(quebrado, { ouInativos: OU_INATIVOS }), {
      modo: 'simulado',
    });
    const resultado = await conector.provisionar(contexto(paramsAd()));
    expect(resultado).toMatchObject({ efeito: 'desconhecido', codigo: 'ERRO_INESPERADO' });
    expect(JSON.stringify(resultado)).not.toContain('Abc123');
  });

  it('mensagens do fornecedor passam pela sanitização do contrato (regra 12)', async () => {
    const simulador = new AdSimulado(CADASTROS.ad);
    const vaza = Object.assign(Object.create(simulador) as AdSimulado, {
      criarContaDesabilitada: () =>
        Promise.reject(
          new ErroFornecedor(
            'recusado',
            'RECUSADO',
            'Falha: password=Hunter2 e Bearer abc.def.ghi',
          ),
        ),
    });
    const conector = criarConector(criarFornecedorAd(vaza, { ouInativos: OU_INATIVOS }), {
      modo: 'simulado',
    });
    const { mensagem } = await conector.provisionar(contexto(paramsAd()));
    expect(mensagem).not.toContain('Hunter2');
    expect(mensagem).not.toContain('abc.def.ghi');
    expect(mensagem).toContain('[OCULTO]');
  });

  it('resposta fora do contrato (código vazio) vira desconhecido em vez de sucesso', async () => {
    const simulador = new AdSimulado(CADASTROS.ad);
    const conector = criarConector(
      criarFornecedorAd(
        Object.assign(Object.create(simulador) as AdSimulado, {
          criarContaDesabilitada: () =>
            Promise.reject(new ErroFornecedor('recusado', '', 'sem código')),
        }),
        { ouInativos: OU_INATIVOS },
      ),
      { modo: 'simulado' },
    );
    expect(await conector.provisionar(contexto(paramsAd()))).toMatchObject({
      efeito: 'desconhecido',
      codigo: 'RESPOSTA_INVALIDA',
    });
  });

  it('conferirExistencia com parâmetros de outro sistema é erro de uso, não consulta o destino', async () => {
    const simulador = new AdSimulado(CADASTROS.ad);
    const conector = criarConector(criarFornecedorAd(simulador, { ouInativos: OU_INATIVOS }), {
      modo: 'simulado',
    });
    await expect(conector.conferirExistencia(contexto(paramsJira()))).rejects.toThrow();
    expect(simulador.roteiro.chamadas('buscarConta')).toBe(0);
    expect((await conector.validar(contexto(paramsJira()))).impedimentos[0]?.codigo).toBe(
      'PARAMETROS_INCOMPATIVEIS',
    );
    expect(await conector.revogar(contextoRevogacao(paramsJira()))).toMatchObject({
      codigo: 'PARAMETROS_INCOMPATIVEIS',
    });
  });

  it('o modo do conector é o declarado, independentemente do que o contexto pede', async () => {
    const simulador = new AdSimulado(CADASTROS.ad);
    const conector = criarConector(criarFornecedorAd(simulador, { ouInativos: OU_INATIVOS }), {
      modo: 'simulado',
    });
    const resultado = await conector.provisionar(contexto(paramsAd(), { modo: 'real' }));
    // O domínio compara com o modo da operação e manda para conferência (regra 9).
    expect(resultado.modo).toBe('simulado');
  });

  it('a data da conferência vem do relógio injetado', async () => {
    const simulador = new AdSimulado(CADASTROS.ad);
    const conector = criarConector(criarFornecedorAd(simulador, { ouInativos: OU_INATIVOS }), {
      modo: 'simulado',
      agora: () => '2026-10-14T12:00:00.000Z',
    });
    expect((await conector.conferirExistencia(contexto(paramsAd()))).conferidaEm).toBe(
      '2026-10-14T12:00:00.000Z',
    );
  });
});
