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
    const semChave = { fields: {} };
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
