import { describe, expect, it } from 'vitest';
import {
  PAPEIS_HUMANOS,
  chamadoJiraSchema,
  importacaoJiraSchema,
  itemParamsSchema,
  loginSimuladoSchema,
  pedidoParamsSchema,
  respostaErroSchema,
  respostaSucessoSchema,
} from './index.js';

const ID = '5e0f6a10-0000-4000-8000-000000000001';

const chamado = {
  key: 'RH-1001',
  fields: {
    tipoSolicitacao: 'Admissão - Celetista',
    nomeCompleto: '  Maria Ficticia  ',
    cpf: '000.000.000-00',
    matricula: '',
    emailCorporativo: 'maria@exemplo.com.br',
    area: 'Tecnologia',
    cargo: 'Analista',
    dataAdmissao: '2026-11-03',
    gestor: null,
    customfield_10099: 'descartado',
  },
};

describe('chamado do Jira', () => {
  it('normaliza texto, troca vazio por nulo e descarta campos desconhecidos', () => {
    const lido = chamadoJiraSchema.parse(chamado);
    expect(lido.fields.nomeCompleto).toBe('Maria Ficticia');
    expect(lido.fields.matricula).toBeNull();
    expect(lido.fields).not.toHaveProperty('customfield_10099');
  });

  it('recusa chave fora do formato, data inválida e campos obrigatórios ausentes', () => {
    expect(chamadoJiraSchema.safeParse({ ...chamado, key: 'rh 1001' }).success).toBe(false);
    expect(
      chamadoJiraSchema.safeParse({
        ...chamado,
        fields: { ...chamado.fields, dataAdmissao: '2026-02-30' },
      }).success,
    ).toBe(false);
    expect(
      chamadoJiraSchema.safeParse({ key: 'RH-1', fields: { tipoSolicitacao: 'x' } }).success,
    ).toBe(false);
  });
});

describe('entrada da API', () => {
  it('login simulado aceita só papéis humanos e nenhum outro campo', () => {
    expect(PAPEIS_HUMANOS).not.toContain('servicoExecutor');
    expect(loginSimuladoSchema.safeParse({ papel: 'administradorGia' }).success).toBe(true);
    expect(loginSimuladoSchema.safeParse({ papel: 'servicoExecutor' }).success).toBe(false);
    expect(loginSimuladoSchema.safeParse({ papel: 'revisor', nome: 'x' }).success).toBe(false);
  });

  it('importação não recebe parâmetros e rotas exigem UUID', () => {
    expect(importacaoJiraSchema.safeParse({}).success).toBe(true);
    expect(importacaoJiraSchema.safeParse({ jql: 'project = RH' }).success).toBe(false);
    expect(pedidoParamsSchema.safeParse({ pedidoId: ID }).success).toBe(true);
    expect(pedidoParamsSchema.safeParse({ pedidoId: '1' }).success).toBe(false);
    expect(itemParamsSchema.safeParse({ pedidoId: ID, itemId: 'x' }).success).toBe(false);
  });
});

describe('resposta (campos opcionais aditivos)', () => {
  it('sucesso pode listar todas as operações enfileiradas', () => {
    expect(
      respostaSucessoSchema.safeParse({
        ok: true,
        status: 'aprovado',
        versao: 3,
        operacaoId: ID,
        operacaoIds: [ID],
      }).success,
    ).toBe(true);
  });

  it('erro pode trazer detalhes', () => {
    expect(
      respostaErroSchema.safeParse({
        ok: false,
        codigo: 'CONFLITO_DE_VERSAO',
        mensagem: 'Recarregue.',
        detalhes: { versaoAtual: 3 },
      }).success,
    ).toBe(true);
  });
});
