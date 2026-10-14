import { describe, expect, it } from 'vitest';
import { JiraOrigemSimulado } from '../simuladores/jira.js';
import { criarJiraOrigem } from './jira-origem.js';

const chamado = (key: string): unknown => ({
  key,
  fields: { tipoSolicitacao: 'Admissão - Celetista' },
});
const TIPOS = ['Admissão - Celetista', 'Admissão - Terceiro'] as const;

function montar(chamados: readonly unknown[], tamanhoPagina = 2, maxPaginas?: number) {
  const simulador = new JiraOrigemSimulado(chamados);
  const origem = criarJiraOrigem(simulador, {
    modo: 'simulado',
    tiposSolicitacao: TIPOS,
    tamanhoPagina,
    ...(maxPaginas === undefined ? {} : { maxPaginas }),
  });
  return { simulador, origem };
}

describe('Jira (origem)', () => {
  it('lê todas as páginas, na ordem', async () => {
    const { simulador, origem } = montar([1, 2, 3, 4, 5].map((n) => chamado(`RH-${n}`)));
    const lidos = await origem.buscarChamadosOnboarding();
    expect(lidos.map((c) => (c as { key: string }).key)).toEqual([
      'RH-1',
      'RH-2',
      'RH-3',
      'RH-4',
      'RH-5',
    ]);
    expect(simulador.roteiro.chamadas('buscarPagina')).toBe(3);
  });

  it('deduplica pela chave da issue e mantém o que não tem chave para a API recusar', async () => {
    const semChave = { fields: { tipoSolicitacao: 'Admissão - Terceiro' } };
    const { origem } = montar([
      chamado('RH-1'),
      chamado('RH-2'),
      chamado('RH-1'),
      semChave,
      semChave,
    ]);
    const lidos = await origem.buscarChamadosOnboarding();
    expect(lidos).toHaveLength(4);
    expect(lidos.filter((c) => (c as { key?: string }).key === 'RH-1')).toHaveLength(1);
  });

  it('só devolve os request types de onboarding, filtrando antes da paginação e do total', async () => {
    const tipado = (key: string, tipoSolicitacao: string): unknown => ({
      key,
      fields: { tipoSolicitacao },
    });
    const { simulador, origem } = montar(
      [
        tipado('RH-1', 'Desligamento'),
        tipado('RH-2', 'Admissão - Celetista'),
        tipado('RH-3', 'Acesso avulso'),
        tipado('RH-4', 'Admissão - Terceiro'),
        tipado('RH-5', 'Desligamento'),
        tipado('RH-6', 'Admissão - Celetista'),
        { key: 'RH-7' },
        'lixo',
      ],
      2,
    );
    const lidos = await origem.buscarChamadosOnboarding();
    expect(lidos.map((c) => (c as { key: string }).key)).toEqual(['RH-2', 'RH-4', 'RH-6']);
    // 3 chamados de onboarding em páginas de 2: duas páginas, não quatro.
    expect(simulador.roteiro.chamadas('buscarPagina')).toBe(2);
    expect(
      await simulador.buscarPagina({ tiposSolicitacao: TIPOS, inicio: 0, tamanho: 2 }),
    ).toMatchObject({ total: 3 });
    expect(
      await simulador.buscarPagina({ tiposSolicitacao: ['Desligamento'], inicio: 0, tamanho: 10 }),
    ).toMatchObject({ total: 2 });
    expect(await simulador.buscarPagina({ tiposSolicitacao: [], inicio: 0, tamanho: 10 })).toEqual({
      chamados: [],
      total: 0,
    });
  });

  it('busca vazia devolve lista vazia com uma única chamada', async () => {
    const { simulador, origem } = montar([]);
    expect(await origem.buscarChamadosOnboarding()).toEqual([]);
    expect(simulador.roteiro.chamadas('buscarPagina')).toBe(1);
  });

  it('é leitura: falha técnica é lançada para o worker retentar com backoff', async () => {
    const { simulador, origem } = montar([chamado('RH-1')]);
    simulador.roteiro.programar('buscarPagina', 'limiteDeTaxa', { tentarAposMs: 3_000 });
    await expect(origem.buscarChamadosOnboarding()).rejects.toMatchObject({
      tipo: 'limiteDeTaxa',
      tentarAposMs: 3_000,
    });
    // Na segunda tentativa a leitura completa.
    expect(await origem.buscarChamadosOnboarding()).toHaveLength(1);
  });

  it('falha numa página do meio não devolve leitura incompleta', async () => {
    const { simulador, origem } = montar([1, 2, 3, 4].map((n) => chamado(`RH-${n}`)));
    simulador.roteiro.programar('buscarPagina', 'sucesso');
    simulador.roteiro.programar('buscarPagina', 'timeout');
    await expect(origem.buscarChamadosOnboarding()).rejects.toMatchObject({ tipo: 'timeout' });
  });

  it('trava a paginação quando o total nunca fecha', async () => {
    const infinito = {
      testar: () => Promise.resolve(),
      buscarPagina: () =>
        Promise.resolve({ chamados: [chamado(`RH-${Math.random()}`)], total: 999_999 }),
    };
    const origem = criarJiraOrigem(infinito, {
      modo: 'simulado',
      tiposSolicitacao: TIPOS,
      maxPaginas: 3,
    });
    await expect(origem.buscarChamadosOnboarding()).rejects.toMatchObject({
      codigo: 'PAGINACAO_EXCEDIDA',
    });
  });

  it('não devolve referência ao estado interno do simulador', async () => {
    const { origem } = montar([chamado('RH-1')]);
    const [primeiro] = await origem.buscarChamadosOnboarding();
    (primeiro as { key: string }).key = 'ALTERADO';
    expect((await origem.buscarChamadosOnboarding())[0]).toMatchObject({ key: 'RH-1' });
  });

  it('testarConexao informa o modo e o código da falha, sem lançar', async () => {
    const { simulador, origem } = montar([]);
    expect(await origem.testarConexao()).toMatchObject({ modo: 'simulado', disponivel: true });
    simulador.roteiro.programar('testar', 'conexaoRecusada');
    expect(await origem.testarConexao()).toMatchObject({
      disponivel: false,
      codigo: 'CONEXAO_RECUSADA',
    });
  });
});
