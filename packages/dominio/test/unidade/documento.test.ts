import { describe, expect, it } from 'vitest';
import {
  consolidarPedido,
  emitirDocumentoDeAcessos,
  etapasDe,
  registrarResultadoOperacao,
  POLITICA_EXECUCAO_PADRAO,
  type ItemAcesso,
  type Sistema,
} from '../../src/index.js';
import {
  AGORA,
  cenarioEmExecucao,
  codigoErro,
  contexto,
  ctxExecutor,
  ctxRevisor,
  ctxServico,
  itemDo,
  operacaoDo,
  reservar,
  resultadoConector,
  valor,
} from '../apoio/fabricas.js';

/** Pedido concluído pelo caminho real: cada item confirmado pelo serviço executor. */
function concluido(sistemas: readonly Sistema[], manuais: readonly Sistema[] = []) {
  const cenario = cenarioEmExecucao({ sistemas });
  const itens: ItemAcesso[] = [];
  const operacoes = [];
  for (const sistema of sistemas) {
    const item = itemDo(cenario.itens, sistema);
    if (manuais.includes(sistema)) {
      itens.push({ ...item, status: 'registradoManual', observacaoManual: 'Feito no portal.' });
      continue;
    }
    const registrado = valor(
      registrarResultadoOperacao(
        {
          operacao: reservar(operacaoDo(cenario.operacoes, item)),
          item,
          resultado: resultadoConector({
            etapa: etapasDe(sistema, 'provisionar').at(-1) ?? null,
            referenciaExterna: `ext-${sistema}`,
          }),
        },
        POLITICA_EXECUCAO_PADRAO,
        ctxServico(),
      ),
    );
    itens.push(registrado.item);
    operacoes.push(registrado.operacao);
  }
  const consolidado = valor(
    consolidarPedido({ pedido: cenario.pedido, itens, operacoes }, ctxServico()),
  );
  return { ...cenario, pedido: consolidado.pedido, itens };
}

describe('documento de acessos (funcionalidade 10)', () => {
  it('leva só os acessos confirmados e a identidade efetiva, sem CPF nem matrícula', () => {
    const c = concluido(['ad', 'jira'], ['jira']);
    expect(c.pedido.status).toBe('concluido');
    const { documento, evento } = valor(
      emitirDocumentoDeAcessos(
        {
          pedido: c.pedido,
          revisao: c.revisao,
          colaborador: c.colaborador,
          itens: c.itens,
          formato: 'docx',
        },
        ctxExecutor(),
      ),
    );
    expect(documento.acessos.map((a) => a.sistema)).toEqual(['ad']);
    expect(documento.acessos[0]).toMatchObject({
      nomeSistema: 'Active Directory',
      confirmadoEm: AGORA,
    });
    expect(documento.acessos[0]?.acessos[0]).toBe('conta');
    expect(documento.origem).toBe(`jira:${c.pedido.origem.idExterno.toUpperCase()}`);
    expect(documento.identidade.login).toBe(c.revisao.identidade?.login);
    expect(documento.emitidoPor).toBe(ctxExecutor().ator.nome);
    const texto = JSON.stringify(documento);
    expect(texto).not.toContain(c.pedido.dadosRh.cpf);
    if (c.pedido.dadosRh.matricula !== null)
      expect(texto).not.toContain(c.pedido.dadosRh.matricula);

    // A emissão é auditada, com o ator da sessão e sem dado pessoal.
    expect(evento).toMatchObject({
      tipo: 'documentoEmitido',
      pedidoId: c.pedido.id,
      colaboradorId: c.pedido.colaboradorId,
      ator: { id: ctxExecutor().ator.id },
      dados: { formato: 'docx', sistemas: ['ad'], versaoPedido: c.pedido.versao },
    });
    expect(JSON.stringify(evento)).not.toContain(c.pedido.dadosRh.cpf);
  });

  it('só quem pode baixar documento emite (revisor, executor, Administrador do Gia)', () => {
    const c = concluido(['ad']);
    const entrada = {
      pedido: c.pedido,
      revisao: c.revisao,
      colaborador: c.colaborador,
      itens: c.itens,
      formato: 'docx' as const,
    };
    for (const ctx of [ctxRevisor(), ctxExecutor(), contexto(['administradorGia'])]) {
      expect(emitirDocumentoDeAcessos(entrada, ctx).ok).toBe(true);
    }
    for (const papel of ['solicitante', 'auditor', 'administradorTecnico'] as const) {
      expect(codigoErro(emitirDocumentoDeAcessos(entrada, contexto([papel])))).toBe(
        'PERMISSAO_NEGADA',
      );
    }
  });

  it('pedido não concluído ou revisão que não é a aprovada corrente não emite', () => {
    const emExecucao = cenarioEmExecucao({ sistemas: ['ad'] });
    expect(
      codigoErro(
        emitirDocumentoDeAcessos(
          {
            pedido: emExecucao.pedido,
            revisao: emExecucao.revisao,
            colaborador: emExecucao.colaborador,
            itens: emExecucao.itens,
            formato: 'docx',
          },
          ctxExecutor(),
        ),
      ),
    ).toBe('DOCUMENTO_INDISPONIVEL');
    const c = concluido(['ad']);
    expect(
      codigoErro(
        emitirDocumentoDeAcessos(
          {
            pedido: c.pedido,
            revisao: null,
            colaborador: c.colaborador,
            itens: c.itens,
            formato: 'docx',
          },
          ctxExecutor(),
        ),
      ),
    ).toBe('DOCUMENTO_INDISPONIVEL');
  });
});

describe('documento de acessos: identificadores pessoais (revisão da PR #10)', () => {
  it('SoftExpert confirmado com CPF ou matrícula como referência: nada disso entra no documento', () => {
    for (const usarCpf of [true, false]) {
      const base = concluido(['softexpert']);
      const cpf = base.pedido.dadosRh.cpf;
      const matricula = 'M778899';
      const formatado = `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
      const c = {
        ...base,
        pedido: {
          ...base.pedido,
          // O RH colou o CPF no nome: o documento não pode repetir.
          dadosRh: { ...base.pedido.dadosRh, matricula, nomeCompleto: `Ana Souza ${formatado}` },
        },
        // O adaptador do SoftExpert devolve o identificador (matrícula ?? CPF) como referência.
        itens: base.itens.map((item) => ({ ...item, idExterno: usarCpf ? cpf : matricula })),
        revisao: {
          ...base.revisao,
          identidade:
            base.revisao.identidade === null
              ? null
              : { ...base.revisao.identidade, nomeExibicao: `Ana ${matricula}` },
        },
      };
      const { documento } = valor(
        emitirDocumentoDeAcessos(
          {
            pedido: c.pedido,
            revisao: c.revisao,
            colaborador: c.colaborador,
            itens: c.itens,
            formato: 'docx',
          },
          ctxExecutor(),
        ),
      );
      const texto = JSON.stringify(documento);
      for (const proibido of [cpf, formatado, matricula]) {
        expect(texto, proibido).not.toContain(proibido);
      }
      expect(documento.acessos.map((a) => a.sistema)).toEqual(['softexpert']);
      expect(Object.keys(documento.acessos[0]!).sort()).toEqual([
        'acessos',
        'confirmadoEm',
        'nomeSistema',
        'sistema',
      ]);
    }
  });
});
