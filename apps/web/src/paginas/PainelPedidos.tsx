import type { ListaPedidos, ResultadoImportacao, ResumoPedido } from '@gia/contratos';
import type { StatusPedido } from '@gia/dominio';
import { useMemo, useState } from 'react';
import { Button, Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import { Link } from 'react-router';
import { useApi } from '../api/ApiProvider.js';
import { useCarregar, type EstadoCarga } from '../api/useCarregar.js';
import { DialogoConfirmacao } from '../componentes/DialogoConfirmacao.js';
import { ErroCarga } from '../componentes/ErroCarga.js';
import { IconeBusca, IconeCaixaEntrada } from '../componentes/Icones.js';
import { SeloStatus, tomDoStatusPedido } from '../componentes/SeloStatus.js';
import { podeFazer } from '../permissoes.js';
import {
  ROTULO_STATUS_PEDIDO,
  ROTULO_VINCULO,
  STATUS_PEDIDO_ORDEM,
  formatarInstante,
} from '../rotulos.js';
import { useSessao } from '../sessao/Sessao.js';

export const TAMANHO_PAGINA = 25;

function filtrar(
  pedidos: readonly ResumoPedido[],
  status: StatusPedido | '',
  busca: string,
): ResumoPedido[] {
  const termo = busca.trim().toLowerCase();
  return pedidos.filter(
    (pedido) =>
      (status === '' || pedido.status === status) &&
      (termo === '' ||
        pedido.nomeColaborador.toLowerCase().includes(termo) ||
        pedido.idExterno.toLowerCase().includes(termo)),
  );
}

function ResumoImportacao({ resultado }: { resultado: ResultadoImportacao }) {
  return (
    <section
      className={resultado.recusados.length > 0 ? 'alert alert-warning' : 'alert alert-info'}
      aria-labelledby="titulo-importacao"
    >
      <h2 id="titulo-importacao">Resultado da importação do Jira</h2>
      <p role="status">
        {resultado.criados.length} criado(s), {resultado.duplicados.length} já importado(s),{' '}
        {resultado.ignorados.length} ignorado(s) por não serem de onboarding e{' '}
        {resultado.recusados.length} recusado(s).
      </p>
      {resultado.recusados.length > 0 && (
        <ul className="lista-simples">
          {resultado.recusados.map((recusado, indice) => (
            <li key={`${recusado.chave ?? 'sem-chave'}-${indice}`}>
              <strong>{recusado.chave ?? 'Chamado sem chave'}:</strong> {recusado.mensagem}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Esqueleto() {
  return (
    <div className="esqueleto" aria-hidden="true">
      <span className="esqueleto-linha" />
      <span className="esqueleto-linha" />
      <span className="esqueleto-linha curta" />
    </div>
  );
}

/** Cor do pino de cada ficha da faixa de métricas, como os accent-* do GIA antigo. */
const COR_DO_STATUS: Readonly<Record<StatusPedido, string>> = {
  pendenteAprovacao: 'tab-amarelo',
  aprovado: 'tab-azul',
  emExecucao: 'tab-lilas',
  concluidoComErros: 'tab-vermelho',
  concluido: 'tab-verde',
  rejeitado: 'tab-cinza',
};

/** Faixa de métricas do GIA antigo: uma ficha por status, número sobre o rótulo. */
function Totais({ pedidos }: { pedidos: readonly ResumoPedido[] }) {
  return (
    <ul className="stat-grid" aria-label="Totais por status">
      {STATUS_PEDIDO_ORDEM.map((s) => (
        <li key={s} className={`stat-card ${COR_DO_STATUS[s]}`}>
          <span className="stat-value">{pedidos.filter((p) => p.status === s).length}</span>{' '}
          {ROTULO_STATUS_PEDIDO[s]}
        </li>
      ))}
    </ul>
  );
}

function PainelOnboarding({
  estado,
  recarregar,
  pode,
}: {
  estado: EstadoCarga<ListaPedidos>;
  recarregar: () => void;
  pode: boolean;
}) {
  const [status, setStatus] = useState<StatusPedido | ''>('');
  const [busca, setBusca] = useState('');
  const [pagina, setPagina] = useState(0);

  const pedidos = useMemo(() => (estado.situacao === 'ok' ? estado.dados.pedidos : []), [estado]);
  const filtrados = useMemo(() => filtrar(pedidos, status, busca), [pedidos, status, busca]);
  const totalPaginas = Math.max(1, Math.ceil(filtrados.length / TAMANHO_PAGINA));
  const paginaAtual = Math.min(pagina, totalPaginas - 1);
  const visiveis = filtrados.slice(
    paginaAtual * TAMANHO_PAGINA,
    (paginaAtual + 1) * TAMANHO_PAGINA,
  );

  return (
    <section className="pasta" aria-labelledby="titulo-fila">
      <div className="pasta-topo">
        <h2 id="titulo-fila" className="pasta-tab tab-lilas">
          Chamados na fila
        </h2>
        <div className="filtros">
          <label className="campo-busca">
            <span className="so-leitor">Buscar por nome ou chamado</span>
            <IconeBusca />
            <input
              className="form-control"
              type="search"
              placeholder="Buscar colaborador ou chamado..."
              value={busca}
              onChange={(e) => {
                setBusca(e.target.value);
                setPagina(0);
              }}
            />
          </label>
          <label className="campo-estado">
            <span className="so-leitor">Status</span>
            <select
              className="form-select"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as StatusPedido | '');
                setPagina(0);
              }}
            >
              <option value="">Todos os estados</option>
              {STATUS_PEDIDO_ORDEM.map((s) => (
                <option key={s} value={s}>
                  {ROTULO_STATUS_PEDIDO[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="pasta-corpo">
        {estado.situacao === 'carregando' && (
          <div className="estado estado-carregando">
            <p role="status">Carregando pedidos…</p>
            <Esqueleto />
          </div>
        )}
        {estado.situacao === 'erro' && <ErroCarga erro={estado.erro} onTentarDeNovo={recarregar} />}
        {estado.situacao === 'ok' &&
          (pedidos.length === 0 ? (
            <div className="estado">
              <span className="empty-state-icon" aria-hidden="true">
                <IconeCaixaEntrada />
              </span>
              <p>
                Nenhum pedido de onboarding ainda.{' '}
                {pode && 'Importe os chamados do Jira para começar.'}
              </p>
            </div>
          ) : filtrados.length === 0 ? (
            <p className="estado">Nenhum pedido corresponde aos filtros.</p>
          ) : (
            <>
              <div className="table-responsive tabela-responsiva">
                <table className="table">
                  <caption className="so-leitor">Pedidos de onboarding</caption>
                  <thead>
                    <tr>
                      <th scope="col">Chamado</th>
                      <th scope="col">Colaborador</th>
                      <th scope="col">Status</th>
                      <th scope="col">Atualizado em</th>
                      <th scope="col">
                        <span className="so-leitor">Ações</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visiveis.map((pedido) => (
                      <tr key={pedido.id}>
                        <td data-label="Chamado">
                          <Link className="chamado" to={`/pedidos/${pedido.id}`}>
                            <code>{pedido.idExterno}</code>
                          </Link>
                        </td>
                        <td data-label="Colaborador">
                          <div className="colaborador-nome">{pedido.nomeColaborador}</div>
                          <div className="colaborador-sub">
                            {ROTULO_VINCULO[pedido.tipoVinculo]}
                          </div>
                        </td>
                        <td data-label="Status">
                          <SeloStatus
                            rotulo={ROTULO_STATUS_PEDIDO[pedido.status]}
                            tom={tomDoStatusPedido(pedido.status)}
                          />
                        </td>
                        <td data-label="Atualizado em" className="celula-data">
                          {formatarInstante(pedido.atualizadoEm)}
                        </td>
                        <td data-label="" className="text-end">
                          <Link
                            className="btn btn-sm btn-outline-primary"
                            to={`/pedidos/${pedido.id}`}
                          >
                            Analisar<span className="so-leitor"> pedido {pedido.idExterno}</span>
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <nav className="paginacao" aria-label="Paginação">
                <Button
                  className="btn btn-sm btn-outline-secondary"
                  isDisabled={paginaAtual === 0}
                  onPress={() => setPagina(paginaAtual - 1)}
                >
                  Anterior
                </Button>
                <span>
                  Página {paginaAtual + 1} de {totalPaginas} ({filtrados.length} pedido(s))
                </span>
                <Button
                  className="btn btn-sm btn-outline-secondary"
                  isDisabled={paginaAtual >= totalPaginas - 1}
                  onPress={() => setPagina(paginaAtual + 1)}
                >
                  Próxima
                </Button>
              </nav>
            </>
          ))}
      </div>
    </section>
  );
}

export function PainelPedidos() {
  const api = useApi();
  const { perfil } = useSessao();
  const { estado, recarregar } = useCarregar<ListaPedidos>(() => api.listarPedidos());
  const [aba, setAba] = useState<string>('onboarding');
  const [confirmando, setConfirmando] = useState(false);
  const [importacao, setImportacao] = useState<ResultadoImportacao | null>(null);
  const pode = podeFazer(perfil, 'criarPedido');

  async function importar() {
    setImportacao(await api.importarDoJira());
    setConfirmando(false);
    recarregar();
  }

  return (
    <>
      <header className="workspace-heading">
        <div>
          <span className="workspace-kicker">
            <IconeCaixaEntrada /> Entrada de trabalho
          </span>
          <h1 className="h3">Painel de chamados</h1>
          <p className="text-muted">Acompanhamento e aprovação de pedidos de acesso</p>
        </div>
        {aba === 'onboarding' && (
          <div className="workspace-acoes">
            {pode ? (
              <Button className="btn btn-primary" onPress={() => setConfirmando(true)}>
                Importar do Jira
              </Button>
            ) : (
              <p className="texto-suave">Seu perfil não importa chamados do Jira.</p>
            )}
          </div>
        )}
      </header>
      <DialogoConfirmacao
        aberto={confirmando}
        titulo="Importar chamados do Jira?"
        descricao="Serão lidos os chamados de onboarding (celetista e terceiro) e criados pedidos pendentes de aprovação. Nenhum acesso é criado nos sistemas de destino. Chamados já importados não são duplicados."
        confirmarRotulo="Importar"
        onConfirmar={importar}
        onFechar={() => setConfirmando(false)}
      />
      {aba === 'onboarding' && estado.situacao === 'ok' && (
        <Totais pedidos={estado.dados.pedidos} />
      )}
      {importacao && <ResumoImportacao resultado={importacao} />}
      <Tabs selectedKey={aba} onSelectionChange={(chave) => setAba(String(chave))}>
        <TabList aria-label="Tipo de chamado" className="abas-painel">
          <Tab id="onboarding" className="aba-painel">
            Onboarding
          </Tab>
          <Tab id="offboarding" className="aba-painel">
            Offboarding
          </Tab>
        </TabList>
        <TabPanel id="onboarding">
          <PainelOnboarding estado={estado} recarregar={recarregar} pode={pode} />
        </TabPanel>
        <TabPanel id="offboarding">
          <section className="pasta" aria-labelledby="titulo-offboarding">
            <div className="pasta-topo">
              <h2 id="titulo-offboarding" className="pasta-tab tab-cinza">
                Desligamentos
              </h2>
            </div>
            <div className="pasta-corpo">
              <p className="estado">
                O offboarding está em standby: fica previsto na estrutura, mas não será implementado
                agora.
              </p>
            </div>
          </section>
        </TabPanel>
      </Tabs>
    </>
  );
}
