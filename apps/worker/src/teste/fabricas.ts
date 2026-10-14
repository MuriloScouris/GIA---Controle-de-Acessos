import { randomUUID } from 'node:crypto';
import {
  etapasDe,
  gerarChaveIdempotencia,
  type AtorRegistrado,
  type Colaborador,
  type Conector,
  type ContextoItem,
  type Efeito,
  type Etapa,
  type Instante,
  type ItemAcesso,
  type ModoExecucao,
  type Operacao,
  type ParametrosSistema,
  type PedidoAdmissao,
  type ResultadoOperacao,
  type Revisao,
  type Sistema,
  type StatusItem,
  type StatusPedido,
} from '@gia/dominio';
import type { RepositoriosComFila, UnidadeDeTrabalho } from '@gia/persistencia';

/** Dados fictícios para os testes do worker. Nenhum CPF ou pessoa real. */
export const INICIO: Instante = '2026-10-14T12:00:00.000Z';

export function depois(ms: number, base: Instante = INICIO): Instante {
  return new Date(Date.parse(base) + ms).toISOString();
}

export const SOLICITANTE: AtorRegistrado = {
  tipo: 'humano',
  id: 'usuario-executor',
  nome: 'Pessoa executor',
  papeis: ['executor'],
};

let sequenciaCpf = 0;
function cpfFicticio(): string {
  sequenciaCpf += 1;
  return `8${String(sequenciaCpf).padStart(10, '0')}`;
}

const PARAMETROS: { readonly [S in Sistema]: (login: string) => ParametrosSistema } = {
  ad: (login) => ({
    sistema: 'ad',
    login,
    upn: `${login}@exemplo.com.br`,
    email: `${login}@exemplo.com.br`,
    proxyAddresses: [],
    nome: 'Bia',
    sobrenome: 'Ficticia',
    nomeExibicao: 'Bia Ficticia',
    ou: 'OU=Usuarios,DC=exemplo,DC=local',
    grupos: ['GG_Todos'],
    cargo: 'Analista',
    departamento: 'Tecnologia',
    empresa: 'Exemplo',
    escritorio: null,
    scriptLogon: null,
    gerente: null,
    cpf: cpfFicticio(),
    controleConta: 512,
  }),
  m365: (login) => ({
    sistema: 'm365',
    upn: `${login}@exemplo.com.br`,
    email: `${login}@exemplo.com.br`,
    nome: 'Bia Ficticia',
    planosLicenca: ['E3'],
    paisUso: 'BR',
    grupo: null,
  }),
  docusign: (login) => ({
    sistema: 'docusign',
    email: `${login}@exemplo.com.br`,
    nome: 'Bia Ficticia',
    empresa: 'Exemplo',
    cargo: 'Analista',
    perfil: 'Remetente',
    grupo: 'Tecnologia',
    idioma: 'pt_BR',
    endereco: null,
  }),
  softexpert: (login) => ({
    sistema: 'softexpert',
    identificador: `M${login.length}${sequenciaCpf}`,
    login,
    nome: 'Bia Ficticia',
    email: `${login}@exemplo.com.br`,
    area: 'Tecnologia',
    funcao: 'Analista',
    grupoAcesso: 'Leitores',
  }),
  jira: (login) => ({
    sistema: 'jira',
    email: `${login}@exemplo.com.br`,
    nome: 'Bia Ficticia',
    grupos: ['jira-servicedesk-users'],
  }),
};

export interface Cenario {
  readonly colaborador: Colaborador;
  readonly pedido: PedidoAdmissao;
  readonly revisao: Revisao;
  readonly itens: Partial<Record<Sistema, ItemAcesso>>;
}

