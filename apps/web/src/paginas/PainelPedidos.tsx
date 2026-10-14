import type { ListaPedidos, ResultadoImportacao, ResumoPedido } from '@gia/contratos';
import type { StatusPedido } from '@gia/dominio';
import { useMemo, useState } from 'react';
import { Button, Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import { Link } from 'react-router';
import { useApi } from '../api/ApiProvider.js';
import { useCarregar } from '../api/useCarregar.js';
import { DialogoConfirmacao } from '../componentes/DialogoConfirmacao.js';
import { ErroCarga } from '../componentes/ErroCarga.js';
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
    <section className="cartao" aria-labelledby="titulo-importacao">
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

function PainelOnboarding() {
  const api = useApi();
  const { perfil } = useSessao();
  const { estado, recarregar } = useCarregar<ListaPedidos>(() => api.listarPedidos());
  const [status, setStatus] = useState<StatusPedido | ''>('');
  const [busca, setBusca] = useState('');
  const [pagina, setPagina] = useState(0);
  const [confirmando, setConfirmando] = useState(false);
  const [importacao, setImportacao] = useState<ResultadoImportacao | null>(null);

  const pedidos = useMemo(() => (estado.situacao === 'ok' ? estado.dados.pedidos : []), [estado]);
  const filtrados = useMemo(() => filtrar(pedidos, status, busca), [pedidos, status, busca]);
  const totalPaginas = Math.max(1, Math.ceil(filtrados.length / TAMANHO_PAGINA));
  const paginaAtual = Math.min(pagina, totalPaginas - 1);
  const visiveis = filtrados.slice(
    paginaAtual * TAMANHO_PAGINA,
    (paginaAtual + 1) * TAMANHO_PAGINA,
  );
  const pode = podeFazer(perfil, 'criarPedido');

  async function importar() {
    setImportacao(await api.importarDoJira());
    setConfirmando(false);
    recarregar();
  }

  return (
    <>
      <div className="barra-acoes">
        {pode ? (
          <Button className="botao-primario" onPress={() => setConfirmando(true)}>
            Importar do Jira
          </Button>
        ) : (
          <p className="texto-suave">Seu perfil não importa chamados do Jira.</p>
        )}
      </div>
      <DialogoConfirmacao
        aberto={confirmando}
        titulo="Importar chamados do Jira?"
        descricao="Serão lidos os chamados de onboarding (celetista e terceiro) e criados pedidos pendentes de aprovação. Nenhum acesso é criado nos sistemas de destino. Chamados já importados não são duplicados."
        confirmarRotulo="Importar"
        onConfirmar={importar}
        onFechar={() => setConfirmando(false)}
      />
      {importacao && <ResumoImportacao resultado={importacao} />}

      {estado.situacao === 'carregando' && (
        <p role="status" className="estado">
          Carregando pedidos…
        </p>
      )}
      {estado.situacao === 'erro' && <ErroCarga erro={estado.erro} onTentarDeNovo={recarregar} />}
      {estado.situacao === 'ok' && (
        <>
          <ul className="totais" aria-label="Totais por status">
            {STATUS_PEDIDO_ORDEM.map((s) => (
              <li key={s}>
                <span className="totais-numero">
                  {pedidos.filter((p) => p.status === s).length}
                </span>{' '}
                {ROTULO_STATUS_PEDIDO[s]}
              </li>
            ))}
          </ul>

          {pedidos.length === 0 ? (
            <p className="estado">
              Nenhum pedido de onboarding ainda.{' '}
              {pode && 'Importe os chamados do Jira para começar.'}
            </p>
          ) : (
            <>
              <div className="filtros">
                <label>
                  Buscar por nome ou chamado
                  <input
                    type="search"
                    value={busca}
                    onChange={(e) => {
                      setBusca(e.target.value);
                      setPagina(0);
                    }}
                  />
                </label>
                <label>
                  Status
                  <select
                    value={status}
                    onChange={(e) => {
                      setStatus(e.target.value as StatusPedido | '');
                      setPagina(0);
                    }}
                  >
                    <option value="">Todos</option>
                    {STATUS_PEDIDO_ORDEM.map((s) => (
                      <option key={s} value={s}>
                        {ROTULO_STATUS_PEDIDO[s]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {filtrados.length === 0 ? (
                <p className="estado">Nenhum pedido corresponde aos filtros.</p>
              ) : (
                <>
                  <table className="tabela">
                    <caption className="so-leitor">Pedidos de onboarding</caption>
                    <thead>
                      <tr>
                        <th scope="col">Chamado</th>
                        <th scope="col">Colaborador</th>
                        <th scope="col">Vínculo</th>
                        <th scope="col">Status</th>
                        <th scope="col">Atualizado em</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visiveis.map((pedido) => (
                        <tr key={pedido.id}>
                          <td>
                            <Link to={`/pedidos/${pedido.id}`}>{pedido.idExterno}</Link>
                          </td>
                          <td>{pedido.nomeColaborador}</td>
                          <td>{ROTULO_VINCULO[pedido.tipoVinculo]}</td>
                          <td>
                            <SeloStatus
                              rotulo={ROTULO_STATUS_PEDIDO[pedido.status]}
                              tom={tomDoStatusPedido(pedido.status)}
                            />
                          </td>
                          <td>{formatarInstante(pedido.atualizadoEm)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <nav className="paginacao" aria-label="Paginação">
                    <Button
                      className="botao-secundario"
                      isDisabled={paginaAtual === 0}
                      onPress={() => setPagina(paginaAtual - 1)}
                    >
                      Anterior
                    </Button>
                    <span>
                      Página {paginaAtual + 1} de {totalPaginas} ({filtrados.length} pedido(s))
                    </span>
                    <Button
                      className="botao-secundario"
                      isDisabled={paginaAtual >= totalPaginas - 1}
                      onPress={() => setPagina(paginaAtual + 1)}
                    >
                      Próxima
                    </Button>
                  </nav>
                </>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

export function PainelPedidos() {
  return (
    <>
      <h1>Painel de chamados</h1>
      <Tabs>
        <TabList aria-label="Tipo de chamado" className="abas">
          <Tab id="onboarding" className="aba">
            Onboarding
          </Tab>
          <Tab id="offboarding" className="aba">
            Offboarding
          </Tab>
        </TabList>
        <TabPanel id="onboarding">
          <PainelOnboarding />
        </TabPanel>
        <TabPanel id="offboarding">
          <p className="estado">
            O offboarding está em standby: fica previsto na estrutura, mas não será implementado
            agora.
          </p>
        </TabPanel>
      </Tabs>
    </>
  );
}
