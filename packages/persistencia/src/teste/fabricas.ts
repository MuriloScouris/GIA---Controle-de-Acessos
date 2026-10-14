import { randomUUID } from 'node:crypto';
import {
  criarAtorDeServico,
  eventoDoGia,
  type AtorRegistrado,
  type Colaborador,
  type ContextoComando,
  type Evento,
  type Instante,
  type ItemAcesso,
  type Operacao,
  type PedidoAdmissao,
  type Revisao,
  type Sistema,
} from '@gia/dominio';

/** Dados fictícios para os testes de persistência. Nenhum CPF real. */
export const INICIO: Instante = '2026-10-13T12:00:00.000Z';

export function depois(ms: number, base: Instante = INICIO): Instante {
  return new Date(Date.parse(base) + ms).toISOString();
}

let sequenciaCpf = 0;
/** 11 dígitos fictícios e distintos (a persistência não valida dígito verificador). */
export function cpfFicticio(): string {
  sequenciaCpf += 1;
  return `9${String(sequenciaCpf).padStart(10, '0')}`;
}

export const SOLICITANTE: AtorRegistrado = {
  tipo: 'humano',
  id: 'usuario-executor',
  nome: 'Pessoa executor',
  papeis: ['executor'],
};

export function ctxServico(agora: Instante = INICIO, workerId = 'worker-1'): ContextoComando {
  return {
    ator: criarAtorDeServico({ id: workerId, nome: 'Serviço executor' }, SOLICITANTE.id),
    agora,
    correlacaoId: `correlacao-${workerId}`,
    novoId: randomUUID,
  };
}

export interface Cenario {
  readonly colaborador: Colaborador;
  readonly pedido: PedidoAdmissao;
  readonly revisao: Revisao;
  readonly itens: Readonly<Record<'ad' | 'm365' | 'jira', ItemAcesso>>;
}

export function cenario(chaveJira = `RH-${randomUUID().slice(0, 8)}`): Cenario {
  const colaborador: Colaborador = {
    id: randomUUID(),
    cpf: cpfFicticio(),
    matricula: null,
    nome: 'Bia Ficticia Lopes',
    login: null,
    upn: null,
    email: null,
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
    situacao: 'rascunho',
    criadaEm: INICIO,
    baseadaEmRevisaoId: null,
    aprovadaPor: null,
    aprovadaEm: null,
  };
  const pedido: PedidoAdmissao = {
    id: pedidoId,
    origem: { sistema: 'jira', idExterno: chaveJira },
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
    status: 'aprovado',
    revisaoCorrenteId: revisao.id,
    motivoRejeicao: null,
    criadoEm: INICIO,
    atualizadoEm: INICIO,
    versao: 1,
  };
  const item = (sistema: 'ad' | 'm365' | 'jira'): ItemAcesso => ({
    id: randomUUID(),
    pedidoId,
    revisaoId: revisao.id,
    sistema,
    parametros: { sistema: 'jira', email: 'bia@exemplo.com.br', nome: 'Bia', grupos: [] },
    status: 'pendente',
    idExterno: null,
    mensagem: null,
    etapaAlcancada: null,
    geracao: 0,
    ultimaOperacaoId: null,
    herdadoDeItemId: null,
    confirmadoEm: null,
    observacaoManual: null,
    versao: 1,
  });
  return {
    colaborador,
    pedido,
    revisao,
    itens: { ad: item('ad'), m365: item('m365'), jira: item('jira') },
  };
}

export function operacao(item: ItemAcesso, mudancas: Partial<Operacao> = {}): Operacao {
  const id = randomUUID();
  return {
    id,
    pedidoId: item.pedidoId,
    revisaoId: item.revisaoId,
    itemId: item.id,
    sistema: item.sistema as Sistema,
    acao: 'provisionar',
    chaveIdempotencia: `gia:simulado:${item.pedidoId}:${item.revisaoId}:${item.id}:provisionar:${id}`,
    modo: 'simulado',
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
    dependeDeItemId: null,
    solicitadaPor: SOLICITANTE,
    criadaEm: INICIO,
    atualizadaEm: INICIO,
    versao: 1,
    ...mudancas,
  };
}

export function evento(ctx: ContextoComando, pedidoId: string): Evento {
  return eventoDoGia(ctx, { tipo: 'execucaoSolicitada', pedidoId, dados: { origem: 'teste' } });
}