/** Pedido aprovado com um item por sistema; no modo real, já em execução (como `solicitarExecucao` deixa). */
export function cenario(
  sistemas: readonly Sistema[],
  opcoes: { readonly modo?: ModoExecucao; readonly statusItem?: StatusItem } = {},
): Cenario {
  const modo = opcoes.modo ?? 'real';
  const login = `bia.${randomUUID().slice(0, 8)}`;
  const colaborador: Colaborador = {
    id: randomUUID(),
    cpf: cpfFicticio(),
    matricula: null,
    nome: 'Bia Ficticia Lopes',
    login,
    upn: `${login}@exemplo.com.br`,
    email: `${login}@exemplo.com.br`,
    tipoVinculo: 'celetista',
    status: 'ativo',
    dataAdmissao: '2026-11-03',
    dataDesligamento: null,
    versao: 1,
  };
  const pedidoId = randomUUID();
  const revisao: Revisao = {
    id: randomUUID(),
    pedidoId,
    numero: 1,
    identidade: null,
    pendenciaIdentidade: null,
    verificacaoIdentidade: null,
    itens: [],
    versaoRegras: 'teste',
    situacao: 'aprovada',
    criadaEm: INICIO,
    baseadaEmRevisaoId: null,
    aprovadaPor: SOLICITANTE,
    aprovadaEm: INICIO,
  };
  const statusPedido: StatusPedido = modo === 'real' ? 'emExecucao' : 'aprovado';
  const pedido: PedidoAdmissao = {
    id: pedidoId,
    origem: { sistema: 'jira', idExterno: `RH-${randomUUID().slice(0, 8)}` },
    tipoVinculo: 'celetista',
    dadosRh: {
      nomeCompleto: colaborador.nome,
      cpf: colaborador.cpf,
      matricula: null,
      emailCorporativoSugerido: null,
      area: 'Tecnologia',
      cargo: 'Analista',
      dataAdmissao: colaborador.dataAdmissao,
      gestor: null,
    },
    colaboradorId: colaborador.id,
    status: statusPedido,
    revisaoCorrenteId: revisao.id,
    motivoRejeicao: null,
    criadoEm: INICIO,
    atualizadoEm: INICIO,
    versao: 1,
  };
  const itens: Partial<Record<Sistema, ItemAcesso>> = {};
  for (const sistema of sistemas) {
    const status: StatusItem =
      opcoes.statusItem ??
      (modo === 'simulado'
        ? 'pendente'
        : sistema === 'm365' && sistemas.includes('ad')
          ? 'aguardandoDependencia'
          : 'emExecucao');
    itens[sistema] = {
      id: randomUUID(),
      pedidoId,
      revisaoId: revisao.id,
      sistema,
      parametros: PARAMETROS[sistema](login),
      status,
      idExterno: null,
      mensagem: null,
      etapaAlcancada: null,
      geracao: modo === 'real' ? 1 : 0,
      ultimaOperacaoId: null,
      herdadoDeItemId: null,
      confirmadoEm: null,
      observacaoManual: null,
      versao: 1,
    };
  }
  return { colaborador, pedido, revisao, itens };
}

export function operacao(c: Cenario, sistema: Sistema, mudancas: Partial<Operacao> = {}): Operacao {
  const item = c.itens[sistema];
  if (item === undefined) throw new Error(`cenário sem item ${sistema}`);
  const modo = mudancas.modo ?? (item.geracao > 0 ? 'real' : 'simulado');
  const id = randomUUID();
  const dependencia = sistema === 'm365' ? c.itens.ad : undefined;
  return {
    id,
    pedidoId: item.pedidoId,
    revisaoId: item.revisaoId,
    itemId: item.id,
    sistema,
    acao: 'provisionar',
    chaveIdempotencia:
      modo === 'real'
        ? gerarChaveIdempotencia({
            pedidoId: item.pedidoId,
            revisaoId: item.revisaoId,
            itemId: item.id,
            acao: 'provisionar',
            modo,
            geracao: item.geracao,
          })
        : `gia:simulado:${id}`,
    modo,
    status: 'pendente',
    lease: null,
    tentativas: 0,
    disponivelEm: INICIO,
    etapaInicial: null,
    etapaAlcancada: null,
    efeito: null,
    codigo: null,
    referenciaExterna: null,
    mensagem: null,
    dependeDeItemId: dependencia?.id ?? null,
    solicitadaPor: SOLICITANTE,
    criadaEm: INICIO,
    atualizadaEm: INICIO,
    versao: 1,
    ...mudancas,
  };
}

