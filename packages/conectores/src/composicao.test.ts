import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type VariaveisAmbiente } from '@gia/contratos';
import { resolverSegredosDeArquivo } from '@gia/contratos/segredos';
import { SISTEMAS } from '@gia/dominio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  carregarSelecaoIntegracoes,
  criarIntegracoesDoAmbiente,
  criarLeiturasDoAmbiente,
} from './composicao.js';

it('desenvolvimento fica simulado e configuração real parcial falha sem fallback', async () => {
  expect(carregarSelecaoIntegracoes({})).toEqual([]);
  expect((await criarIntegracoesDoAmbiente({})).reais).toEqual({});
  await expect(criarIntegracoesDoAmbiente({ GIA_AD_MODO: 'real' })).rejects.toThrow('GIA_AD_URL');
});

it('recusa seletores desconhecidos, escrita sem transporte e opt-in local sem gate', () => {
  for (const env of [
    { GIA_M365_MODO: 'REAL' },
    { GIA_AMBIENTE: 'teste', GIA_ESCRITA_EXTERNA: 'true', GIA_ESCRITA_LIBERADA: 'ad:criar' },
    { GIA_JIRA_MODO: 'real', GIA_JIRA_ESCRITA_HABILITADA: 'true' },
    { GIA_DOCUSIGN_ESCRITA_HABILITADA: 'yes' },
  ])
    expect(() => carregarSelecaoIntegracoes(env)).toThrow();
});

describe('criarLeiturasDoAmbiente (privilégio mínimo da API)', () => {
  let pasta: string;
  let env: VariaveisAmbiente;
  const ID = '00000000-0000-4000-8000-000000000001';
  beforeAll(async () => {
    pasta = await mkdtemp(join(tmpdir(), 'gia-leituras-'));
    const segredo = join(pasta, 'segredo');
    await writeFile(segredo, 'segredo-ficticio');
    // Chave DocuSign e senha SoftExpert apontam para arquivos que não existem:
    // a API não pode depender deles (nem lê-los).
    const ausente = join(pasta, 'nao-existe');
    env = await resolverSegredosDeArquivo({
      GIA_AMBIENTE: 'teste',
      ...Object.fromEntries(SISTEMAS.map((s) => [`GIA_${s.toUpperCase()}_MODO`, 'real'])),
      GIA_AD_URL: 'ldaps://127.0.0.1:6369',
      GIA_AD_BIND_DN: 'CN=Servico,DC=teste,DC=local',
      GIA_AD_BASE_DN: 'DC=teste,DC=local',
      GIA_AD_OU_INATIVOS: 'OU=Inativos,DC=teste,DC=local',
      GIA_AD_SENHA_ARQUIVO: segredo,
      GIA_M365_TENANT_ID: ID,
      GIA_M365_CLIENT_ID: ID,
      GIA_M365_CLIENT_SECRET_ARQUIVO: segredo,
      GIA_DOCUSIGN_AMBIENTE: 'demo',
      GIA_DOCUSIGN_INTEGRACAO_ID: ID,
      GIA_DOCUSIGN_USUARIO_ID: ID,
      GIA_DOCUSIGN_CONTA_ID: ID,
      GIA_DOCUSIGN_CHAVE_PRIVADA_ARQUIVO: ausente,
      GIA_SOFTEXPERT_URL: 'https://se.example.invalid',
      GIA_SOFTEXPERT_AUTENTICACAO: 'contaServico',
      GIA_SOFTEXPERT_USUARIO_SERVICO: 'servico',
      GIA_SOFTEXPERT_SENHA_SERVICO_ARQUIVO: ausente,
      GIA_JIRA_BASE_URL: 'https://jira.example.invalid',
      GIA_JIRA_EMAIL: 'servico@example.invalid',
      GIA_JIRA_API_TOKEN_ARQUIVO: segredo,
      GIA_JIRA_ORIGEM_JSON: JSON.stringify({
        projeto: 'RH',
        tipos: { celetista: 'Efetivo', terceiro: 'Externo' },
        campos: {
          tipoSolicitacao: 'tipo',
          nomeCompleto: 'nome',
          cpf: 'cpf',
          matricula: 'matricula',
          emailCorporativo: 'email',
          area: 'area',
          cargo: 'cargo',
          dataAdmissao: 'data',
          gestor: 'gestor',
        },
      }),
    });
  });
  afterAll(async () => {
    await rm(pasta, { recursive: true, force: true });
  });

  it('monta diretório e origem Jira sem abrir a chave DocuSign nem a senha SoftExpert', async () => {
    const leituras = await criarLeiturasDoAmbiente(env);
    expect(leituras.diretorio).toBeDefined();
    expect(leituras.jiraOrigem).toBeDefined();
    expect(Object.keys(leituras).sort()).toEqual(['diretorio', 'jiraOrigem']);
    // A composição completa (worker) precisa delas e recusa.
    await expect(criarIntegracoesDoAmbiente(env)).rejects.toThrow(
      'GIA_DOCUSIGN_CHAVE_PRIVADA_ARQUIVO',
    );
  });

  it('continua validando a configuração de todo sistema selecionado', async () => {
    await expect(criarLeiturasDoAmbiente({ ...env, GIA_DOCUSIGN_CONTA_ID: '' })).rejects.toThrow(
      'GIA_DOCUSIGN_CONTA_ID',
    );
    await expect(criarLeiturasDoAmbiente({ ...env, GIA_SOFTEXPERT_URL: '' })).rejects.toThrow(
      'GIA_SOFTEXPERT_URL',
    );
  });

  it('com só um dos dois do diretório real, nenhum segredo de diretório é aberto', async () => {
    const leituras = await criarLeiturasDoAmbiente({
      GIA_AMBIENTE: 'teste',
      GIA_AD_MODO: 'real',
      GIA_AD_URL: 'ldaps://127.0.0.1:6369',
      GIA_AD_BIND_DN: 'CN=Servico,DC=teste,DC=local',
      GIA_AD_BASE_DN: 'DC=teste,DC=local',
      GIA_AD_OU_INATIVOS: 'OU=Inativos,DC=teste,DC=local',
      GIA_AD_SENHA_ARQUIVO: join(pasta, 'nao-existe'),
    });
    expect(leituras.diretorio).toBeUndefined();
  });
});
