import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Registrador, RegistroMetricas } from '@gia/contratos';
import type { RelatorioLote } from './executor.js';
import type { DecisaoGate } from './gates.js';

export const VARIAVEL_ARQUIVO_SAUDE = 'GIA_WORKER_ARQUIVO_SAUDE';
export const VARIAVEL_SAUDE_MAXIMO_MS = 'GIA_WORKER_SAUDE_MAXIMO_MS';
export const VARIAVEL_METRICAS_PORTA = 'GIA_WORKER_METRICAS_PORTA';

/**
 * Instrumentação do worker. Logs e métricas levam só identificadores técnicos
 * (operação, pedido, item), sistema, ação, modo, efeito e código — nunca
 * parâmetros do item, que têm dados pessoais.
 */
export function criarObservabilidadeWorker(registrador: Registrador, metricas: RegistroMetricas) {
  const lotes = metricas.contador('gia_worker_lotes_total', 'Lotes processados.', ['resultado']);
  const operacoes = metricas.contador(
    'gia_worker_operacoes_total',
    'Operações processadas por desfecho.',
    ['sistema', 'acao', 'modo', 'desfecho', 'efeito'],
  );
  const recuperadas = metricas.contador(
    'gia_worker_leases_recuperados_total',
    'Leases vencidos recuperados.',
    ['destino'],
  );
  const gates = metricas.contador(
    'gia_worker_gate_escrita_total',
    'Decisões do gate de escrita real.',
    ['sistema', 'tipo', 'decisao'],
  );
  const ultimoLote = metricas.medidor(
    'gia_worker_ultimo_lote_timestamp_segundos',
    'Instante do último lote concluído (Unix, segundos).',
  );

  return {
    aoTerminarLote(relatorio: RelatorioLote, agora: number): void {
      lotes.incrementar({ resultado: 'ok' });
      ultimoLote.definir(Math.floor(agora / 1000));
      recuperadas.incrementar({ destino: 'reagendada' }, relatorio.recuperadas.reagendadas);
      recuperadas.incrementar(
        { destino: 'reconciliacao' },
        relatorio.recuperadas.paraReconciliacao,
      );
      for (const desfecho of relatorio.desfechos) {
        if (desfecho.tipo === 'registrada') {
          const { operacao } = desfecho;
          const efeito = operacao.efeito ?? 'nenhum';
          operacoes.incrementar({
            sistema: operacao.sistema,
            acao: operacao.acao,
            modo: operacao.modo,
            desfecho: desfecho.tipo,
            efeito,
          });
          // Auditoria operacional: correlaciona com os eventos do pedido pela operação.
          registrador.info('operacao_registrada', {
            operacaoId: operacao.id,
            pedidoId: operacao.pedidoId,
            itemId: operacao.itemId,
            sistema: operacao.sistema,
            acao: operacao.acao,
            modo: operacao.modo,
            statusOperacao: operacao.status,
            efeito,
            codigo: operacao.codigo,
            tentativas: operacao.tentativas,
          });
        } else {
          operacoes.incrementar({
            sistema: 'desconhecido',
            acao: 'desconhecida',
            modo: 'desconhecido',
            desfecho: desfecho.tipo,
            efeito: 'nenhum',
          });
          registrador.aviso(`operacao_${desfecho.tipo}`, {
            operacaoId: desfecho.operacaoId,
            codigo: 'erro' in desfecho ? desfecho.erro.codigo : null,
          });
        }
      }
      if (
        relatorio.reservadas +
          relatorio.recuperadas.reagendadas +
          relatorio.recuperadas.paraReconciliacao >
        0
      ) {
        registrador.info('lote_processado', {
          reservadas: relatorio.reservadas,
          desfechos: relatorio.desfechos.length,
          reagendadas: relatorio.recuperadas.reagendadas,
          paraReconciliacao: relatorio.recuperadas.paraReconciliacao,
        });
      }
    },
    aoFalharLote(erro: unknown): void {
      lotes.incrementar({ resultado: 'falha' });
      registrador.erro('lote_falhou', { erro: erro instanceof Error ? erro.name : 'erro' });
    },
    aoDecidirGate(decisao: DecisaoGate): void {
      gates.incrementar({ sistema: decisao.sistema, tipo: decisao.tipo, decisao: decisao.decisao });
      const campos = {
        operacaoId: decisao.operacaoId,
        sistema: decisao.sistema,
        tipo: decisao.tipo,
        decisao: decisao.decisao,
      };
      if (decisao.decisao === 'liberada') registrador.info('gate_escrita', campos);
      else registrador.aviso('gate_escrita', campos);
    },
  };
}

/**
 * Batimento do worker para a sonda do orquestrador: grava o instante do último
 * lote (concluído ou com falha tratada) num arquivo. Escrita atômica (arquivo
 * temporário + rename) para a sonda nunca ler um arquivo pela metade.
 */
export async function registrarBatimento(arquivo: string, agora: number): Promise<void> {
  const temporario = join(dirname(arquivo), `.${process.pid}.batimento.tmp`);
  await writeFile(temporario, `${agora}\n`, 'utf8');
  await rename(temporario, arquivo);
}

/**
 * Sonda de vivacidade (`pnpm --filter @gia/worker saude`): saudável se o último
 * batimento tem no máximo `maximoMs`. Sem arquivo, ilegível ou velho = parado.
 */
export async function verificarBatimento(
  arquivo: string,
  maximoMs: number,
  agora: number = Date.now(),
): Promise<{ readonly saudavel: boolean; readonly idadeMs: number | null }> {
  try {
    const instante = Number((await readFile(arquivo, 'utf8')).trim());
    if (!Number.isSafeInteger(instante)) return { saudavel: false, idadeMs: null };
    const idadeMs = Math.max(0, agora - instante);
    return { saudavel: idadeMs <= maximoMs, idadeMs };
  } catch {
    return { saudavel: false, idadeMs: null };
  }
}