export async function gravar(
  persistencia: UnidadeDeTrabalho<RepositoriosComFila>,
  c: Cenario,
  operacoes: readonly Operacao[],
): Promise<void> {
  await persistencia.executar(async (tx) => {
    await tx.colaboradores.salvar(c.colaborador);
    await tx.pedidos.salvar(c.pedido);
    await tx.revisoes.salvar(c.revisao);
    await tx.itens.salvar(Object.values(c.itens));
    await tx.operacoes.salvar(operacoes);
  });
}

// ---------------------------------------------------------------------------
// Conector programável: responde o que o teste mandar e registra as chamadas.
// ---------------------------------------------------------------------------

export interface Chamada {
  readonly sistema: Sistema;
  readonly acao: 'provisionar' | 'revogar';
  readonly ctx: ContextoItem;
}

type Resposta = (chamada: Chamada) => ResultadoOperacao | Promise<ResultadoOperacao>;

export function resultado(
  sistema: Sistema,
  efeito: Efeito,
  mudancas: Partial<ResultadoOperacao> & { readonly etapa?: Etapa | null } = {},
  acao: 'provisionar' | 'revogar' = 'provisionar',
): ResultadoOperacao {
  const ultima = etapasDe(sistema, acao).at(-1) ?? null;
  return {
    efeito,
    modo: 'real',
    etapa: efeito === 'confirmado' ? ultima : null,
    codigo: efeito === 'confirmado' ? 'OK' : 'FALHOU',
    referenciaExterna: efeito === 'confirmado' ? `ext-${sistema}` : null,
    mensagem: efeito === 'confirmado' ? 'Concluído no destino.' : 'O destino recusou.',
    transitorio: false,
    tentarAposMs: null,
    ...mudancas,
  };
}

export interface ConectoresProgramados {
  readonly conectores: Readonly<Record<Sistema, Conector>>;
  readonly chamadas: Chamada[];
  /** Próximas respostas do sistema, em ordem; sem programação, confirma tudo. */
  programar(sistema: Sistema, ...respostas: Resposta[]): void;
}

export function conectoresProgramados(modo: ModoExecucao = 'real'): ConectoresProgramados {
  const chamadas: Chamada[] = [];
  const filas = new Map<Sistema, Resposta[]>();
  const conector = (sistema: Sistema): Conector => {
    const escrever = async (acao: 'provisionar' | 'revogar', ctx: ContextoItem) => {
      const chamada = { sistema, acao, ctx };
      chamadas.push(chamada);
      const proxima = filas.get(sistema)?.shift();
      return proxima ? proxima(chamada) : resultado(sistema, 'confirmado', { modo }, acao);
    };
    const naoUsado = (): never => {
      throw new Error('o worker não deveria chamar esta operação');
    };
    return {
      testarConexao: naoUsado,
      validar: naoUsado,
      conferirExistencia: naoUsado,
      provisionar: (ctx) => escrever('provisionar', ctx),
      revogar: (ctx) => escrever('revogar', ctx),
    };
  };
  return {
    conectores: {
      ad: conector('ad'),
      m365: conector('m365'),
      docusign: conector('docusign'),
      softexpert: conector('softexpert'),
      jira: conector('jira'),
    },
    chamadas,
    programar(sistema, ...respostas) {
      filas.set(sistema, [...(filas.get(sistema) ?? []), ...respostas]);
    },
  };
}

/** Resposta que só sai quando o teste mandar; avisa quando o conector foi chamado. */
export function respostaSegura() {
  let liberar!: () => void;
  const liberada = new Promise<void>((r) => {
    liberar = r;
  });
  let avisar!: () => void;
  const chamada = new Promise<void>((r) => {
    avisar = r;
  });
  return {
    /** Promessa resolvida quando o conector recebe a chamada. */
    chamada,
    liberar,
    responder(r: ResultadoOperacao): () => Promise<ResultadoOperacao> {
      return async () => {
        avisar();
        await liberada;
        return r;
      };
    },
  };
}

/** Agendador manual: o teste decide quando a renovação do lease roda. */
export function agendadorManual() {
  const tarefas = new Set<() => void>();
  return {
    agendar(tarefa: () => void): () => void {
      tarefas.add(tarefa);
      return () => tarefas.delete(tarefa);
    },
    disparar(): number {
      for (const tarefa of tarefas) tarefa();
      return tarefas.size;
    },
  };
}
