import {
  avaliarExistencia,
  decidirProximoPasso,
  POLITICA_EXECUCAO_PADRAO,
  SISTEMAS,
  type ParametrosSistema,
  type Sistema,
} from '@gia/dominio';
import {
  resultadoConexaoSchema,
  resultadoExistenciaSchema,
  resultadoOperacaoSchema,
  resultadoValidacaoSchema,
} from '@gia/contratos';
import { describe, expect, it } from 'vitest';
import { criarCatalogoSimulado, type CatalogoSimulado } from './catalogo.js';
import {
  CADASTROS,
  contexto,
  contextoRevogacao,
  paramsAd,
  paramsDocusign,
  paramsJira,
  paramsM365,
  paramsSoftexpert,
} from './teste/fabricas.js';

const PARAMETROS: Readonly<Record<Sistema, ParametrosSistema>> = {
  ad: paramsAd(),
  m365: paramsM365(),
  docusign: paramsDocusign(),
  softexpert: paramsSoftexpert(),
  jira: paramsJira(),
};

function novoCatalogo(): CatalogoSimulado {
  return criarCatalogoSimulado({
    ad: CADASTROS.ad,
    m365: CADASTROS.m365,
    docusign: CADASTROS.docusign,
    softexpert: {
      areas: CADASTROS.softexpert.areas,
      funcoes: CADASTROS.softexpert.funcoes,
      grupos: CADASTROS.softexpert.grupos,
    },
    jira: CADASTROS.jira,
    chamadosJira: [{ key: 'RH-1', fields: {} }],
  });
}

describe('integração simulada: onboarding ponta a ponta nos cinco sistemas', () => {
  it('testa conexão, valida, provisiona, confere e revoga com resultados dentro do contrato', async () => {
    const catalogo = novoCatalogo();
    const { conectores, simuladores } = catalogo;

    for (const sistema of SISTEMAS) {
      const conexao = await conectores[sistema].testarConexao();
      expect(resultadoConexaoSchema.parse({ sistema, ...conexao })).toMatchObject({
        disponivel: true,
        modo: 'simulado',
      });
      const validacao = await conectores[sistema].validar(contexto(PARAMETROS[sistema]));
      expect(validacao.impedimentos).toEqual([]);
      resultadoValidacaoSchema.parse({ sistema, ...validacao });
    }

    // AD primeiro: o M365 só licencia o que o AD já criou e sincronizou (regra 7).
    const ad = await conectores.ad.provisionar(contexto(PARAMETROS.ad));
    expect(ad.efeito).toBe('confirmado');

    const aguardando = await conectores.m365.provisionar(contexto(PARAMETROS.m365));
    expect(aguardando.codigo).toBe('IDENTIDADE_NAO_SINCRONIZADA');
    expect(
      decidirProximoPasso(
        { acao: 'provisionar', modo: 'simulado', resultado: aguardando, tentativas: 1 },
        POLITICA_EXECUCAO_PADRAO,
      ).tipo,
    ).toBe('aguardarDependencia');

    simuladores.m365.sincronizarIdentidade('maria.souza@exemplo.com.br'); // AD → Entra, fora do Gia
    const resultados = {
      ad,
      m365: await conectores.m365.provisionar(contexto(PARAMETROS.m365)),
      docusign: await conectores.docusign.provisionar(contexto(PARAMETROS.docusign)),
      softexpert: await conectores.softexpert.provisionar(contexto(PARAMETROS.softexpert)),
      jira: await conectores.jira.provisionar(contexto(PARAMETROS.jira)),
    };
    for (const sistema of SISTEMAS) {
      const resultado = resultados[sistema];
      expect(resultado).toMatchObject({ efeito: 'confirmado', modo: 'simulado' });
      expect(resultadoOperacaoSchema.safeParse({ sistema, ...resultado }).success).toBe(true);
      // Simulado nunca vira sucesso real: com operação real o modo diverge e o domínio pede conferência.
      expect(resultado.modo).not.toBe('real');
    }

    // Regra 6: a conferência encontra tudo e só então o item é "completo".
    for (const sistema of SISTEMAS) {
      const existencia = await conectores[sistema].conferirExistencia(
        contexto(PARAMETROS[sistema]),
      );
      resultadoExistenciaSchema.parse({ sistema, ...existencia });
      expect(avaliarExistencia(existencia, PARAMETROS[sistema]).situacao).toBe('completo');
    }

    // Revogar (para quando o offboarding sair do standby).
    for (const sistema of SISTEMAS) {
      const revogacao = await conectores[sistema].revogar(contextoRevogacao(PARAMETROS[sistema]));
      expect(revogacao.efeito).toBe('confirmado');
    }
  });

  it('o Jira de origem simulado serve a porta de chamados da API', async () => {
    const { jiraOrigem } = novoCatalogo();
    expect(await jiraOrigem.buscarChamadosOnboarding()).toEqual([{ key: 'RH-1', fields: {} }]);
  });
});

