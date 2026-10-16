import type { HistoricoPedido as Historico } from '@gia/contratos';
import { useEffect, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import { useApi } from '../api/ApiProvider.js';
import { ErroApi } from '../api/cliente.js';
import { useCarregar } from '../api/useCarregar.js';
import { formatarInstante, nomeSistema } from '../rotulos.js';
import { ErroCarga } from './ErroCarga.js';

const ROTULOS: Readonly<Record<string, string>> = {
  pedidoRecebido: 'Pedido recebido',
  colaboradorCriado: 'Colaborador criado',
  colaboradorIdentidadeAtualizada: 'Identidade do colaborador atualizada',
  colaboradorStatusAlterado: 'Status do colaborador alterado',
  propostaEditada: 'Proposta editada',
  identidadeVerificada: 'Identidade verificada',
  pedidoAprovado: 'Pedido aprovado',
  pedidoRejeitado: 'Pedido rejeitado',
  pedidoReaberto: 'Pedido reaberto',
  execucaoSolicitada: 'Execução solicitada',
  simulacaoSolicitada: 'Simulação solicitada',
  statusPedidoAlterado: 'Status do pedido alterado',
  operacaoReservada: 'Operação reservada',
  operacaoResultadoRegistrado: 'Resultado da operação registrado',
  operacaoReagendada: 'Operação reagendada',
  operacaoEncaminhadaParaReconciliacao: 'Operação encaminhada para reconciliação',
  acessoManualRegistrado: 'Acesso manual registrado',
  acessoManualComprovado: 'Acesso manual comprovado',
  itemReconciliado: 'Item reconciliado',
  configuracaoAlterada: 'Configuração alterada',
  liberacaoEscritaAlterada: 'Liberação de escrita alterada',
  estadoInicialSincronizado: 'Estado inicial sincronizado',
  alteracaoDetectadaNaSincronizacao: 'Alteração detectada na sincronização',
  correcaoRegistrada: 'Correção registrada',
  documentoEmitido: 'Documento emitido',
};

export function HistoricoPedido({ pedidoId }: { pedidoId: string }) {
  return <Conteudo key={pedidoId} pedidoId={pedidoId} />;
}

function Conteudo({ pedidoId }: { pedidoId: string }) {
  const api = useApi();
  const { estado, recarregar } = useCarregar(() => api.consultarHistorico(pedidoId));
  const [paginas, setPaginas] = useState<Historico[]>([]);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<ErroApi | null>(null);
  const epoca = useRef(0);
  const emVoo = useRef(false);
  const ativo = useRef(true);
  useEffect(() => {
    ativo.current = true;
    return () => {
      ativo.current = false;
    };
  }, []);

  function atualizar() {
    epoca.current += 1;
    emVoo.current = false;
    setPaginas([]);
    setErro(null);
    setOcupado(false);
    recarregar();
  }

  async function anteriores(cursor: string) {
    if (emVoo.current) return;
    emVoo.current = true;
    setOcupado(true);
    setErro(null);
    const iniciada = epoca.current;
    try {
      const pagina = await api.consultarHistorico(pedidoId, cursor);
      if (ativo.current && iniciada === epoca.current)
        setPaginas((anteriores) => [...anteriores, pagina]);
    } catch (falha) {
      if (ativo.current && iniciada === epoca.current)
        setErro(falha instanceof ErroApi ? falha : new ErroApi('Falha ao consultar histórico'));
    } finally {
      if (ativo.current && iniciada === epoca.current) {
        emVoo.current = false;
        setOcupado(false);
      }
    }
  }

  if (estado.situacao === 'carregando') return <p role="status">Carregando histórico…</p>;
  if (estado.situacao === 'erro')
    return <ErroCarga erro={estado.erro} onTentarDeNovo={atualizar} />;
  if (erro?.status === 401 || erro?.status === 403)
    return <ErroCarga erro={erro} onTentarDeNovo={atualizar} />;
  const todas = [estado.dados, ...paginas];
  const cursor = todas.at(-1)!.proximoCursor;
  const eventos = [...new Map(todas.flatMap((p) => p.eventos).map((e) => [e.id, e])).values()];
  return (
    <>
      <Button className="botao-link" onPress={atualizar} isDisabled={ocupado}>
        Atualizar histórico
      </Button>
      {erro && (
        <p role="alert">Não foi possível carregar os eventos anteriores. Tente novamente.</p>
      )}
      {eventos.length === 0 ? (
        <p className="estado">Nenhum evento registrado para este pedido.</p>
      ) : (
        <ol className="tl" aria-label="Histórico persistido do pedido">
          {eventos.map((evento) => (
            <li className="tl-item" key={evento.id}>
              <span className="tl-ponto" aria-hidden="true" />
              <div className="tl-cartao">
                <p className="tl-titulo">{ROTULOS[evento.tipo] ?? 'Evento registrado'}</p>
                <div className="tl-linha">
                  <time dateTime={evento.instante}>{formatarInstante(evento.instante)}</time>
                  <span>{evento.ator?.nome ?? 'Sincronização externa'}</span>
                  {evento.sistema && <span>{nomeSistema(evento.sistema)}</span>}
                </div>
                <dl>
                  <dt>Evento</dt>
                  <dd>{evento.id}</dd>
                  {evento.operacaoId && (
                    <>
                      <dt>Operação</dt>
                      <dd>{evento.operacaoId}</dd>
                    </>
                  )}
                  {evento.correlacaoId && (
                    <>
                      <dt>Correlação</dt>
                      <dd>{evento.correlacaoId}</dd>
                    </>
                  )}
                  {evento.corrigeEventoId && (
                    <>
                      <dt>Corrige o evento</dt>
                      <dd>{evento.corrigeEventoId}</dd>
                    </>
                  )}
                </dl>
              </div>
            </li>
          ))}
        </ol>
      )}
      {cursor && (
        <Button
          className="botao-secundario"
          isDisabled={ocupado}
          onPress={() => void anteriores(cursor)}
        >
          {ocupado ? 'Carregando eventos…' : 'Carregar eventos anteriores'}
        </Button>
      )}
    </>
  );
}
