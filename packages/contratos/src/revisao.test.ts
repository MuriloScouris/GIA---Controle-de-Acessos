import { describe, expect, it } from 'vitest';
import {
  ACOES_COMANDO,
  comandoSchema,
  parametrosAdSchema,
  parametrosDocusignSchema,
  parametrosJiraSchema,
  parametrosM365Schema,
  parametrosSoftexpertSchema,
} from './index.js';

const ID = '3f2b8c1e-6d4a-4b7e-9a21-5c8d0e7f1a23';
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
  paisUso: 'BR',
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

describe('correções da revisão (DEV-270)', () => {
  const base = { pedidoId: ID, versaoEsperada: 1, acao: 'editarProposta' };
  const item = (sistema: string, parametros: unknown) => ({
    sistema,
    parametros,
    origemSugestao: 'regra de área',
  });

  it('recusa item cujo sistema diverge de parametros.sistema', () => {
    rejeita(comandoSchema, { ...base, dados: { itens: [item('ad', jira)] } });
    rejeita(comandoSchema, { ...base, dados: { itens: [item('jira', ad)] } });
    rejeita(comandoSchema, { ...base, dados: { itens: [item('m365', docusign)] } });
    aceita(comandoSchema, { ...base, dados: { itens: [item('ad', ad), item('jira', jira)] } });
  });

  it('o tipo de Comando correlaciona acao e dados', () => {
    const r = comandoSchema.parse({
      pedidoId: ID,
      versaoEsperada: 1,
      acao: 'rejeitar',
      dados: { motivo: 'x' },
    });
    if (r.acao === 'rejeitar') expect(r.dados.motivo).toBe('x');
    // @ts-expect-error `itemId` não existe nos dados de `rejeitar`
    if (r.acao === 'rejeitar') expect(r.dados.itemId).toBeUndefined();
    expect(ACOES_COMANDO).toContain('reconciliar');
  });

  it('o schema de AD isolado recusa CPF com segredo colado', () => {
    rejeita(parametrosAdSchema, { ...ad, cpf: '52998224725 token=abc123' });
    rejeita(parametrosAdSchema, { ...ad, cpf: '529.982.247-25 senha=abc' });
    rejeita(parametrosAdSchema, { ...ad, cpf: '52998224725x' });
    aceita(parametrosAdSchema, { ...ad, cpf: '52998224725' });
  });

  it.each([
    ['ad', parametrosAdSchema, ad],
    ['m365', parametrosM365Schema, m365],
    ['docusign', parametrosDocusignSchema, docusign],
    ['softexpert', parametrosSoftexpertSchema, softexpert],
    ['jira', parametrosJiraSchema, jira],
  ] as const)('o schema de %s isolado recusa segredo embutido', (_n, schema, valido) => {
    rejeita(schema, { ...valido, nome: 'Maria password=abc123' });
    rejeita(schema, { ...valido, senha: 'x' });
  });

  it.each([
    'Bearer abc123def456@exemplo.test',
    'eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl@exemplo.test',
    'TOKEN=abc@exemplo.test',
  ])('recusa segredo em e-mail/UPN mesmo que a normalização o esconda: %s', (email) => {
    rejeita(parametrosJiraSchema, { ...jira, email });
    rejeita(parametrosAdSchema, { ...ad, upn: email });
    rejeita(parametrosM365Schema, { ...m365, upn: email });
  });

  it('normaliza e-mail legítimo em maiúsculas sem recusar', () => {
    expect(parametrosJiraSchema.parse({ ...jira, email: 'MARIA@EXEMPLO.TEST' }).email).toBe(
      'maria@exemplo.test',
    );
  });
});
