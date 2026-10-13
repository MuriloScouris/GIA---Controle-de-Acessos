import { MENSAGENS_ERRO } from '@gia/dominio';
import { describe, expect, it } from 'vitest';
import {
  CODIGOS_ERRO,
  codigoErroSchema,
  comandoSchema,
  comoParametrosDoDominio,
  paraResultadoDoDominio,
  parametrosAdSchema,
  parametrosDocusignSchema,
  parametrosJiraSchema,
  parametrosM365Schema,
  parametrosSistemaSchema,
  parametrosSoftexpertSchema,
  respostaSchema,
  resultadoConexaoSchema,
  resultadoExistenciaSchema,
  resultadoOperacaoSchema,
  resultadoValidacaoSchema,
  sistemaSchema,
} from './index.js';

const ID = '3f2b8c1e-6d4a-4b7e-9a21-5c8d0e7f1a23';
const ID2 = '7a9d4e52-1b3c-4f68-8c0d-2e5f6a7b8c91';
const aceita = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  expect(schema.safeParse(v).success).toBe(true);
const rejeita = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  expect(schema.safeParse(v).success).toBe(false);

const ad = {
  sistema: 'ad',
  login: 'maria.silva',
  upn: 'maria.silva@exemplo.test',
  email: 'maria.silva@exemplo.test',
  proxyAddresses: ['SMTP:maria.silva@exemplo.test'],
  nome: 'Maria',
  sobrenome: 'Silva',
  nomeExibicao: 'Maria Silva',
  ou: 'OU=Usuarios,DC=exemplo,DC=test',
  grupos: ['GRP-GERAL'],
  cargo: 'Analista',
  departamento: 'Financeiro',
  empresa: 'Empresa Exemplo',
  escritorio: null,
  scriptLogon: null,
  gerente: null,
  cpf: '529.982.247-25',
  controleConta: null,
};
const m365 = {
  sistema: 'm365',
  upn: 'maria.silva@exemplo.test',
  email: 'maria.silva@exemplo.test',
  nome: 'Maria Silva',
  planosLicenca: ['E3'],
  paisUso: 'br',
  grupo: null,
};
const docusign = {
  sistema: 'docusign',
  email: 'maria.silva@exemplo.test',
  nome: 'Maria Silva',
  empresa: 'Empresa Exemplo',
  cargo: 'Analista',
  perfil: 'Remetente',
  grupo: 'Financeiro',
  idioma: 'pt_BR',
  endereco: null,
};
const softexpert = {
  sistema: 'softexpert',
  identificador: '12345',
  login: 'maria.silva',
  nome: 'Maria Silva',
  email: 'maria.silva@exemplo.test',
  area: 'Financeiro',
  funcao: 'Analista',
  grupoAcesso: 'Padrao',
};
const jira = {
  sistema: 'jira',
  email: 'maria.silva@exemplo.test',
  nome: 'Maria Silva',
  grupos: ['jira-users'],
};

describe('parâmetros por sistema', () => {
  it.each([
    ['ad', parametrosAdSchema, ad],
    ['m365', parametrosM365Schema, m365],
    ['docusign', parametrosDocusignSchema, docusign],
    ['softexpert', parametrosSoftexpertSchema, softexpert],
    ['jira', parametrosJiraSchema, jira],
  ] as const)('aceita parâmetros válidos de %s e a união os discrimina', (_n, schema, valido) => {
    aceita(schema, valido);
    expect(parametrosSistemaSchema.parse(valido).sistema).toBe(valido.sistema);
  });

  it('normaliza e-mail e país', () => {
    const r = parametrosM365Schema.parse({ ...m365, email: ' MARIA@Exemplo.Test ' });
    expect(r.email).toBe('maria@exemplo.test');
    expect(r.paisUso).toBe('BR');
  });

  it('é atribuível aos tipos do domínio', () => {
    expect(comoParametrosDoDominio(parametrosSistemaSchema.parse(jira)).sistema).toBe('jira');
  });

  it('rejeita campo faltando, e-mail e CPF inválidos', () => {
    rejeita(parametrosAdSchema, { ...ad, login: undefined });
    rejeita(parametrosAdSchema, { ...ad, email: 'nao-e-email' });
    rejeita(parametrosAdSchema, { ...ad, cpf: '111.111.111-11' });
    rejeita(parametrosAdSchema, { ...ad, login: 'a'.repeat(21) });
    rejeita(parametrosM365Schema, { ...m365, paisUso: 'BRA' });
    rejeita(parametrosJiraSchema, { ...jira, grupos: [''] });
  });

  it('rejeita sistema desconhecido ou parâmetros de outro sistema', () => {
    rejeita(parametrosSistemaSchema, { ...jira, sistema: 'outro' });
    rejeita(parametrosSistemaSchema, { ...jira, sistema: 'ad' });
  });

  it.each(['senha', 'password', 'token', 'segredo'])('rejeita campo secreto "%s"', (campo) => {
    rejeita(parametrosSistemaSchema, { ...ad, [campo]: 'x' });
    rejeita(parametrosSistemaSchema, { ...m365, [campo]: 'x' });
  });

  it('rejeita segredo embutido em texto e campo de criação de usuário no M365', () => {
    rejeita(parametrosSistemaSchema, { ...ad, cargo: 'senha=abc123' });
    rejeita(parametrosM365Schema, { ...m365, criarUsuario: true });
  });

  it('sistemaSchema conhece só os cinco sistemas', () => {
    for (const s of ['ad', 'm365', 'docusign', 'softexpert', 'jira']) aceita(sistemaSchema, s);
    rejeita(sistemaSchema, 'sap');
  });
});

