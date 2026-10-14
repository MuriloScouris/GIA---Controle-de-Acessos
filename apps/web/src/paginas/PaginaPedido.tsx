import type { PedidoDetalhe, ResultadoItem } from '@gia/contratos';
import type { AcaoFuncional, Sistema } from '@gia/dominio';
import { useState, type ReactNode } from 'react';
import { Button } from 'react-aria-components';
import { Link, useParams } from 'react-router';
import { useApi } from '../api/ApiProvider.js';
import { ErroApi, type ComandoDoPedido } from '../api/cliente.js';
import { useCarregar } from '../api/useCarregar.js';
import { DialogoConfirmacao } from '../componentes/DialogoConfirmacao.js';
import { ErroCarga } from '../componentes/ErroCarga.js';
import { IconeChaveQuadrada } from '../componentes/Icones.js';
import { LinhaDoTempoPedido } from '../componentes/LinhaDoTempoPedido.js';
import { SeloStatus, tomDoStatusItem, tomDoStatusPedido } from '../componentes/SeloStatus.js';
import { podeFazer } from '../permissoes.js';
import {
  ROTULO_ACAO_OPERACAO,
  ROTULO_EFEITO,
  ROTULO_ORIGEM_IDENTIDADE,
  ROTULO_SITUACAO_IDENTIDADE,
  ROTULO_STATUS_ITEM,
  ROTULO_STATUS_OPERACAO,
  ROTULO_STATUS_PEDIDO,
  ROTULO_VINCULO,
  formatarInstante,
  nomeSistema,
} from '../rotulos.js';
import { useSessao } from '../sessao/Sessao.js';

/** Itens que o domínio aceita executar de novo: pendente, falhou ou parcial. */
const STATUS_ITEM_EXECUTAVEL = ['pendente', 'falhou', 'parcial'];
const STATUS_PEDIDO_EXECUTAVEL = ['aprovado', 'concluidoComErros'];
/** Operação que ainda ocupa o item (na fila ou reservada por um worker), real ou simulada. */
const STATUS_OPERACAO_ATIVA = ['pendente', 'reservada'];
const INTERVALO_ATUALIZACAO_MS = 5_000;

function temOperacaoAtiva(item: ResultadoItem): boolean {
  return item.operacoes.some((operacao) => STATUS_OPERACAO_ATIVA.includes(operacao.status));
}

/** Há trabalho em andamento: pedido em execução ou operação ativa em algum item (inclusive simulada). */
function acompanhar(pedido: PedidoDetalhe): boolean {
  return pedido.status === 'emExecucao' || pedido.itens.some(temOperacaoAtiva);
}

type Dialogo =
  | { readonly tipo: 'aprovar' }
  | { readonly tipo: 'rejeitar' }
  | { readonly tipo: 'reabrir' }
  | { readonly tipo: 'recalcular' }
  | { readonly tipo: 'editarIdentidade' }
  | { readonly tipo: 'executarTodos'; readonly itemIds: readonly string[] }
  | { readonly tipo: 'executarItem'; readonly itemId: string; readonly sistema: Sistema }
  | { readonly tipo: 'acessoManual' };

function resumirParametros(parametros: Readonly<Record<string, unknown>>): [string, string][] {
  return Object.entries(parametros)
    .filter(([chave]) => chave !== 'sistema')
    .map(([chave, valor]): [string, string] => {
      if (valor === null || valor === undefined) return [chave, '—'];
      if (Array.isArray(valor)) return [chave, valor.length === 0 ? '—' : valor.join(', ')];
      if (typeof valor === 'object') return [chave, JSON.stringify(valor)];
      return [chave, String(valor)];
    });
}

function Campo({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <div className="campo-leitura">
      <dt>{rotulo}</dt>
      <dd>{children ?? '—'}</dd>
    </div>
  );
}

