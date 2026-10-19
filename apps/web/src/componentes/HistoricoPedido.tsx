import type { HistoricoPedido as Historico } from '@gia/contratos';
import { useEffect, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import { useApi } from '../api/ApiProvider.js';
import { ErroApi } from '../api/cliente.js';
import { useCarregar } from '../api/useCarregar.js';
import { nomeSistema } from '../rotulos.js';
import { ErroCarga } from './ErroCarga.js';
import {
  LinhaDoTempo,
  type CorEvento,
  type EventoLinha,
  type Par,
  type TomEvento,
} from './LinhaDoTempoPedido.js';

interface Tipo {
  readonly titulo: string;
  readonly categoria: string;
  readonly cor: CorEvento;
  readonly estado: string;
  readonly tom: TomEvento;
}

const tipo = (
  titulo: string,
  categoria: string,
  cor: CorEvento,
  estado: string,
  tom: TomEvento,
): Tipo => ({ titulo, categoria, cor, estado, tom });

/** Como cada tipo de evento persistido aparece: título, categoria, cor e estado. */
const TIPOS: Readonly<Record<string, Tipo>> = {
  pedidoRecebido: tipo('Pedido recebido', 'Pedido', 'azul', 'Registrado', 'neutro'),
  statusPedidoAlterado: tipo('Status do pedido alterado', 'Pedido', 'azul', 'Alterado', 'info'),
  colaboradorCriado: tipo('Colaborador criado', 'Colaborador', 'ciano', 'Criado', 'ok'),
  colaboradorIdentidadeAtualizada: tipo(
    'Identidade do colaborador atualizada',
    'Colaborador',
    'ciano',
    'Atualizado',
    'info',
  ),
  colaboradorStatusAlterado: tipo(
    'Status do colaborador alterado',
    'Colaborador',
    'ciano',
    'Alterado',
    'info',
  ),
  propostaEditada: tipo('Proposta editada', 'Proposta', 'lilas', 'Editada', 'info'),
  identidadeVerificada: tipo('Identidade verificada', 'Proposta', 'lilas', 'Verificada', 'ok'),
  pedidoAprovado: tipo('Pedido aprovado', 'Decisão', 'lilas', 'Aprovado', 'ok'),
  pedidoRejeitado: tipo('Pedido rejeitado', 'Decisão', 'lilas', 'Rejeitado', 'perigo'),
  pedidoReaberto: tipo('Pedido reaberto', 'Decisão', 'lilas', 'Reaberto', 'aviso'),
  execucaoSolicitada: tipo('Execução solicitada', 'Execução', 'laranja', 'Solicitada', 'info'),
  simulacaoSolicitada: tipo('Simulação solicitada', 'Execução', 'laranja', 'Solicitada', 'info'),
  operacaoReservada: tipo('Operação reservada', 'Operação', 'laranja', 'Reservada', 'info'),
  operacaoResultadoRegistrado: tipo(
    'Resultado da operação registrado',
    'Operação',
    'laranja',
    'Registrado',
    'neutro',
  ),
  operacaoReagendada: tipo('Operação reagendada', 'Operação', 'laranja', 'Reagendada', 'aviso'),
  operacaoEncaminhadaParaReconciliacao: tipo(
    'Operação encaminhada para reconciliação',
    'Operação',
    'laranja',
    'Em reconciliação',
    'aviso',
  ),
  acessoManualRegistrado: tipo('Acesso manual registrado', 'Acesso', 'verde', 'Registrado', 'info'),
  acessoManualComprovado: tipo('Acesso manual comprovado', 'Acesso', 'verde', 'Comprovado', 'ok'),
  itemReconciliado: tipo('Item reconciliado', 'Acesso', 'verde', 'Reconciliado', 'ok'),
  configuracaoAlterada: tipo(
    'Configuração alterada',
    'Configuração',
    'cinza',
    'Alterada',
    'neutro',
  ),
  liberacaoEscritaAlterada: tipo(
    'Liberação de escrita alterada',
    'Configuração',
    'cinza',
    'Alterada',
    'aviso',
  ),
  estadoInicialSincronizado: tipo(
    'Estado inicial sincronizado',
    'Sincronização',
    'ciano',
    'Sincronizado',
    'neutro',
  ),
  alteracaoDetectadaNaSincronizacao: tipo(
    'Alteração detectada na sincronização',
    'Sincronização',
    'ciano',
    'Detectada',
    'aviso',
  ),
  correcaoRegistrada: tipo('Correção registrada', 'Correção', 'amarelo', 'Registrada', 'aviso'),
  documentoEmitido: tipo('Documento emitido', 'Documento', 'azul', 'Emitido', 'ok'),
};

const TIPO_DESCONHECIDO = tipo('Evento registrado', 'Evento', 'cinza', 'Registrado', 'neutro');

const ROTULO_ORIGEM: Readonly<Record<Historico['eventos'][number]['origem'], string>> = {
  gia: 'GIA',
  sincronizacaoAd: 'Sincronização AD',
  sincronizacaoM365: 'Sincronização Microsoft 365',
};

function paraLinha(evento: Historico['eventos'][number]): EventoLinha {
  const { titulo, categoria, cor, estado, tom } = TIPOS[evento.tipo] ?? TIPO_DESCONHECIDO;
  const detalhes: Par[] = [
    ['Evento', evento.id],
    ['Origem', ROTULO_ORIGEM[evento.origem]],
  ];
  if (evento.operacaoId) detalhes.push(['Operação', evento.operacaoId]);
  if (evento.correlacaoId) detalhes.push(['Correlação', evento.correlacaoId]);
  if (evento.corrigeEventoId) detalhes.push(['Corrige o evento', evento.corrigeEventoId]);
  return {
    id: evento.id,
    instante: evento.instante,
    categoria,
    cor,
    estado,
    tom,
    titulo,
    ator: evento.ator?.nome ?? 'Sincronização externa',
    contexto: evento.sistema ? [['Sistema', nomeSistema(evento.sistema)]] : [],
    detalhes,
  };
}

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

  if (estado.situacao === 'carregando')
    return (
      <div className="estado estado-carregando">
        <p role="status">Carregando histórico…</p>
        <div className="esqueleto" aria-hidden="true">
          <span className="esqueleto-linha" />
          <span className="esqueleto-linha" />
          <span className="esqueleto-linha curta" />
        </div>
      </div>
    );
  if (estado.situacao === 'erro')
    return <ErroCarga erro={estado.erro} onTentarDeNovo={atualizar} />;
  if (erro?.status === 401 || erro?.status === 403)
    return <ErroCarga erro={erro} onTentarDeNovo={atualizar} />;
  const todas = [estado.dados, ...paginas];
  const cursor = todas.at(-1)!.proximoCursor;
  const eventos = [...new Map(todas.flatMap((p) => p.eventos).map((e) => [e.id, e])).values()];
  return (
    <>
      <div className="lt-barra">
        <span className="lt-total">
          {eventos.length === 1 ? '1 evento carregado' : `${eventos.length} eventos carregados`}
        </span>
        <Button
          className="btn btn-sm btn-outline-secondary"
          onPress={atualizar}
          isDisabled={ocupado}
        >
          Atualizar histórico
        </Button>
      </div>
      {erro && (
        <p role="alert" className="alert alert-danger lt-aviso">
          Não foi possível carregar os eventos anteriores. Tente novamente.
        </p>
      )}
      {eventos.length === 0 ? (
        <p className="estado">Nenhum evento registrado para este pedido.</p>
      ) : (
        <LinhaDoTempo eventos={eventos.map(paraLinha)} rotulo="Histórico persistido do pedido" />
      )}
      {cursor && (
        <div className="lt-rodape">
          <Button
            className="btn btn-outline-primary"
            isDisabled={ocupado}
            onPress={() => void anteriores(cursor)}
          >
            {ocupado ? 'Carregando eventos…' : 'Carregar eventos anteriores'}
          </Button>
        </div>
      )}
    </>
  );
}
