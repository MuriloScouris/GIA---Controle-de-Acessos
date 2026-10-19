import type { PedidoDetalhe } from '@gia/contratos';
import { Fragment } from 'react';
import { ROTULO_VINCULO, formatarInstante, nomeSistema } from '../rotulos.js';

/** Estado do evento: define a cor do selo e o destaque lateral do cartão. */
export type TomEvento = 'neutro' | 'ok' | 'info' | 'aviso' | 'perigo';

export type CorEvento = 'lilas' | 'azul' | 'verde' | 'laranja' | 'amarelo' | 'ciano' | 'cinza';

const CLASSE_DA_COR: Readonly<Record<CorEvento, string>> = {
  lilas: 'tab-lilas',
  azul: 'tab-azul',
  verde: 'tab-verde',
  laranja: 'tab-laranja',
  amarelo: 'tab-amarelo',
  ciano: 'tab-ciano',
  cinza: 'tab-cinza',
};

const CLASSE_DO_SELO: Readonly<Record<TomEvento, string>> = {
  neutro: 'neutral',
  ok: 'ok',
  info: 'info',
  aviso: 'warn',
  perigo: 'danger',
};

/** Par rótulo/valor exibido sob o evento. */
export type Par = readonly [rotulo: string, valor: string];

/** Evento já normalizado para exibição, venha ele do detalhe do pedido ou do histórico persistido. */
export interface EventoLinha {
  readonly id: string;
  readonly instante: string;
  /** Categoria do evento (Pedido, Decisão, Acesso…), mostrada como etiqueta colorida. */
  readonly categoria: string;
  readonly cor: CorEvento;
  /** Estado do evento (Registrado, Rejeitado, Sucesso…), mostrado como selo. */
  readonly estado: string;
  readonly tom: TomEvento;
  readonly titulo: string;
  readonly ator: string | null;
  /** Contexto de negócio (chamado, sistema…), junto do ator. */
  readonly contexto: readonly Par[];
  /** Identificadores técnicos (evento, operação, correlação…), recolhidos por padrão. */
  readonly detalhes: readonly Par[];
}

/**
 * Eventos do pedido derivados só do que a API já devolve (criação, aprovação da revisão e
 * confirmação por sistema). Não há log de auditoria na API: nada aqui é inventado.
 */
export function eventosDoPedido(detalhe: PedidoDetalhe): EventoLinha[] {
  const eventos: EventoLinha[] = [
    {
      id: 'criado',
      instante: detalhe.criadoEm,
      categoria: 'Pedido',
      cor: 'azul',
      estado: 'Registrado',
      tom: 'neutro',
      titulo: `Pedido criado a partir do chamado ${detalhe.origem.idExterno}.`,
      ator: 'Jira',
      contexto: [
        ['Chamado', detalhe.origem.idExterno],
        ['Vínculo', ROTULO_VINCULO[detalhe.tipoVinculo]],
      ],
      detalhes: [],
    },
  ];
  const { revisao } = detalhe;
  if (revisao.aprovadaEm) {
    eventos.push({
      id: 'revisao-aprovada',
      instante: revisao.aprovadaEm,
      categoria: 'Decisão',
      cor: 'lilas',
      estado: 'Decidido',
      tom: 'ok',
      titulo: `Revisão ${revisao.numero} aprovada para execução.`,
      ator: revisao.aprovadaPor?.nome ?? null,
      contexto: [['Regras', revisao.versaoRegras]],
      detalhes: [],
    });
  }
  for (const item of detalhe.itens) {
    if (!item.confirmadoEm) continue;
    const manual = item.status === 'registradoManual';
    eventos.push({
      id: `item-${item.id}`,
      instante: item.confirmadoEm,
      categoria: 'Acesso',
      cor: 'verde',
      estado: 'Sucesso',
      tom: 'ok',
      titulo: manual
        ? `Acesso em ${nomeSistema(item.sistema)} registrado manualmente.`
        : `Acesso em ${nomeSistema(item.sistema)} confirmado no destino.`,
      ator: null,
      contexto: [['Sistema', nomeSistema(item.sistema)]],
      detalhes: [],
    });
  }
  return ordenarDoMaisRecente(eventos);
}

