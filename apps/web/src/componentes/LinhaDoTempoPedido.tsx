import type { PedidoDetalhe } from '@gia/contratos';
import { Fragment } from 'react';
import { ROTULO_VINCULO, formatarInstante, nomeSistema } from '../rotulos.js';

type Tom = 'neutro' | 'ok';

interface Evento {
  readonly id: string;
  readonly instante: string;
  readonly tipo: string;
  readonly cor: 'azul' | 'verde';
  readonly estado: string;
  readonly tom: Tom;
  readonly titulo: string;
  readonly ator: string | null;
  readonly chips: readonly (readonly [string, string])[];
}

/**
 * Eventos do pedido derivados só do que a API já devolve (criação, aprovação da revisão e
 * confirmação por sistema). Não há log de auditoria na API: nada aqui é inventado.
 */
export function eventosDoPedido(detalhe: PedidoDetalhe): Evento[] {
  const eventos: Evento[] = [
    {
      id: 'criado',
      instante: detalhe.criadoEm,
      tipo: 'Pedido',
      cor: 'azul',
      estado: 'Registrado',
      tom: 'neutro',
      titulo: `Pedido criado a partir do chamado ${detalhe.origem.idExterno}.`,
      ator: 'Jira',
      chips: [
        ['chamado', detalhe.origem.idExterno],
        ['vínculo', ROTULO_VINCULO[detalhe.tipoVinculo]],
      ],
    },
  ];
  const { revisao } = detalhe;
  if (revisao.aprovadaEm) {
    eventos.push({
      id: 'revisao-aprovada',
      instante: revisao.aprovadaEm,
      tipo: 'Decisão',
      cor: 'azul',
      estado: 'Decidido',
      tom: 'ok',
      titulo: `Revisão ${revisao.numero} aprovada para execução.`,
      ator: revisao.aprovadaPor?.nome ?? null,
      chips: [['regras', revisao.versaoRegras]],
    });
  }
  for (const item of detalhe.itens) {
    if (!item.confirmadoEm) continue;
    const manual = item.status === 'registradoManual';
    eventos.push({
      id: `item-${item.id}`,
      instante: item.confirmadoEm,
      tipo: 'Acesso',
      cor: 'verde',
      estado: 'Sucesso',
      tom: 'ok',
      titulo: manual
        ? `Acesso em ${nomeSistema(item.sistema)} registrado manualmente.`
        : `Acesso em ${nomeSistema(item.sistema)} confirmado no destino.`,
      ator: null,
      chips: [['sistema', nomeSistema(item.sistema)]],
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
function ordenarDoMaisRecente(eventos: Evento[]): Evento[] {
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

/** Timeline do draft "Detalhe da solicitação de acesso": ponto, cartão com tipo, estado e hora. */
export function LinhaDoTempoPedido({ detalhe }: { detalhe: PedidoDetalhe }) {
  const eventos = eventosDoPedido(detalhe);
  const agora = new Date();
  return (
    <ol className="tl">
      {eventos.map((evento, indice) => {
        const dia = rotuloDoDia(evento.instante, agora);
        const novoDia = indice === 0 || rotuloDoDia(eventos[indice - 1]!.instante, agora) !== dia;
        return (
          <Fragment key={evento.id}>
            {novoDia && <li className="tl-dia">{dia}</li>}
            <li className="tl-item">
              <span className={`tl-ponto ${evento.tom}`} aria-hidden="true" />
              <div className="tl-cartao">
                <div className="tl-linha">
                  <span className={`tl-tipo ${evento.cor}`}>{evento.tipo}</span>
                  <span className={`tl-estado ${evento.tom}`}>{evento.estado}</span>
                  <time dateTime={evento.instante}>{formatarInstante(evento.instante)}</time>
                  {evento.ator && <span className="tl-ator">{evento.ator}</span>}
                </div>
                <p className="tl-titulo">{evento.titulo}</p>
                <div className="tl-chips">
                  {evento.chips.map(([rotulo, valor]) => (
                    <span key={rotulo} className="tl-chip">
                      <span>{rotulo}</span>
                      {valor}
                    </span>
                  ))}
                </div>
              </div>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
