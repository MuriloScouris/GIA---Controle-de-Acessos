import { randomUUID } from 'node:crypto';
import {
  criarAtorDaSessao,
  falha,
  sucesso,
  type ContextoComando,
  type PedidoAdmissao,
} from '@gia/dominio';
import { describe, expect, it } from 'vitest';
import { criarPersistenciaEmMemoria, ErroDeIntegridade } from '../persistencia/memoria.js';
import { PESSOAS_FICTICIAS } from '../sessao/sessoes-simuladas.js';
import { criarDiretorioSimulado } from '../simuladores/diretorio-simulado.js';
import { criarJiraSimulado } from '../simuladores/jira-simulado.js';
import { executarComando } from './comandos.js';
import type { DependenciasCasosDeUso } from './dependencias.js';
import { importarChamadosJira } from './importar-jira.js';
import { REGRAS_PROPOSTA_FICTICIAS } from './regras-proposta.js';
import { emTransacao } from './transacao.js';

const ctx: ContextoComando = {
  ator: criarAtorDaSessao(PESSOAS_FICTICIAS.administradorGia),
  agora: '2026-10-13T12:00:00.000Z',
  correlacaoId: 'correlacao-teste',
  novoId: randomUUID,
};

function dependencias(modoExecucao: DependenciasCasosDeUso['modoExecucao']) {
  const persistencia = criarPersistenciaEmMemoria();
  const deps: DependenciasCasosDeUso = {
    persistencia,
    fonteJira: criarJiraSimulado().fonte,
    diretorio: criarDiretorioSimulado(),
    regras: REGRAS_PROPOSTA_FICTICIAS,
    modoExecucao,
  };
  return { deps, persistencia };
}

describe('solicitar execução em modo real (regra 8)', () => {
  it('sem liberação de escrita por sistema, nada entra na fila', async () => {
    const { deps, persistencia } = dependencias('real');
    const importado = await importarChamadosJira(deps, ctx);
    if (!importado.ok) throw new Error(importado.erro.codigo);
    const criado = importado.valor.criados.find((c) => c.chave === 'RH-1001');
    if (!criado) throw new Error('RH-1001 não importado');

    const aprovado = await executarComando(
      { pedidoId: criado.pedidoId, versaoEsperada: criado.versao, acao: 'aprovar', dados: {} },
      deps,
      ctx,
    );
    if (!aprovado.ok) throw new Error(aprovado.erro.codigo);
    const eventosAntes = persistencia.espiar.eventos().length;

    const solicitado = await executarComando(
      {
        pedidoId: criado.pedidoId,
        versaoEsperada: aprovado.valor.versao,
        acao: 'solicitarExecucao',
        dados: {},
      },
      deps,
      ctx,
    );
    expect(solicitado.ok ? null : solicitado.erro.codigo).toBe('ESCRITA_NAO_LIBERADA');
    expect(persistencia.espiar.operacoes()).toEqual([]);
    expect(persistencia.espiar.eventos()).toHaveLength(eventosAntes);
    expect(persistencia.espiar.itens().every((item) => item.status === 'pendente')).toBe(true);
  });
});

describe('persistência em memória', () => {
  const pedido = (id: string, idExterno: string): PedidoAdmissao =>
    ({ id, origem: { sistema: 'jira', idExterno } }) as PedidoAdmissao;

  it('recusa do domínio desfaz o que já tinha sido gravado na transação', async () => {
    const persistencia = criarPersistenciaEmMemoria();
    const resultado = await emTransacao(persistencia, async (tx) => {
      await tx.pedidos.salvar(pedido(randomUUID(), 'RH-1'));
      return falha('CONFLITO_DE_VERSAO');
    });
    expect(resultado.ok).toBe(false);
    expect(persistencia.espiar.pedidos()).toEqual([]);
  });

  it('erro inesperado também desfaz tudo e não trava as próximas transações', async () => {
    const persistencia = criarPersistenciaEmMemoria();
    await expect(
      persistencia.executar(async (tx) => {
        await tx.pedidos.salvar(pedido(randomUUID(), 'RH-1'));
        throw new Error('falha no meio');
      }),
    ).rejects.toThrow('falha no meio');
    const ok = await emTransacao(persistencia, async (tx) => {
      await tx.pedidos.salvar(pedido(randomUUID(), 'RH-2'));
      return sucesso(true);
    });
    expect(ok.ok).toBe(true);
    expect(persistencia.espiar.pedidos().map((p) => p.origem.idExterno)).toEqual(['RH-2']);
  });

  it('garante a unicidade da origem do pedido (regra 10) mesmo sem o domínio', async () => {
    const persistencia = criarPersistenciaEmMemoria();
    await persistencia.executar((tx) => tx.pedidos.salvar(pedido(randomUUID(), 'RH-9')));
    await expect(
      persistencia.executar((tx) => tx.pedidos.salvar(pedido(randomUUID(), 'rh-9 '))),
    ).rejects.toBeInstanceOf(ErroDeIntegridade);
    expect(persistencia.espiar.pedidos()).toHaveLength(1);
  });
});