/** Epoch em ms do instante ou `null` se não for uma data reconhecível. */
function epochDe(instante: string): number | null {
  const epoch = Date.parse(instante);
  return Number.isNaN(epoch) ? null : epoch;
}

/**
 * Mais recente primeiro, comparando o instante real (epoch) e não o texto: `…:00Z` e `…:00.500Z`
 * ou offsets diferentes não ordenam bem como string. Instantes inválidos vão ao final; empates
 * (e inválidos entre si) mantêm a ordem de inserção, já que `Array.prototype.sort` é estável.
 */
function ordenarDoMaisRecente(eventos: EventoLinha[]): EventoLinha[] {
  return eventos
    .map((evento) => ({ evento, epoch: epochDe(evento.instante) }))
    .sort((a, b) => {
      if (a.epoch === null || b.epoch === null) {
        return a.epoch === b.epoch ? 0 : a.epoch === null ? 1 : -1;
      }
      return b.epoch - a.epoch;
    })
    .map(({ evento }) => evento);
}

function rotuloDoDia(instante: string, agora: Date): string {
  const epoch = epochDe(instante);
  if (epoch === null) return 'Data indisponível';
  const data = new Date(epoch);
  const mesmoDia = data.toDateString() === agora.toDateString();
  return mesmoDia
    ? `Hoje, ${data.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' })}`
    : data.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Só a hora: a data já está no cabeçalho do dia. Instante ilegível é mostrado como veio. */
function horaDoEvento(instante: string): string {
  const epoch = epochDe(instante);
  return epoch === null
    ? formatarInstante(instante)
    : new Date(epoch).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Linha do tempo do pedido, agrupada por dia: cada evento mostra categoria e estado no topo, a
 * hora à direita, o que aconteceu em destaque, quem/onde em campos rotulados e os identificadores
 * técnicos recolhidos. Usada tanto pelo histórico persistido quanto pela versão derivada do detalhe.
 */
export function LinhaDoTempo({
  eventos,
  rotulo,
}: {
  eventos: readonly EventoLinha[];
  rotulo?: string;
}) {
  const agora = new Date();
  return (
    <ol className="linha-tempo" aria-label={rotulo}>
      {eventos.map((evento, indice) => {
        const dia = rotuloDoDia(evento.instante, agora);
        const novoDia = indice === 0 || rotuloDoDia(eventos[indice - 1]!.instante, agora) !== dia;
        const meta: readonly Par[] = [
          ...(evento.ator ? ([['Ator', evento.ator]] as const) : []),
          ...evento.contexto,
        ];
        return (
          <Fragment key={evento.id}>
            {novoDia && (
              <li className="lt-dia">
                <span>{dia}</span>
              </li>
            )}
            <li className={`lt-item ${CLASSE_DA_COR[evento.cor]}`}>
              <span className="lt-marco" aria-hidden="true" />
              <div className={`lt-conteudo tom-${evento.tom}`}>
                <div className="lt-cabeca">
                  <span className="lt-tipo">{evento.categoria}</span>
                  <span className={`badge-soft ${CLASSE_DO_SELO[evento.tom]}`}>
                    {evento.estado}
                  </span>
                  <time
                    className="lt-hora"
                    dateTime={evento.instante}
                    title={formatarInstante(evento.instante)}
                  >
                    {horaDoEvento(evento.instante)}
                  </time>
                </div>
                <p className="lt-descricao">{evento.titulo}</p>
                {meta.length > 0 && (
                  <dl className="lt-meta">
                    {meta.map(([chave, valor]) => (
                      <div key={chave} className="lt-meta-item">
                        <dt>{chave}</dt>
                        <dd>{valor}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {evento.detalhes.length > 0 && (
                  <details className="lt-detalhes">
                    <summary>Detalhes técnicos</summary>
                    <dl>
                      {evento.detalhes.map(([chave, valor]) => (
                        <div key={chave} className="lt-detalhe-linha">
                          <dt>{chave}</dt>
                          <dd>{valor}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                )}
              </div>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

/** Timeline do draft "Detalhe da solicitação de acesso", derivada do detalhe do pedido. */
export function LinhaDoTempoPedido({ detalhe }: { detalhe: PedidoDetalhe }) {
  return <LinhaDoTempo eventos={eventosDoPedido(detalhe)} />;
}
