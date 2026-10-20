import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VariaveisAmbiente } from '@gia/contratos';
import { resolverSegredosDeArquivo } from '@gia/contratos/segredos';
import { POLITICA_EXECUCAO_PADRAO, SISTEMAS, type PoliticaExecucao } from '@gia/dominio';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { contexto, paramsDocusign } from './teste/fabricas.js';
import { penduradoAteAbortar } from './teste/pendurado.js';
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

describe('política de timeout do DocuSign na composição (M5)', () => {
  const ID = '00000000-0000-4000-8000-000000000001';
  let pasta: string;
  let base: VariaveisAmbiente;
  beforeAll(async () => {
    pasta = await mkdtemp(join(tmpdir(), 'gia-docusign-'));
    const chave = join(pasta, 'chave.pem');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await writeFile(join(pasta, 'segredo'), 'segredo-ficticio');
    await writeFile(chave, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    base = {
      GIA_AMBIENTE: 'teste',
      GIA_DOCUSIGN_MODO: 'real',
      GIA_DOCUSIGN_AMBIENTE: 'demo',
      GIA_DOCUSIGN_INTEGRACAO_ID: ID,
      GIA_DOCUSIGN_USUARIO_ID: ID,
      GIA_DOCUSIGN_CONTA_ID: ID,
      GIA_DOCUSIGN_CHAVE_PRIVADA_ARQUIVO: chave,
    };
    // Gerar a chave RSA é CPU puro e síncrono: sob carga passou dos 10 s do hook. Prazo só deste hook.
  }, 60_000);
  afterAll(async () => {
    await rm(pasta, { recursive: true, force: true });
  });

  const politica = (timeoutChamadaMs: number): PoliticaExecucao => ({
    ...POLITICA_EXECUCAO_PADRAO,
    timeoutChamadaMs,
    timeoutConexaoMs: Math.min(POLITICA_EXECUCAO_PADRAO.timeoutConexaoMs, timeoutChamadaMs),
  });

  /** Transporte que nunca responde: só termina quando o sinal é abortado. */
  function transportePendurado() {
    const sinais: AbortSignal[] = [];
    const enviar = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal) sinais.push(init.signal);
      return penduradoAteAbortar(init?.signal);
    });
    return { enviar, sinais };
  }

  it('o cliente respeita o prazo do motor mesmo com o padrão de 20 s', async () => {
    const { enviar, sinais } = transportePendurado();
    const { reais } = await criarIntegracoesDoAmbiente(base, politica(700), undefined, {
      fetch: enviar,
    });
    const inicio = Date.now();
    const falha = reais.docusign!.conferirExistencia(contexto(paramsDocusign()));
    // Limite interno = 700 - 100 ms: bem antes dos 20 s do padrão e sem passar do motor.
    await expect(falha).rejects.toMatchObject({ tipo: 'timeout' });
    expect(Date.now() - inicio).toBeLessThan(2_000);
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(sinais.every((s) => s.aborted)).toBe(true);
  });

  it('um timeout configurado menor que o prazo do motor continua valendo', async () => {
    const { enviar } = transportePendurado();
    const { reais } = await criarIntegracoesDoAmbiente(
      { ...base, GIA_DOCUSIGN_TIMEOUT_MS: '150' },
      politica(30_000),
      undefined,
      { fetch: enviar },
    );
    const inicio = Date.now();
    await expect(
      reais.docusign!.conferirExistencia(contexto(paramsDocusign())),
    ).rejects.toMatchObject({ tipo: 'timeout' });
    expect(Date.now() - inicio).toBeLessThan(2_000);
  });

  it('valor fora do contrato do cliente é recusado na composição, sem clamp silencioso', async () => {
    // 30000 passa de 25000 (máximo do cliente): antes o limitar() o reduzia ao prazo do motor.
    for (const invalido of ['30000', '1e3', ' 500', '12.5']) {
      const env = { ...base, GIA_DOCUSIGN_TIMEOUT_MS: invalido };
      await expect(criarIntegracoesDoAmbiente(env, politica(30_000))).rejects.toThrow(
        'GIA_DOCUSIGN_TIMEOUT_MS',
      );
      await expect(criarLeiturasDoAmbiente(env, politica(30_000))).rejects.toThrow(
        'GIA_DOCUSIGN_TIMEOUT_MS',
      );
    }
  });

  it('não regride os demais conectores: o limitar() continua valendo para M365 e SoftExpert', async () => {
    const m365 = {
      GIA_M365_MODO: 'real',
      GIA_M365_TENANT_ID: ID,
      GIA_M365_CLIENT_ID: ID,
      GIA_M365_CLIENT_SECRET_ARQUIVO: join(pasta, 'segredo'),
    };
    // Mesmo valor que o cliente M365 recusaria isoladamente (30000) é reduzido ao prazo do motor.
    await expect(
      criarIntegracoesDoAmbiente(
        { GIA_AMBIENTE: 'teste', ...m365, GIA_M365_TIMEOUT_MS: '30000' },
        politica(30_000),
      ),
    ).resolves.toBeDefined();
  });
});