describe('integração simulada: cenários e política de execução', () => {
  const executar = async (catalogo: CatalogoSimulado) =>
    catalogo.conectores.softexpert.provisionar(contexto(PARAMETROS.softexpert));

  it('sucesso: finaliza', async () => {
    const catalogo = novoCatalogo();
    catalogo.aplicarCenario('sucesso');
    const resultado = await executar(catalogo);
    expect(
      decidirProximoPasso(
        { acao: 'provisionar', modo: 'simulado', resultado, tentativas: 1 },
        POLITICA_EXECUCAO_PADRAO,
      ),
    ).toEqual({ tipo: 'finalizar' });
  });

  it('falha: efeito semEfeito, finaliza sem retentar escrita recusada', async () => {
    const catalogo = novoCatalogo();
    catalogo.aplicarCenario('falha');
    const resultado = await executar(catalogo);
    expect(resultado.efeito).toBe('semEfeito');
    expect(
      decidirProximoPasso(
        { acao: 'provisionar', modo: 'real', resultado, tentativas: 1 },
        POLITICA_EXECUCAO_PADRAO,
      ),
    ).toEqual({ tipo: 'finalizar' });
  });

  it('parcial: finaliza como parcial, pronto para retomar só o que falta', async () => {
    const catalogo = novoCatalogo();
    catalogo.aplicarCenario('parcial');
    const resultado = await catalogo.conectores.ad.provisionar(contexto(PARAMETROS.ad));
    expect(resultado).toMatchObject({ efeito: 'parcial', etapa: 'habilitarConta' });
    expect(
      decidirProximoPasso(
        { acao: 'provisionar', modo: 'real', resultado, tentativas: 1 },
        POLITICA_EXECUCAO_PADRAO,
      ),
    ).toEqual({ tipo: 'finalizar' });
  });

  it('timeout: escrita real vai para reconciliação, sem retentativa às cegas (regra 3)', async () => {
    const catalogo = novoCatalogo();
    catalogo.aplicarCenario('timeout');
    const resultado = await executar(catalogo);
    expect(resultado.efeito).toBe('desconhecido');
    expect(
      decidirProximoPasso(
        { acao: 'provisionar', modo: 'real', resultado, tentativas: 1 },
        POLITICA_EXECUCAO_PADRAO,
      ),
    ).toEqual({ tipo: 'reconciliar' });
  });

  it('rate limit: retenta com backoff e respeita o Retry-After do fornecedor', async () => {
    const catalogo = novoCatalogo();
    catalogo.aplicarCenario('limiteDeTaxa');
    const resultado = await executar(catalogo);
    const passo = decidirProximoPasso(
      { acao: 'provisionar', modo: 'real', resultado, tentativas: 1 },
      POLITICA_EXECUCAO_PADRAO,
    );
    expect(passo.tipo).toBe('retentar');
    if (passo.tipo === 'retentar') {
      expect(passo.aguardarMs).toBeGreaterThanOrEqual(2_000);
    }
    // Na segunda tentativa o cenário acabou e a escrita passa.
    expect((await executar(catalogo)).efeito).toBe('confirmado');
  });

  it('todo cenário pronto vale para os cinco simuladores de destino', async () => {
    for (const cenario of ['falha', 'timeout', 'limiteDeTaxa'] as const) {
      const catalogo = novoCatalogo();
      catalogo.simuladores.m365.sincronizarIdentidade('maria.souza@exemplo.com.br');
      catalogo.aplicarCenario(cenario);
      for (const sistema of SISTEMAS) {
        const resultado = await catalogo.conectores[sistema].provisionar(
          contexto(PARAMETROS[sistema]),
        );
        expect(resultado.efeito, `${sistema} / ${cenario}`).not.toBe('confirmado');
        expect(resultado.modo).toBe('simulado');
      }
    }
  });

  it('simuladores não deixam rastro de segredo em resultados nem nas chamadas registradas', async () => {
    const catalogo = novoCatalogo();
    await catalogo.conectores.ad.provisionar(contexto(PARAMETROS.ad));
    // A senha inicial é do transporte/cofre: o simulador só registra que foi definida.
    expect(catalogo.simuladores.ad.roteiro.chamadas('definirSenhaInicial')).toBe(1);
    const conta = catalogo.simuladores.ad.conta('maria.souza');
    expect(JSON.stringify(conta)).not.toMatch(/senha|password|secret/i);
  });
});
