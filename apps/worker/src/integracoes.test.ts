import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  carregarGatesDeEscrita,
  type VariaveisAmbiente,
} from '@gia/contratos';
import { resolverSegredosDeArquivo } from '@gia/contratos/segredos';
import { POLITICA_EXECUCAO_PADRAO, SISTEMAS } from '@gia/dominio';
import { criarPersistenciaPostgres } from '@gia/persistencia';
import { criarBancoDeTeste, TEM_BANCO, TEMPO_BANCO_MS } from '@gia/persistencia/teste';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { aplicarGatesDeEscrita } from './gates.js';
import { criarExecutor } from './executor.js';
import { montarConectores } from './index.js';
import { conectoresReaisDoAmbiente } from './reais.js';
import { smokeIntegracoes } from './smoke.js';
import { cenario, gravar, INICIO, operacao } from './teste/fabricas.js';

let pasta: string;
let env: VariaveisAmbiente;
const ID = '00000000-0000-4000-8000-000000000001';
beforeAll(async () => {
  pasta = await mkdtemp(join(tmpdir(), 'gia-composicao-'));
  const segredo = join(pasta, 'segredo');
  const chave = join(pasta, 'rsa');
  await writeFile(segredo, 'segredo-ficticio');
  await writeFile(
    chave,
    generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }),
  );
  env = {
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
    GIA_DOCUSIGN_CHAVE_PRIVADA_ARQUIVO: chave,
    GIA_SOFTEXPERT_URL: 'https://se.example.invalid',
    GIA_SOFTEXPERT_AUTENTICACAO: 'contaServico',
    GIA_SOFTEXPERT_USUARIO_SERVICO: 'servico',
    GIA_SOFTEXPERT_SENHA_SERVICO_ARQUIVO: segredo,
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
  };
});
afterAll(async () => {
  await rm(pasta, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllGlobals());

it.skipIf(!process.env['GIA_AD_TESTE_URL'])(
  'smoke usa a composição AD real e autentica no Samba descartável, sem escrita',
  async () => {
    const ambiente: Record<string, string | undefined> = {
      GIA_AMBIENTE: 'teste',
      GIA_AD_MODO: 'real',
    };
    for (const sufixo of [
      'URL',
      'BIND_DN',
      'SENHA_ARQUIVO',
      'BASE_DN',
      'CA_ARQUIVO',
      'TLS_NOME_SERVIDOR',
    ])
      ambiente[`GIA_AD_${sufixo}`] = process.env[`GIA_AD_TESTE_${sufixo}`];
    ambiente['GIA_AD_OU_INATIVOS'] = `OU=Inativos,${ambiente['GIA_AD_BASE_DN']}`;
    const r = await smokeIntegracoes(ambiente);
    expect(r.sistemas.find((s) => s.sistema === 'ad')).toEqual({
      sistema: 'ad',
      status: 'disponivel',
      codigo: 'OK',
    });
    expect(r.validado).toBe(false); // demais destinos não estão configurados.
    expect(r.escritaExterna).toBe(false);
  },
);

it('prazo total impede um POST tardio mesmo se uma leitura não respeitar cancelamento', async () => {
  const enviar = vi.fn<typeof fetch>().mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 350));
    return Response.json([]);
  });
  vi.stubGlobal('fetch', enviar);
  const ligado = {
    ...env,
    GIA_ESCRITA_EXTERNA: 'true',
    GIA_ESCRITA_LIBERADA: 'jira:criar',
    GIA_JIRA_ESCRITA_HABILITADA: 'true',
  };
  const reais = await conectoresReaisDoAmbiente(await resolverSegredosDeArquivo(ligado), {
    ...POLITICA_EXECUCAO_PADRAO,
    timeoutChamadaMs: 300,
  });
  const item = cenario(['jira']).itens.jira!;
  expect(
    await reais.jira!.provisionar({
      operacaoId: randomUUID(),
      itemId: item.id,
      parametros: item.parametros,
      chaveIdempotencia: 'prazo:1',
      etapaInicial: null,
      modo: 'real',
    }),
  ).toMatchObject({ efeito: 'desconhecido' });
  await new Promise((r) => setTimeout(r, 200));
  expect(enviar.mock.calls.some(([, i]) => i?.method !== 'GET')).toBe(false);
});

it('monta os cinco reais sem rede, e smoke de configuração não confunde montagem com validação', async () => {
  const enviar = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', enviar);
  const resolvido = await resolverSegredosDeArquivo(env);
  const reais = await conectoresReaisDoAmbiente(resolvido, POLITICA_EXECUCAO_PADRAO);
  expect(Object.keys(reais).sort()).toEqual([...SISTEMAS].sort());
  const r = await smokeIntegracoes(env, true);
  expect(r.validado).toBe(false);
  expect(r.escritaExterna).toBe(false);
  expect(r.sistemas.every((s) => s.status === 'configurado')).toBe(true);
  expect(enviar).not.toHaveBeenCalled();
});