/** Seção no padrão do draft: faixa de cabeçalho com quadradinho colorido e corpo em papel. */
function Secao({
  id,
  titulo,
  cor,
  extra,
  semPadding = false,
  children,
}: {
  id: string;
  titulo: string;
  cor: 'azul' | 'roxo' | 'vermelho' | 'ciano';
  extra?: string;
  semPadding?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="secao" aria-labelledby={id}>
      <div className="secao-topo">
        <h2 id={id} className={`secao-titulo ${cor}`}>
          {titulo}
        </h2>
        {extra && <span className="secao-extra">{extra}</span>}
      </div>
      <div className={semPadding ? 'secao-corpo sem-padding' : 'secao-corpo'}>{children}</div>
    </section>
  );
}

const ETAPAS_DO_CICLO = [
  { titulo: 'Pedido recebido', texto: 'Chamado importado do Jira.' },
  { titulo: 'Decisão do revisor', texto: 'Aprovação ou rejeição do pedido.' },
  { titulo: 'Execução nos sistemas', texto: 'Provisionamento dos itens de acesso.' },
];

/** Última etapa alcançada do ciclo (0 a 2), derivada do status do pedido. */
function etapaAtual(status: string): number {
  if (status === 'pendenteAprovacao') return 0;
  if (status === 'aprovado' || status === 'rejeitado') return 1;
  return 2;
}

function iniciaisDe(nome: string): string {
  const palavras = nome.split(/\s+/).filter(Boolean);
  if (palavras.length === 0) return '?';
  if (palavras.length === 1) return nome.slice(0, 2).toUpperCase();
  return `${palavras[0]![0]}${palavras[palavras.length - 1]![0]}`.toUpperCase();
}

