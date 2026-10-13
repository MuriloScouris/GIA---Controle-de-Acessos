import { describe, expect, it } from 'vitest';
import {
  alterarSistemasPorVinculo,
  aprovarPedido,
  autorizar,
  configuracaoPadrao,
  nivelDeAcesso,
  receberChamado,
  registrarAcessoManual,
  solicitarExecucao,
  ACOES_FORA_DO_ADMINISTRADOR_GIA,
  ACOES_FUNCIONAIS,
  MATRIZ_PERMISSOES,
  PAPEIS,
  type AcaoFuncional,
  type NivelAcesso,
  type Papel,
} from '../../src/index.js';
import {
  cenarioAprovado,
  cenarioVerificado,
  chamado,
  codigoErro,
  configuracaoComEscrita,
  contexto,
  ctxAdminGia,
  ctxServico,
  itensSugeridos,
  valor,
} from '../apoio/fabricas.js';

/** Matriz do documento de estrutura (✓ = total), mais as linhas do ADR-0007. */
const ESPERADO: Readonly<
  Record<
    Exclude<Papel, 'administradorGia' | 'servicoExecutor'>,
    Partial<Record<AcaoFuncional, NivelAcesso>>
  >
> = {
  solicitante: {
    criarPedido: 'restrito',
    acompanharPedido: 'restrito',
    consultarDadosPessoais: 'proprio',
  },
  revisor: {
    criarPedido: 'total',
    acompanharPedido: 'total',
    consultarDadosPessoais: 'restrito',
    editarProposta: 'total',
    decidirPedido: 'total',
    validarConferirTestar: 'total',
    baixarDocumento: 'restrito',
    consultarRegras: 'total',
    alterarRegras: 'total',
  },
  executor: {
    criarPedido: 'total',
    acompanharPedido: 'total',
    consultarDadosPessoais: 'restrito',
    validarConferirTestar: 'total',
    executarOperacoes: 'total',
    registrarManualReconciliar: 'total',
    baixarDocumento: 'restrito',
  },
  auditor: {
    acompanharPedido: 'leitura',
    consultarDadosPessoais: 'restrito',
    consultarAuditoria: 'total',
    exportarAuditoria: 'total',
    consultarRegras: 'leitura',
  },
  administradorTecnico: {
    validarConferirTestar: 'total',
    consultarRegras: 'total',
    alterarRegras: 'total',
    configurarSegredos: 'total',
    liberarEscrita: 'total',
  },
};

describe('Permissões por papel', () => {
  it('reproduz a matriz do documento de estrutura', () => {
    for (const [papel, acoes] of Object.entries(ESPERADO)) {
      for (const acao of ACOES_FUNCIONAIS) {
        expect(nivelDeAcesso([papel as Papel], acao), `${papel}/${acao}`).toBe(acoes[acao] ?? null);
      }
    }
  });

  it('nível `leitura` só autoriza consultas', () => {
    expect(autorizar(['auditor'], 'consultarRegras').ok).toBe(true);
    expect(codigoErro(autorizar(['auditor'], 'alterarRegras'))).toBe('PERMISSAO_NEGADA');
    expect(codigoErro(autorizar(['auditor'], 'decidirPedido'))).toBe('PERMISSAO_NEGADA');
  });

  it('com vários papéis vale o maior nível', () => {
    expect(nivelDeAcesso(['auditor', 'revisor'], 'acompanharPedido')).toBe('total');
    expect(nivelDeAcesso(['solicitante', 'executor'], 'consultarDadosPessoais')).toBe('restrito');
    expect(nivelDeAcesso([], 'acompanharPedido')).toBeNull();
  });

  it('a ingestão (serviço executor) cria pedidos mas nunca aprova', () => {
    expect(autorizar(['servicoExecutor'], 'criarPedido').ok).toBe(true);
    expect(codigoErro(autorizar(['servicoExecutor'], 'decidirPedido'))).toBe('PERMISSAO_NEGADA');
    const base = cenarioVerificado();
    const resultado = aprovarPedido(
      {
        pedido: base.pedido,
        revisao: base.revisao,
        colaborador: base.colaborador,
        itensAnteriores: [],
      },
      base.pedido.versao,
      ctxServico(),
    );
    expect(codigoErro(resultado)).toBe('PERMISSAO_NEGADA');
  });

  it('só o serviço executor registra resultado de operação', () => {
    for (const papel of PAPEIS.filter((p) => p !== 'servicoExecutor')) {
      expect(nivelDeAcesso([papel], 'registrarResultadoOperacao'), papel).toBeNull();
    }
  });

  it('solicitante não aprova nem executa', () => {
    const base = cenarioVerificado();
    expect(
      codigoErro(
        aprovarPedido(
          {
            pedido: base.pedido,
            revisao: base.revisao,
            colaborador: base.colaborador,
            itensAnteriores: [],
          },
          base.pedido.versao,
          contexto(['solicitante']),
        ),
      ),
    ).toBe('PERMISSAO_NEGADA');
  });
});