describe('comando', () => {
  const base = { pedidoId: ID, versaoEsperada: 3 };

  it.each([
    { acao: 'aprovar', dados: {} },
    { acao: 'recalcularIdentidade', dados: {} },
    { acao: 'rejeitar', dados: { motivo: 'Dados incompletos' } },
    { acao: 'reabrir', dados: { motivo: 'Correção solicitada' } },
    { acao: 'solicitarExecucao', dados: {} },
    { acao: 'solicitarExecucao', dados: { itemIds: [ID2] } },
    { acao: 'conferirExistencia', dados: { itemIds: [ID2] } },
    { acao: 'registrarAcessoManual', dados: { itemId: ID2, observacao: 'Feito pelo suporte' } },
    { acao: 'reconciliar', dados: { itemId: ID2, desfecho: 'parcial' } },
    {
      acao: 'editarProposta',
      dados: {
        identidade: {
          login: 'maria.silva',
          email: 'maria.silva@exemplo.test',
          nomeExibicao: 'Maria',
        },
        itens: [{ sistema: 'jira', parametros: jira, origemSugestao: 'regra de área' }],
      },
    },
  ])('aceita comando válido: $acao', (c) => aceita(comandoSchema, { ...base, ...c }));

  it('rejeita campos obrigatórios ausentes ou inválidos', () => {
    rejeita(comandoSchema, { acao: 'aprovar', dados: {}, versaoEsperada: 1 });
    rejeita(comandoSchema, { pedidoId: ID, acao: 'aprovar', dados: {} });
    rejeita(comandoSchema, { ...base, pedidoId: 'abc', acao: 'aprovar', dados: {} });
    rejeita(comandoSchema, { ...base, versaoEsperada: 0, acao: 'aprovar', dados: {} });
    rejeita(comandoSchema, { ...base, versaoEsperada: 1.5, acao: 'aprovar', dados: {} });
    rejeita(comandoSchema, { ...base, acao: 'apagarTudo', dados: {} });
  });

  it('rejeita dados fora do permitido para a ação', () => {
    rejeita(comandoSchema, { ...base, acao: 'aprovar', dados: { motivo: 'x' } });
    rejeita(comandoSchema, { ...base, acao: 'rejeitar', dados: {} });
    rejeita(comandoSchema, { ...base, acao: 'rejeitar', dados: { motivo: '   ' } });
    rejeita(comandoSchema, {
      ...base,
      acao: 'reconciliar',
      dados: { itemId: ID2, desfecho: 'ok' },
    });
    rejeita(comandoSchema, { ...base, acao: 'solicitarExecucao', dados: { itemIds: [] } });
  });

  it('rejeita o ator vindo do cliente, em qualquer nível (regra 13)', () => {
    rejeita(comandoSchema, { ...base, acao: 'aprovar', dados: {}, ator: 'x' });
    rejeita(comandoSchema, { ...base, acao: 'aprovar', dados: { aprovadoPor: 'x' } });
    const r = comandoSchema.safeParse({ ...base, acao: 'aprovar', dados: {}, atorId: ID2 });
    expect(r.success).toBe(false);
  });

  it('rejeita segredo no texto livre (regra 12)', () => {
    rejeita(comandoSchema, { ...base, acao: 'rejeitar', dados: { motivo: 'token: abc123' } });
  });
});

