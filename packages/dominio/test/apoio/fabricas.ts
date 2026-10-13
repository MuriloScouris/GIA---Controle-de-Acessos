import {
  aprovarPedido,
  configuracaoPadrao,
  criarAtorDaSessao,
  criarAtorDeServico,
  receberChamado,
  registrarResultadoOperacao,
  reservarOperacao,
  solicitarExecucao,
  verificarIdentidade,
  POLITICA_EXECUCAO_PADRAO,
  SISTEMAS,
  type ChamadoNormalizado,
  type Colaborador,
  type ConfiguracaoSistemas,
  type ContextoComando,
  type Instante,
  type ItemAcesso,
  type ItemProposto,
  type LiberacaoEscrita,
  type Operacao,
  type Papel,
  type ParametrosAd,
  type ParametrosDocusign,
  type ParametrosJira,
  type ParametrosM365,
  type ParametrosSistema,
  type ParametrosSoftexpert,
  type PedidoAdmissao,
  type Resultado,
  type ResultadoOperacao,
  type Revisao,
  type Sistema,
  type TipoVinculo,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------

/** Extrai o valor de um resultado de sucesso; falha o teste com o código do erro. */
export function valor<T>(resultado: Resultado<T>): T {
  if (!resultado.ok) {
    throw new Error(`esperava sucesso, veio ${resultado.erro.codigo}: ${resultado.erro.mensagem}`);
  }
  return resultado.valor;
}

/** Código do erro de um resultado de falha; falha o teste se veio sucesso. */
export function codigoErro(resultado: Resultado<unknown>): string {
  if (resultado.ok) throw new Error('esperava falha, veio sucesso');
  return resultado.erro.codigo;
}

// ---------------------------------------------------------------------------
// Contexto (ator da sessão, relógio e IDs determinísticos)
// ---------------------------------------------------------------------------

let sequencia = 0;
export function novoId(): string {
  sequencia += 1;
  return `00000000-0000-4000-8000-${sequencia.toString().padStart(12, '0')}`;
}

export const AGORA: Instante = '2026-10-13T12:00:00.000Z';

export function depois(ms: number, base: Instante = AGORA): Instante {
  return new Date(Date.parse(base) + ms).toISOString();
}

export function contexto(
  papeis: readonly Papel[],
  agora: Instante = AGORA,
  usuarioId?: string,
): ContextoComando {
  return {
    ator: criarAtorDaSessao({
      usuarioId: usuarioId ?? `usuario-${papeis.join('-')}`,
      nome: `Pessoa ${papeis.join(' e ')}`,
      papeis,
    }),
    agora,
    correlacaoId: 'correlacao-teste',
    novoId,
  };
}

export const ctxRevisor = (agora?: Instante): ContextoComando => contexto(['revisor'], agora);
export const ctxExecutor = (agora?: Instante): ContextoComando => contexto(['executor'], agora);
export const ctxAdminGia = (agora?: Instante): ContextoComando =>
  contexto(['administradorGia'], agora);
export const ctxAdminTecnico = (agora?: Instante): ContextoComando =>
  contexto(['administradorTecnico'], agora);

export function ctxServico(agora: Instante = AGORA, workerId = 'worker-1'): ContextoComando {
  return {
    ator: criarAtorDeServico({ id: workerId, nome: 'Serviço executor' }, 'usuario-executor'),
    agora,
    correlacaoId: 'correlacao-worker',
    novoId,
  };
}

// ---------------------------------------------------------------------------
// Dados
// ---------------------------------------------------------------------------

/** Calcula os dígitos verificadores, para gerar CPFs válidos fictícios. */
export function cpfValido(nove: string): string {
  const numeros = nove.split('').map(Number);
  const digito = (base: number[]): number => {
    const soma = base.reduce((acc, n, i) => acc + n * (base.length + 1 - i), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const d1 = digito(numeros);
  const d2 = digito([...numeros, d1]);
  return `${nove}${d1}${d2}`;
}

export const CPF_ANA = cpfValido('123456789');
export const CPF_BRUNO = cpfValido('987654321');

export function parametrosAd(mudancas: Partial<ParametrosAd> = {}): ParametrosAd {
  return {
    sistema: 'ad',
    login: 'x',
    upn: 'x@empresa.com.br',
    email: 'x@empresa.com.br',
    proxyAddresses: [],
    nome: 'Ana',
    sobrenome: 'Souza',
    nomeExibicao: 'Ana Souza',
    ou: 'OU=Usuarios,DC=empresa,DC=local',
    grupos: ['GG_Financeiro', 'GG_VPN'],
    cargo: 'Analista',
    departamento: 'Financeiro',
    empresa: 'Empresa',
    escritorio: null,
    scriptLogon: null,
    gerente: null,
    cpf: CPF_ANA,
    controleConta: 512,
    ...mudancas,
  };
}

export function parametrosM365(mudancas: Partial<ParametrosM365> = {}): ParametrosM365 {
  return {
    sistema: 'm365',
    upn: 'x@empresa.com.br',
    email: 'x@empresa.com.br',
    nome: 'Ana Souza',
    planosLicenca: ['E3'],
    paisUso: 'BR',
    grupo: 'M365_Financeiro',
    ...mudancas,
  };
}

export function parametrosDocusign(mudancas: Partial<ParametrosDocusign> = {}): ParametrosDocusign {
  return {
    sistema: 'docusign',
    email: 'x@empresa.com.br',
    nome: 'Ana Souza',
    empresa: 'Empresa',
    cargo: 'Analista',
    perfil: 'Remetente',
    grupo: 'Financeiro',
    idioma: 'pt_BR',
    endereco: null,
    ...mudancas,
  };
}

export function parametrosSoftexpert(
  mudancas: Partial<ParametrosSoftexpert> = {},
): ParametrosSoftexpert {
  return {
    sistema: 'softexpert',
    identificador: 'M123',
    login: 'x',
    nome: 'Ana Souza',
    email: 'x@empresa.com.br',
    area: 'Financeiro',
    funcao: 'Analista',
    grupoAcesso: 'Leitores',
    ...mudancas,
  };
}

export function parametrosJira(mudancas: Partial<ParametrosJira> = {}): ParametrosJira {
  return {
    sistema: 'jira',
    email: 'x@empresa.com.br',
    nome: 'Ana Souza',
    grupos: ['jira-servicedesk-users'],
    ...mudancas,
  };
}

const FABRICAS_PARAMETROS: Readonly<Record<Sistema, () => ParametrosSistema>> = {
  ad: () => parametrosAd(),
  m365: () => parametrosM365(),
  docusign: () => parametrosDocusign(),
  softexpert: () => parametrosSoftexpert(),
  jira: () => parametrosJira(),
};

export function itemProposto(sistema: Sistema, parametros?: ParametrosSistema): ItemProposto {
  return {
    sistema,
    parametros: parametros ?? FABRICAS_PARAMETROS[sistema](),
    origemSugestao: `regra área Financeiro / cargo Analista (${sistema})`,
  };
}

export function itensSugeridos(sistemas: readonly Sistema[] = SISTEMAS): ItemProposto[] {
  return sistemas.map((sistema) => itemProposto(sistema));
}

export function chamado(
  mudancas: {
    idExterno?: string;
    tipoVinculo?: TipoVinculo;
    cpf?: string;
    email?: string | null;
    nome?: string;
  } = {},
): ChamadoNormalizado {
  return {
    origem: { sistema: 'jira', idExterno: mudancas.idExterno ?? 'RH-100' },
    tipoVinculo: mudancas.tipoVinculo ?? 'celetista',
    dadosRh: {
      nomeCompleto: mudancas.nome ?? 'Ana Maria Souza',
      cpf: mudancas.cpf ?? CPF_ANA,
      matricula: 'M123',
      emailCorporativoSugerido:
        mudancas.email === undefined ? 'ana.souza@empresa.com.br' : mudancas.email,
      area: 'Financeiro',
      cargo: 'Analista',
      dataAdmissao: '2026-11-03',
      gestor: null,
    },
  };
}

export function liberacaoTotal(): LiberacaoEscrita {
  return Object.fromEntries(
    SISTEMAS.map((sistema) => [sistema, { criar: true, revogar: true }]),
  ) as unknown as LiberacaoEscrita;
}

export function configuracaoComEscrita(): ConfiguracaoSistemas {
  return { ...configuracaoPadrao(), liberacaoEscrita: liberacaoTotal() };
}

export function resultadoConector(mudancas: Partial<ResultadoOperacao> = {}): ResultadoOperacao {
  return {
    efeito: 'confirmado',
    modo: 'real',
    etapa: null,
    codigo: 'OK',
    referenciaExterna: 'ext-1',
    mensagem: 'ok',
    transitorio: false,
    tentarAposMs: null,
    ...mudancas,
  };
}

// ---------------------------------------------------------------------------
// Cenários
// ---------------------------------------------------------------------------

export interface CenarioRecebido {
  pedido: PedidoAdmissao;
  revisao: Revisao;
  colaborador: Colaborador;
}

export function cenarioRecebido(
  opcoes: {
    sistemas?: readonly Sistema[];
    chamado?: ChamadoNormalizado;
    configuracao?: ConfiguracaoSistemas;
  } = {},
): CenarioRecebido {
  const recebido = valor(
    receberChamado(
      {
        chamado: opcoes.chamado ?? chamado(),
        pedidoMesmaOrigem: null,
        colaboradorExistente: null,
        configuracao: opcoes.configuracao ?? configuracaoPadrao(),
        versaoRegras: 'regras-v7',
        itensSugeridos: itensSugeridos(opcoes.sistemas),
      },
      ctxRevisor(),
    ),
  );
  if (recebido.tipo !== 'criado') throw new Error('esperava pedido criado');
  return { pedido: recebido.pedido, revisao: recebido.revisao, colaborador: recebido.colaborador };
}

export function cenarioVerificado(
  opcoes: Parameters<typeof cenarioRecebido>[0] = {},
): CenarioRecebido {
  const base = cenarioRecebido(opcoes);
  const verificado = valor(
    verificarIdentidade(
      { pedido: base.pedido, revisao: base.revisao, usos: [] },
      base.pedido.versao,
      ctxRevisor(),
    ),
  );
  return { ...base, pedido: verificado.pedido, revisao: verificado.revisao };
}

export interface CenarioAprovado extends CenarioRecebido {
  itens: readonly ItemAcesso[];
}

export function cenarioAprovado(
  opcoes: Parameters<typeof cenarioRecebido>[0] = {},
): CenarioAprovado {
  const base = cenarioVerificado(opcoes);
  const aprovado = valor(
    aprovarPedido(
      {
        pedido: base.pedido,
        revisao: base.revisao,
        colaborador: base.colaborador,
        itensAnteriores: [],
      },
      base.pedido.versao,
      ctxRevisor(),
    ),
  );
  return {
    pedido: aprovado.pedido,
    revisao: aprovado.revisao,
    colaborador: aprovado.colaborador,
    itens: aprovado.itens,
  };
}

export interface CenarioEmExecucao extends CenarioAprovado {
  operacoes: readonly Operacao[];
  configuracao: ConfiguracaoSistemas;
}

export function cenarioEmExecucao(
  opcoes: Parameters<typeof cenarioRecebido>[0] & { itemIds?: readonly string[] } = {},
): CenarioEmExecucao {
  const aprovado = cenarioAprovado(opcoes);
  const configuracao = configuracaoComEscrita();
  const execucao = valor(
    solicitarExecucao(
      {
        pedido: aprovado.pedido,
        revisao: aprovado.revisao,
        itens: aprovado.itens,
        operacoesExistentes: [],
        configuracao,
        modo: 'real',
        ...(opcoes.itemIds === undefined ? {} : { itemIds: opcoes.itemIds }),
      },
      aprovado.pedido.versao,
      ctxExecutor(),
    ),
  );
  return {
    ...aprovado,
    pedido: execucao.pedido,
    itens: substituirItens(aprovado.itens, execucao.itens),
    operacoes: execucao.operacoes,
    configuracao,
  };
}

export function substituirItens(
  itens: readonly ItemAcesso[],
  alterados: readonly ItemAcesso[],
): ItemAcesso[] {
  return itens.map((item) => alterados.find((alterado) => alterado.id === item.id) ?? item);
}

export function itemDo(itens: readonly ItemAcesso[], sistema: Sistema): ItemAcesso {
  const item = itens.find((candidato) => candidato.sistema === sistema);
  if (!item) throw new Error(`item ${sistema} não encontrado`);
  return item;
}

export function operacaoDo(operacoes: readonly Operacao[], item: ItemAcesso): Operacao {
  const operacao = operacoes.find((candidata) => candidata.itemId === item.id);
  if (!operacao) throw new Error(`operação do item ${item.sistema} não encontrada`);
  return operacao;
}

/** Reserva a operação como o worker padrão, informando o item real da dependência. */
export function reservar(
  operacao: Operacao,
  agora: Instante = AGORA,
  dependencia: ItemAcesso | null = null,
): Operacao {
  return valor(
    reservarOperacao(operacao, { dependencia }, POLITICA_EXECUCAO_PADRAO, ctxServico(agora)),
  ).operacao;
}

/** Confirma o item do AD de um cenário em execução (resultado real da última etapa). */
export function confirmarAd(cenario: CenarioEmExecucao): ItemAcesso {
  const ad = itemDo(cenario.itens, 'ad');
  return valor(
    registrarResultadoOperacao(
      {
        operacao: reservar(operacaoDo(cenario.operacoes, ad)),
        item: ad,
        resultado: resultadoConector({ etapa: 'adicionarGrupos' }),
      },
      POLITICA_EXECUCAO_PADRAO,
      ctxServico(),
    ),
  ).item;
}