function ResultadoDoItem({ item }: { item: ResultadoItem }) {
  return (
    <div>
      <SeloStatus rotulo={ROTULO_STATUS_ITEM[item.status]} tom={tomDoStatusItem(item.status)} />
      {item.etapaAlcancada && <p className="texto-suave">Última etapa: {item.etapaAlcancada}</p>}
      {item.mensagem && <p>{item.mensagem}</p>}
      {item.idExterno && <p className="texto-suave">ID no destino: {item.idExterno}</p>}
      {item.confirmadoEm && (
        <p className="texto-suave">Confirmado em {formatarInstante(item.confirmadoEm)}</p>
      )}
      {item.observacaoManual && <p>Registro manual: {item.observacaoManual}</p>}
      {item.status === 'desconhecido' && (
        <p role="note" className="aviso-inline">
          Resultado desconhecido: confira o destino antes de tentar de novo. A interface nunca
          repete uma escrita sozinha.
        </p>
      )}
      {item.operacoes.length > 0 && (
        <ul className="lista-simples" aria-label="Operações do item">
          {item.operacoes.map((operacao) => (
            <li key={operacao.id}>
              {ROTULO_ACAO_OPERACAO[operacao.acao]}: {ROTULO_STATUS_OPERACAO[operacao.status]}
              {operacao.efeito && ` (${ROTULO_EFEITO[operacao.efeito]})`}
              {operacao.modo === 'simulado' && ' — simulado, não confirma acesso real'}
              {operacao.mensagem && ` — ${operacao.mensagem}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Remonta a tela ao trocar de pedido, para nunca mostrar dados do pedido anterior. */
export function PaginaPedido() {
  const { pedidoId = '' } = useParams();
  return <TelaPedido key={pedidoId} pedidoId={pedidoId} />;
}

function TelaPedido({ pedidoId }: { pedidoId: string }) {
  const api = useApi();
  const { perfil } = useSessao();
  const { estado, recarregar, atualizacaoFalhou } = useCarregar<PedidoDetalhe>(
    () => api.detalharPedido(pedidoId),
    { atualizarEnquanto: { intervaloMs: INTERVALO_ATUALIZACAO_MS, quando: acompanhar } },
  );
  const [dialogo, setDialogo] = useState<Dialogo | null>(null);
  /** Versão do pedido vista quando a confirmação foi aberta; é a única que o comando pode enviar. */
  const [versaoVista, setVersaoVista] = useState(0);
  const [conflito, setConflito] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [motivo, setMotivo] = useState('');
  const [observacao, setObservacao] = useState('');
  const [itemManual, setItemManual] = useState('');
  const [identidade, setIdentidade] = useState({ login: '', email: '', nomeExibicao: '' });

  if (estado.situacao === 'carregando') {
    return (
      <div className="estado">
        <p role="status">Carregando pedido…</p>
        <div className="esqueleto" aria-hidden="true">
          <span className="esqueleto-linha" />
          <span className="esqueleto-linha" />
          <span className="esqueleto-linha curta" />
        </div>
      </div>
    );
  }
  if (estado.situacao === 'erro') {
    return (
      <>
        <Link to="/">Voltar ao painel</Link>
        <ErroCarga erro={estado.erro} onTentarDeNovo={recarregar} />
      </>
    );
  }
  const detalhe = estado.dados;
  const permitido = (acao: AcaoFuncional) => podeFazer(perfil, acao);
  const pendente = detalhe.status === 'pendenteAprovacao';
  const executavel = STATUS_PEDIDO_EXECUTAVEL.includes(detalhe.status);
  /** Pendente, falhou ou parcial e sem operação ativa: elegível para executar ou registrar à mão. */
  const itensElegiveis = detalhe.itens.filter(
    (item) => STATUS_ITEM_EXECUTAVEL.includes(item.status) && !temOperacaoAtiva(item),
  );
  const revisao = detalhe.revisao;
  // Se o pedido mudou depois de aberta a confirmação, ela deixa de valer: exige rever e confirmar de novo.
  const obsoleta = dialogo !== null && versaoVista !== detalhe.versao;
  const dialogoAtivo = obsoleta ? null : dialogo;

  function abrir(novo: Dialogo) {
    setMotivo('');
    setObservacao('');
    setItemManual(itensElegiveis[0]?.id ?? '');
    setIdentidade({
      login: revisao.identidade?.login ?? '',
      email: revisao.identidade?.email ?? '',
      nomeExibicao: revisao.identidade?.nomeExibicao ?? '',
    });
    setAviso(null);
    setConflito(null);
    setVersaoVista(detalhe.versao);
    setDialogo(novo);
  }

  /**
   * Envia o comando com a versão vista ao abrir a confirmação. Em conflito de versão, fecha a
   * confirmação, mostra a recusa fora do diálogo e recarrega: a pessoa revê o pedido atual e abre
   * uma nova confirmação, que passa a valer para a versão efetivamente vista.
   */
  async function enviar(comando: ComandoDoPedido) {
    try {
      const resposta = await api.executarComando(detalhe.id, versaoVista, comando);
      setDialogo(null);
      const filas = resposta.operacaoIds?.length ?? (resposta.operacaoId ? 1 : 0);
      setAviso(
        filas > 0
          ? `Execução aceita: ${filas} operação(ões) na fila. O resultado aparece por item, sem recarregar a página.`
          : 'Ação registrada.',
      );
      recarregar();
    } catch (erro) {
      if (erro instanceof ErroApi && erro.codigo === 'CONFLITO_DE_VERSAO') {
        setDialogo(null);
        setConflito(erro.message);
        recarregar();
        return;
      }
      throw erro;
    }
  }

  const textoObrigatorio = (valor: string) => valor.trim() === '';

  return (
    <>
      <nav aria-label="Navegação estrutural" className="det-voltar">
        <Link to="/">← Voltar ao painel</Link>
      </nav>
      <header className="det-cabeca">
        <div>
          <span className="det-eyebrow">
            <IconeChaveQuadrada />
            Pedido de onboarding
          </span>
          <div className="det-codigo">
            <code>{detalhe.id.slice(0, 8)}</code>
            <SeloStatus
              rotulo={ROTULO_STATUS_PEDIDO[detalhe.status]}
              tom={tomDoStatusPedido(detalhe.status)}
            />
          </div>
          <h1 className="det-titulo">
            Pedido {detalhe.origem.idExterno} — {detalhe.dadosRh.nomeCompleto}
          </h1>
          <p className="det-subtitulo">
            {ROTULO_VINCULO[detalhe.tipoVinculo]} · versão {detalhe.versao} · atualizado em{' '}
            {formatarInstante(detalhe.atualizadoEm)}
          </p>
        </div>
        <div className="det-pessoa">
          <span className="det-pessoa-avatar" aria-hidden="true">
            {iniciaisDe(detalhe.dadosRh.nomeCompleto)}
          </span>
          <div className="det-pessoa-info">
            <strong>{detalhe.dadosRh.cargo}</strong>
            <span>{detalhe.dadosRh.area}</span>
          </div>
        </div>
      </header>
      {(conflito !== null || obsoleta) && (
        <p role="alert" className="mensagem-erro">
          {conflito ?? 'O pedido foi alterado enquanto a confirmação estava aberta.'} Revise o
          pedido atualizado e confirme a ação de novo.
        </p>
      )}
      {acompanhar(detalhe) && (
        <p role="status" className="aviso-inline">
          Execução em andamento: o resultado por item é atualizado automaticamente.
        </p>
      )}
      {atualizacaoFalhou && (
        <p role="status" className="aviso-inline">
          Não foi possível atualizar agora; exibindo dados anteriores, que podem estar
          desatualizados.
        </p>
      )}
      {detalhe.status === 'concluidoComErros' && (
        <p role="note" className="aviso-inline">
          Concluído com erros: sucesso parcial não é conclusão. Reprocesse só o que falta ou
          registre o acesso manual.
        </p>
      )}
      {detalhe.motivoRejeicao && <p>Motivo da rejeição: {detalhe.motivoRejeicao}</p>}
      {aviso && (
        <p role="status" className="aviso-sucesso">
          {aviso}
        </p>
      )}

      <div className="det-grade">
        <div className="det-coluna det-col-7">
          <Secao id="titulo-rh" titulo="Dados do RH" cor="azul">
            <dl className="grade-leitura">
              <Campo rotulo="Nome completo">{detalhe.dadosRh.nomeCompleto}</Campo>
              <Campo rotulo="CPF">{detalhe.dadosRh.cpf}</Campo>
              <Campo rotulo="Matrícula">{detalhe.dadosRh.matricula}</Campo>
              <Campo rotulo="E-mail corporativo sugerido">
                {detalhe.dadosRh.emailCorporativoSugerido}
              </Campo>
              <Campo rotulo="Área">{detalhe.dadosRh.area}</Campo>
              <Campo rotulo="Cargo">{detalhe.dadosRh.cargo}</Campo>
              <Campo rotulo="Data de admissão">{detalhe.dadosRh.dataAdmissao}</Campo>
              <Campo rotulo="Gestor">{detalhe.dadosRh.gestor}</Campo>
            </dl>
          </Secao>

          <Secao id="titulo-identidade" titulo="Identidade proposta" cor="azul">
            {revisao.pendenciaIdentidade && (
              <p role="alert" className="aviso-inline">
                Pendência: {revisao.pendenciaIdentidade.mensagem}
              </p>
            )}
            {revisao.identidade ? (
              <dl className="grade-leitura">
                <Campo rotulo="Login">{revisao.identidade.login}</Campo>
                <Campo rotulo="UPN">{revisao.identidade.upn}</Campo>
                <Campo rotulo="E-mail">{revisao.identidade.email}</Campo>
                <Campo rotulo="Nome de exibição">{revisao.identidade.nomeExibicao}</Campo>
                <Campo rotulo="Origem">{ROTULO_ORIGEM_IDENTIDADE[revisao.identidade.origem]}</Campo>
              </dl>
            ) : (
              <p className="estado">Ainda não há identidade proposta.</p>
            )}
            {revisao.verificacaoIdentidade && (
              <>
                <p>
                  Verificação nos diretórios:{' '}
                  <strong>
                    {ROTULO_SITUACAO_IDENTIDADE[revisao.verificacaoIdentidade.situacao]}
                  </strong>{' '}
                  (em {formatarInstante(revisao.verificacaoIdentidade.verificadaEm)})
                </p>
                {revisao.verificacaoIdentidade.conflitos.length > 0 && (
                  <ul className="lista-simples" aria-label="Conflitos de identidade">
                    {revisao.verificacaoIdentidade.conflitos.map((conflito) => (
                      <li key={`${conflito.fonte}-${conflito.campo}-${conflito.valor}`}>
                        {conflito.fonte.toUpperCase()}: {conflito.campo} {conflito.valor}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            <p className="texto-suave">
              Revisão {revisao.numero} ({revisao.situacao === 'aprovada' ? 'aprovada' : 'rascunho'}
              ), regras {revisao.versaoRegras}.
              {revisao.aprovadaPor &&
                revisao.aprovadaEm &&
                ` Aprovada por ${revisao.aprovadaPor.nome} em ${formatarInstante(revisao.aprovadaEm)}.`}
            </p>
          </Secao>
        </div>

        <div className="det-coluna det-col-5">
          <Secao id="titulo-ciclo" titulo="Ciclo do pedido" cor="roxo">
            <ol className="ciclo">
              {ETAPAS_DO_CICLO.map((etapa, indice) => {
                const atual = etapaAtual(detalhe.status);
                const alcancada = indice <= atual;
                return (
                  <li
                    key={etapa.titulo}
                    className={alcancada ? 'alcancada' : undefined}
                    aria-current={indice === atual ? 'step' : undefined}
                  >
                    <span className="ciclo-numero">{indice + 1}</span>
                    <div>
                      <strong className={indice === atual ? 'atual' : undefined}>
                        {etapa.titulo}
                      </strong>
                      <p>{etapa.texto}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </Secao>

          <Secao id="titulo-acoes" titulo="Ações" cor="vermelho">
            <p className="texto-suave">
              Ambiente de demonstração: as execuções são simuladas e nenhuma escrita é feita nos
              sistemas de destino.
            </p>
            <div className="barra-acoes">
              {pendente && permitido('editarProposta') && (
                <>
                  <Button
                    className="botao-secundario"
                    onPress={() => abrir({ tipo: 'editarIdentidade' })}
                  >
                    Editar identidade
                  </Button>
                  <Button
                    className="botao-secundario"
                    onPress={() => abrir({ tipo: 'recalcular' })}
                  >
                    Recalcular identidade
                  </Button>
                </>
              )}
              {pendente && permitido('decidirPedido') && (
                <>
                  <Button className="botao-primario" onPress={() => abrir({ tipo: 'aprovar' })}>
                    Aprovar
                  </Button>
                  <Button className="botao-secundario" onPress={() => abrir({ tipo: 'rejeitar' })}>
                    Rejeitar
                  </Button>
                </>
              )}
              {executavel && permitido('executarOperacoes') && itensElegiveis.length > 0 && (
                <Button
                  className="botao-primario"
                  onPress={() =>
                    abrir({
                      tipo: 'executarTodos',
                      itemIds: itensElegiveis.map((item) => item.id),
                    })
                  }
                >
                  {detalhe.status === 'aprovado'
                    ? 'Provisionar todos os itens'
                    : 'Reprocessar pendentes e com erro'}
                </Button>
              )}
              {executavel &&
                permitido('registrarManualReconciliar') &&
                itensElegiveis.length > 0 && (
                  <Button
                    className="botao-secundario"
                    onPress={() => abrir({ tipo: 'acessoManual' })}
                  >
                    Registrar acesso manual
                  </Button>
                )}
              {['aprovado', 'concluidoComErros', 'rejeitado'].includes(detalhe.status) &&
                permitido('decidirPedido') && (
                  <Button className="botao-secundario" onPress={() => abrir({ tipo: 'reabrir' })}>
                    Reabrir para revisão
                  </Button>
                )}
            </div>
            <p className="texto-suave">
              Conferir existência e reconciliar dependem dos conectores reais e ainda não estão
              disponíveis na API.
            </p>
            <Button className="botao-link" onPress={recarregar}>
              Atualizar
            </Button>
          </Secao>
        </div>
      </div>

      <Secao id="titulo-itens" titulo="Itens de acesso e resultado por sistema" cor="roxo">
        {revisao.itens.length === 0 ? (
          <p className="estado">Nenhum sistema habilitado para este vínculo.</p>
        ) : (
          <ul className="itens">
            {revisao.itens.map((proposto) => {
              const resultado = detalhe.itens.find((item) => item.sistema === proposto.sistema);
              return (
                <li key={proposto.sistema} className="item">
                  <h3>{nomeSistema(proposto.sistema)}</h3>
                  <p className="texto-suave">Origem da sugestão: {proposto.origemSugestao}</p>
                  <dl className="grade-leitura">
                    {resumirParametros(proposto.parametros).map(([chave, valor]) => (
                      <Campo key={chave} rotulo={chave}>
                        {valor}
                      </Campo>
                    ))}
                  </dl>
                  {resultado ? (
                    <ResultadoDoItem item={resultado} />
                  ) : (
                    <p className="texto-suave">Sem resultado: nada foi executado ainda.</p>
                  )}
                  {resultado &&
                    executavel &&
                    STATUS_ITEM_EXECUTAVEL.includes(resultado.status) &&
                    !temOperacaoAtiva(resultado) &&
                    permitido('executarOperacoes') && (
                      <Button
                        className="botao-secundario"
                        onPress={() =>
                          abrir({
                            tipo: 'executarItem',
                            itemId: resultado.id,
                            sistema: proposto.sistema,
                          })
                        }
                      >
                        {resultado.status === 'pendente' ? 'Provisionar' : 'Reprocessar'}{' '}
                        {nomeSistema(proposto.sistema)}
                      </Button>
                    )}
                </li>
              );
            })}
          </ul>
        )}
      </Secao>

      <Secao
        id="titulo-timeline"
        titulo="Timeline do pedido"
        cor="ciano"
        extra="eventos relacionados a este pedido"
        semPadding
      >
        <LinhaDoTempoPedido detalhe={detalhe} />
      </Secao>

      <DialogoConfirmacao
        aberto={dialogoAtivo?.tipo === 'aprovar'}
        titulo="Aprovar pedido?"
        descricao="Aprovar só registra a decisão: nada é criado nos sistemas de destino. A execução é um passo separado."
        confirmarRotulo="Aprovar"
        onConfirmar={() => enviar({ acao: 'aprovar', dados: {} })}
        onFechar={() => setDialogo(null)}
      />
      <DialogoConfirmacao
        aberto={dialogoAtivo?.tipo === 'rejeitar'}
        titulo="Rejeitar pedido?"
        confirmarRotulo="Rejeitar"
        desabilitarConfirmar={textoObrigatorio(motivo)}
        onConfirmar={() => enviar({ acao: 'rejeitar', dados: { motivo: motivo.trim() } })}
        onFechar={() => setDialogo(null)}
      >
        <label>
          Motivo da rejeição
          <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={3} />
        </label>
      </DialogoConfirmacao>
      <DialogoConfirmacao
        aberto={dialogoAtivo?.tipo === 'reabrir'}
        titulo="Reabrir pedido para revisão?"
        descricao="O pedido volta a pendente de aprovação e uma nova revisão é aberta."
        confirmarRotulo="Reabrir"
        desabilitarConfirmar={textoObrigatorio(motivo)}
        onConfirmar={() => enviar({ acao: 'reabrir', dados: { motivo: motivo.trim() } })}
        onFechar={() => setDialogo(null)}
      >
        <label>
          Motivo
          <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={3} />
        </label>
      </DialogoConfirmacao>
      <DialogoConfirmacao
        aberto={dialogoAtivo?.tipo === 'recalcular'}
        titulo="Recalcular identidade?"
        descricao="A identidade é refeita a partir dos dados do RH e verificada de novo nos diretórios. Ajustes manuais são descartados."
        confirmarRotulo="Recalcular"
        onConfirmar={() => enviar({ acao: 'recalcularIdentidade', dados: {} })}
        onFechar={() => setDialogo(null)}
      />
      <DialogoConfirmacao
        aberto={dialogoAtivo?.tipo === 'editarIdentidade'}
        titulo="Editar identidade"
        confirmarRotulo="Salvar identidade"
        desabilitarConfirmar={
          textoObrigatorio(identidade.login) ||
          textoObrigatorio(identidade.email) ||
          textoObrigatorio(identidade.nomeExibicao)
        }
        onConfirmar={() =>
          enviar({
            acao: 'editarProposta',
            dados: {
              identidade: {
                login: identidade.login.trim(),
                email: identidade.email.trim(),
                nomeExibicao: identidade.nomeExibicao.trim(),
              },
            },
          })
        }
        onFechar={() => setDialogo(null)}
      >
        <label>
          Login
          <input
            value={identidade.login}
            onChange={(e) => setIdentidade({ ...identidade, login: e.target.value })}
            maxLength={20}
          />
        </label>
        <label>
          E-mail
          <input
            type="email"
            value={identidade.email}
            onChange={(e) => setIdentidade({ ...identidade, email: e.target.value })}
          />
        </label>
        <label>
          Nome de exibição
          <input
            value={identidade.nomeExibicao}
            onChange={(e) => setIdentidade({ ...identidade, nomeExibicao: e.target.value })}
          />
        </label>
      </DialogoConfirmacao>
      <DialogoConfirmacao
        aberto={dialogoAtivo?.tipo === 'executarTodos'}
        titulo={detalhe.status === 'aprovado' ? 'Provisionar todos os itens?' : 'Reprocessar?'}
        descricao="Será gravada a intenção de execução na fila; um worker a executa depois. Itens já confirmados não são executados de novo. Resultado simulado nunca vira confirmação."
        confirmarRotulo="Solicitar execução"
        onConfirmar={() =>
          dialogoAtivo?.tipo === 'executarTodos'
            ? enviar({ acao: 'solicitarExecucao', dados: { itemIds: [...dialogoAtivo.itemIds] } })
            : Promise.resolve()
        }
        onFechar={() => setDialogo(null)}
      />
      <DialogoConfirmacao
        aberto={dialogoAtivo?.tipo === 'executarItem'}
        titulo={`Executar ${dialogoAtivo?.tipo === 'executarItem' ? nomeSistema(dialogoAtivo.sistema) : ''}?`}
        descricao="Será gravada a intenção de execução só deste item; um worker a executa depois."
        confirmarRotulo="Solicitar execução"
        onConfirmar={() =>
          dialogoAtivo?.tipo === 'executarItem'
            ? enviar({ acao: 'solicitarExecucao', dados: { itemIds: [dialogoAtivo.itemId] } })
            : Promise.resolve()
        }
        onFechar={() => setDialogo(null)}
      />
      <DialogoConfirmacao
        aberto={dialogoAtivo?.tipo === 'acessoManual'}
        titulo="Registrar acesso manual"
        descricao="Declara um acesso feito fora do GIA. Fica auditado e não prova a conferência no destino."
        confirmarRotulo="Registrar"
        desabilitarConfirmar={textoObrigatorio(observacao) || itemManual === ''}
        onConfirmar={() =>
          enviar({
            acao: 'registrarAcessoManual',
            dados: { itemId: itemManual, observacao: observacao.trim() },
          })
        }
        onFechar={() => setDialogo(null)}
      >
        <label>
          Item
          <select value={itemManual} onChange={(e) => setItemManual(e.target.value)}>
            {itensElegiveis.map((item) => (
              <option key={item.id} value={item.id}>
                {nomeSistema(item.sistema)} ({ROTULO_STATUS_ITEM[item.status]})
              </option>
            ))}
          </select>
        </label>
        <label>
          Observação
          <textarea value={observacao} onChange={(e) => setObservacao(e.target.value)} rows={3} />
        </label>
      </DialogoConfirmacao>
    </>
  );
}