describe('resposta', () => {
  it('aceita sucesso com e sem operação', () => {
    aceita(respostaSchema, { ok: true, status: 'aprovado', versao: 4, operacaoId: null });
    aceita(respostaSchema, { ok: true, status: 'emExecucao', versao: 5, operacaoId: ID });
  });

  it('aceita erro com código estável e mensagem em português', () => {
    aceita(respostaSchema, {
      ok: false,
      codigo: 'CONFLITO_DE_VERSAO',
      mensagem: MENSAGENS_ERRO.CONFLITO_DE_VERSAO,
    });
  });

  it('os códigos de erro são exatamente os do domínio', () => {
    expect(CODIGOS_ERRO).toEqual(Object.keys(MENSAGENS_ERRO));
    for (const codigo of CODIGOS_ERRO) aceita(codigoErroSchema, codigo);
    rejeita(codigoErroSchema, 'ERRO_QUALQUER');
  });

  it('rejeita status, versão, código e mensagem inválidos', () => {
    rejeita(respostaSchema, { ok: true, status: 'feito', versao: 1, operacaoId: null });
    rejeita(respostaSchema, { ok: true, status: 'aprovado', versao: 0, operacaoId: null });
    rejeita(respostaSchema, { ok: true, status: 'aprovado', versao: 1, operacaoId: 'x' });
    rejeita(respostaSchema, { ok: false, codigo: 'NOVO', mensagem: 'x' });
    rejeita(respostaSchema, { ok: false, codigo: 'DADO_INVALIDO', mensagem: '' });
    rejeita(respostaSchema, { ok: true, status: 'aprovado', versao: 1 });
  });
});

describe('resultado de conector', () => {
  const operacao = {
    sistema: 'ad',
    efeito: 'parcial',
    modo: 'real',
    etapa: 'habilitarConta',
    codigo: 'GRUPO_FALHOU',
    referenciaExterna: 'CN=maria.silva',
    mensagem: 'Conta criada; grupo não adicionado.',
    transitorio: false,
    tentarAposMs: null,
  };

  it.each(['confirmado', 'parcial', 'semEfeito', 'desconhecido'])('aceita efeito %s', (efeito) => {
    aceita(resultadoOperacaoSchema, { ...operacao, efeito });
  });

  it('aceita modo simulado e etapa nula', () => {
    aceita(resultadoOperacaoSchema, { ...operacao, modo: 'simulado', etapa: null });
  });

  it('rejeita efeito, modo, etapa e campos inválidos', () => {
    rejeita(resultadoOperacaoSchema, { ...operacao, efeito: 'sucesso' });
    rejeita(resultadoOperacaoSchema, { ...operacao, modo: 'teste' });
    rejeita(resultadoOperacaoSchema, { ...operacao, etapa: 'etapaInventada' });
    rejeita(resultadoOperacaoSchema, { ...operacao, codigo: '' });
    rejeita(resultadoOperacaoSchema, { ...operacao, tentarAposMs: -1 });
    rejeita(resultadoOperacaoSchema, { ...operacao, senha: 'x' });
    rejeita(resultadoOperacaoSchema, { ...operacao, sistema: undefined });
  });

  it('sanitiza mensagem, código e referência (regra 12)', () => {
    const r = resultadoOperacaoSchema.parse({
      ...operacao,
      mensagem: 'falha com senha=abc123 e Bearer eyJabcde.fghijk.lmnopq',
      referenciaExterna: 'token=xyz',
    });
    expect(r.mensagem).not.toMatch(/abc123|eyJ/);
    expect(r.referenciaExterna).not.toMatch(/xyz/);
  });

  it('converte para o resultado do domínio sem o campo sistema', () => {
    const dominio = paraResultadoDoDominio(resultadoOperacaoSchema.parse(operacao));
    expect(dominio).not.toHaveProperty('sistema');
    expect(dominio.efeito).toBe('parcial');
  });

  it('valida conexão, validação e existência', () => {
    aceita(resultadoConexaoSchema, {
      sistema: 'jira',
      modo: 'simulado',
      disponivel: true,
      codigo: 'OK',
      mensagem: 'Conectado',
    });
    aceita(resultadoValidacaoSchema, {
      sistema: 'ad',
      modo: 'real',
      impedimentos: [{ codigo: 'LOGIN_EM_USO', mensagem: 'Login em uso' }],
      avisos: [],
    });
    aceita(resultadoExistenciaSchema, {
      sistema: 'ad',
      modo: 'real',
      contaExiste: true,
      acessosEncontrados: ['grupo:grp-geral'],
      etapaComprovada: 'habilitarConta',
      referenciaExterna: null,
      conferidaEm: '2026-10-13T12:00:00.000Z',
    });
    rejeita(resultadoConexaoSchema, { sistema: 'jira', modo: 'real', disponivel: 'sim' });
    rejeita(resultadoValidacaoSchema, {
      sistema: 'ad',
      modo: 'real',
      impedimentos: [{}],
      avisos: [],
    });
    rejeita(resultadoExistenciaSchema, {
      sistema: 'ad',
      modo: 'real',
      contaExiste: true,
      acessosEncontrados: [],
      etapaComprovada: null,
      referenciaExterna: null,
      conferidaEm: '13/10/2026',
    });
  });
});