it('smoke autentica nos quatro HTTP reais, só lê e informa indisponibilidade sem cair no simulador', async () => {
  const enviar = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response('', { status: 401 }));
  vi.stubGlobal('fetch', enviar);
  const r = await smokeIntegracoes({ ...env, GIA_AD_MODO: 'simulado' });
  expect(r.validado).toBe(false);
  expect(r.sistemas.filter((s) => s.status === 'indisponivel')).toHaveLength(4);
  expect(r.sistemas.find((s) => s.sistema === 'ad')?.status).toBe('naoConfigurado');
  expect(enviar.mock.calls).toHaveLength(4);
  expect(enviar.mock.calls.map(([u]) => new URL(String(u)).hostname).sort()).toEqual([
    'account-d.docusign.com',
    'jira.example.invalid',
    'login.microsoftonline.com',
    'se.example.invalid',
  ]);
  // POSTs aqui são autenticação JWT/client credentials ou SOAP getUserData, nunca escrita.
  expect(
    enviar.mock.calls.filter(([, i]) => i?.method === 'DELETE' || i?.method === 'PATCH'),
  ).toEqual([]);
});

it('com reais configurados, gate desligado bloqueia fila real e operações simuladas ficam em memória', async () => {
  const enviar = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', enviar);
  const reais = await conectoresReaisDoAmbiente(
    await resolverSegredosDeArquivo(env),
    POLITICA_EXECUCAO_PADRAO,
  );
  const conectores = aplicarGatesDeEscrita(
    montarConectores(POLITICA_EXECUCAO_PADRAO).conectores,
    reais,
    carregarGatesDeEscrita(env),
  );
  const c = cenario(['jira']);
  const item = c.itens.jira!;
  const ctx = {
    operacaoId: randomUUID(),
    itemId: item.id,
    parametros: item.parametros,
    chaveIdempotencia: 'composicao:1',
    etapaInicial: null,
    modo: 'real' as const,
  };
  expect(await conectores.jira.provisionar(ctx)).toMatchObject({
    codigo: 'ESCRITA_NAO_LIBERADA',
    modo: 'real',
  });
  expect(await conectores.jira.provisionar({ ...ctx, modo: 'simulado' })).toMatchObject({
    modo: 'simulado',
  });
  expect(enviar).not.toHaveBeenCalled();
});

it('segredo inline é recusado em produção inclusive junto de caminho ou conector desativado', async () => {
  for (const nome of [
    'GIA_JIRA_API_TOKEN',
    'GIA_M365_CLIENT_SECRET',
    'GIA_DOCUSIGN_TOKEN',
    'GIA_AD_SENHA',
    'GIA_SOFTEXPERT_TOKEN',
  ]) {
    await expect(
      smokeIntegracoes(
        { GIA_AMBIENTE: 'producao', [nome]: 'ficticio', [`${nome}_ARQUIVO`]: '/inexistente' },
        true,
      ),
    ).rejects.toThrow(nome);
  }
  await expect(
    smokeIntegracoes({ ...env, GIA_AD_SENHA_ARQUIVO: join(pasta, 'ausente') }, true),
  ).rejects.toThrow('GIA_AD_SENHA_ARQUIVO');
});

it.skipIf(!TEM_BANCO)(
  'composição real → gate → worker → auditoria: resultado perdido não é repetido e rollback bloqueia pendências',
  async () => {
    const banco = await criarBancoDeTeste();
    let escritas = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async (_u, i) => {
        if (i?.method === 'GET') return Response.json([]);
        escritas++;
        throw new Error('detalhe-sensivel-do-fornecedor');
      }),
    );
    try {
      const eventos: unknown[] = [];
      const ligado = {
        ...env,
        GIA_ESCRITA_EXTERNA: 'true',
        GIA_ESCRITA_LIBERADA: 'jira:criar',
        GIA_JIRA_ESCRITA_HABILITADA: 'true',
      };
      const reais = await conectoresReaisDoAmbiente(
        await resolverSegredosDeArquivo(ligado),
        POLITICA_EXECUCAO_PADRAO,
        (e) => eventos.push(e),
      );
      const persistencia = criarPersistenciaPostgres(banco.db);
      const c = cenario(['jira']);
      const op = operacao(c, 'jira');
      await gravar(persistencia, c, [op]);
      const criar = (gates: VariaveisAmbiente) =>
        criarExecutor({
          persistencia,
          conectores: aplicarGatesDeEscrita(
            montarConectores(POLITICA_EXECUCAO_PADRAO).conectores,
            reais,
            carregarGatesDeEscrita(gates),
          ),
          politica: POLITICA_EXECUCAO_PADRAO,
          workerId: 'composicao-teste',
          agora: () => INICIO,
          novoId: randomUUID,
          agendar: () => () => {},
        });
      await criar(ligado).processarLote();
      expect(await persistencia.executar((tx) => tx.fila.operacaoPorId(op.id))).toMatchObject({
        efeito: 'desconhecido',
        status: 'aguardandoReconciliacao',
      });
      expect((await criar(ligado).processarLote()).reservadas).toBe(0);
      expect(escritas).toBe(1);
      expect(eventos).toMatchObject([{ sistema: 'jira', operacaoId: op.id, itemId: op.itemId }]);
      const auditados = await persistencia.executar((tx) =>
        tx.eventos.porTipo('operacaoResultadoRegistrado'),
      );
      expect(auditados).toHaveLength(1);
      expect(JSON.stringify(auditados)).not.toContain('segredo-ficticio');
      const c2 = cenario(['jira']);
      const op2 = operacao(c2, 'jira');
      await gravar(persistencia, c2, [op2]);
      await criar(env).processarLote();
      expect(await persistencia.executar((tx) => tx.fila.operacaoPorId(op2.id))).toMatchObject({
        codigo: 'ESCRITA_NAO_LIBERADA',
        efeito: 'semEfeito',
      });
      expect(escritas).toBe(1);
    } finally {
      await banco.descartar();
    }
  },
  TEMPO_BANCO_MS,
);