describe('Perfil Administrador do Gia (ADR-0007)', () => {
  it('tem acesso total a todas as ações funcionais', () => {
    const funcionais = ACOES_FUNCIONAIS.filter(
      (acao) => !ACOES_FORA_DO_ADMINISTRADOR_GIA.includes(acao),
    );
    expect(funcionais).toEqual(
      expect.arrayContaining([
        'acompanharPedido',
        'consultarDadosPessoais',
        'consultarAuditoria',
        'criarPedido',
        'editarProposta',
        'validarConferirTestar',
        'decidirPedido',
        'executarOperacoes',
        'registrarManualReconciliar',
        'alterarRegras',
        'baixarDocumento',
        'exportarAuditoria',
      ]),
    );
    for (const acao of funcionais) {
      expect(nivelDeAcesso(['administradorGia'], acao), acao).toBe('total');
    }
  });

  it('não configura segredos, não libera escrita e não age como worker', () => {
    expect(ACOES_FORA_DO_ADMINISTRADOR_GIA).toEqual([
      'configurarSegredos',
      'liberarEscrita',
      'registrarResultadoOperacao',
    ]);
    for (const acao of ACOES_FORA_DO_ADMINISTRADOR_GIA) {
      expect(MATRIZ_PERMISSOES.administradorGia[acao]).toBeUndefined();
      expect(codigoErro(autorizar(['administradorGia'], acao))).toBe('PERMISSAO_NEGADA');
    }
  });

  it('percorre o fluxo inteiro (receber, aprovar, executar, registrar manual) com auditoria do próprio ator', () => {
    const ctx = ctxAdminGia();
    const recebido = valor(
      receberChamado(
        {
          chamado: chamado({ idExterno: 'RH-777' }),
          pedidoMesmaOrigem: null,
          colaboradorExistente: null,
          configuracao: configuracaoPadrao(),
          versaoRegras: 'regras-v1',
          itensSugeridos: itensSugeridos(['jira']),
        },
        ctx,
      ),
    );
    if (recebido.tipo !== 'criado') throw new Error('esperava pedido criado');
    for (const evento of recebido.eventos) {
      expect(evento.ator?.papeis).toEqual(['administradorGia']);
    }

    const aprovado = cenarioAprovado({ sistemas: ['jira'] });
    const execucao = valor(
      solicitarExecucao(
        {
          pedido: aprovado.pedido,
          revisao: aprovado.revisao,
          itens: aprovado.itens,
          operacoesExistentes: [],
          configuracao: configuracaoComEscrita(),
          modo: 'real',
        },
        aprovado.pedido.versao,
        ctx,
      ),
    );
    expect(execucao.eventos[0]?.ator).toMatchObject({ papeis: ['administradorGia'] });
    expect(execucao.operacoes[0]?.solicitadaPor).toMatchObject({ papeis: ['administradorGia'] });

    const manual = valor(
      registrarAcessoManual(
        {
          pedido: aprovado.pedido,
          item: aprovado.itens[0]!,
          observacao: 'grupo incluído pelo suporte do Jira',
        },
        aprovado.itens[0]!.versao,
        ctx,
      ),
    );
    expect(manual.eventos[0]?.ator).toMatchObject({ papeis: ['administradorGia'] });
  });

  it('continua sujeito ao gate de escrita: sem liberação, execução real é recusada', () => {
    const aprovado = cenarioAprovado({ sistemas: ['ad'] });
    const resultado = solicitarExecucao(
      {
        pedido: aprovado.pedido,
        revisao: aprovado.revisao,
        itens: aprovado.itens,
        operacoesExistentes: [],
        configuracao: configuracaoPadrao(),
        modo: 'real',
      },
      aprovado.pedido.versao,
      ctxAdminGia(),
    );
    expect(codigoErro(resultado)).toBe('ESCRITA_NAO_LIBERADA');
  });

  it('altera configuração funcional (sistemas por vínculo), com versão e auditoria', () => {
    const alterado = valor(
      alterarSistemasPorVinculo(
        configuracaoPadrao(),
        { vinculo: 'terceiro', sistemas: ['ad', 'jira'] },
        1,
        ctxAdminGia(),
      ),
    );
    expect(alterado.configuracao.sistemasPorVinculo.terceiro).toEqual(['ad', 'jira']);
    expect(alterado.eventos[0]).toMatchObject({
      tipo: 'configuracaoAlterada',
      ator: { papeis: ['administradorGia'] },
    });
  });
});
