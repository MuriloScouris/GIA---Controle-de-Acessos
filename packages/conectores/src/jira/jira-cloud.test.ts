import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chamadoJiraSchema } from '@gia/contratos';
import { criarJiraDoAmbiente } from './ambiente.js';
import { criarDestinoJiraCloud } from './destino.js';
import { HttpJira, type EventoHttpJira } from './http.js';
import { criarOrigemJiraCloud, type OpcoesOrigemJiraCloud } from './origem.js';
import { contexto, paramsJira } from '../teste/fabricas.js';

const servidores: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servidores.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.closeAllConnections();
          s.close(() => r());
        }),
    ),
  );
});

const origem: OpcoesOrigemJiraCloud = {
  projeto: 'RH',
  tipos: { celetista: 'Solicitar nova conta - Celetista', terceiro: 'Admissão externa' },
  campos: {
    tipoSolicitacao: 'customfield_10010.requestType.name',
    nomeCompleto: 'nome',
    cpf: 'cpf',
    matricula: 'matricula',
    emailCorporativo: 'email',
    area: 'area',
    cargo: 'cargo',
    dataAdmissao: 'data',
    gestor: 'gestor',
  },
};
const adf = (s: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
});
function chamado(key: string, tipo = origem.tipos.celetista) {
  return {
    key,
    fields: {
      customfield_10010: { requestType: { name: tipo } },
      nome: 'Pessoa Ficticia',
      cpf: adf('000.000.000-00'),
      matricula: adf('M123'),
      email: 'pessoa@example.invalid',
      area: { value: 'TI' },
      cargo: 'Analista',
      data: '2026-11-01',
      gestor: [{ emailAddress: 'gestor@example.invalid' }],
    },
  };
}

async function servidor(
  handler: (req: IncomingMessage, res: ServerResponse, url: URL, body: unknown) => void,
) {
  const server = createServer(async (req, res) => {
    const partes: Buffer[] = [];
    for await (const parte of req) partes.push(Buffer.from(parte));
    const conteudo = Buffer.concat(partes).toString();
    handler(
      req,
      res,
      new URL(req.url!, 'http://localhost'),
      conteudo ? JSON.parse(conteudo) : null,
    );
  });
  servidores.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endereco = server.address();
  if (typeof endereco !== 'object' || endereco === null) throw new Error('servidor sem porta');
  const eventos: EventoHttpJira[] = [];
  const fetchLocal: typeof fetch = (url, init) => {
    const destino = new URL(String(url));
    destino.protocol = 'http:';
    destino.hostname = '127.0.0.1';
    destino.port = String(endereco.port);
    return fetch(destino, init);
  };
  const http = new HttpJira({
    baseUrl: 'https://tenant.example.invalid',
    email: 'servico@example.invalid',
    apiToken: 'token-ficticio-testes',
    fetch: fetchLocal,
    esperar: async () => {},
    auditar: (e) => eventos.push(e),
  });
  return { http, eventos };
}
const json = (res: ServerResponse, dados: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(dados));
};

describe('Jira Cloud REST em servidor HTTP de contrato', () => {
  it('reconcilia criação aplicada cuja resposta se perdeu, sem recriar a conta', async () => {
    let existe = false;
    let criacoes = 0;
    const { http } = await servidor((req, res, url) => {
      if (url.pathname.endsWith('/user/search'))
        return json(
          res,
          existe
            ? [
                {
                  accountId: 'A1',
                  accountType: 'atlassian',
                  active: true,
                  emailAddress: paramsJira().email,
                },
              ]
            : [],
        );
      if (url.pathname.endsWith('/user/groups')) return json(res, []);
      expect(req.method).toBe('POST');
      existe = true;
      criacoes += 1;
      res.destroy();
    });
    const conector = criarDestinoJiraCloud(http, true);
    const ctx = contexto(paramsJira({ grupos: [] }), { modo: 'real' });
    expect(await conector.provisionar(ctx)).toMatchObject({
      efeito: 'desconhecido',
      codigo: 'JIRA_TRANSPORTE',
    });
    expect(await conector.conferirExistencia(ctx)).toMatchObject({
      contaExiste: true,
      etapaComprovada: 'adicionarGrupos',
    });
    expect(await conector.provisionar(ctx)).toMatchObject({ efeito: 'confirmado' });
    expect(criacoes).toBe(1);
  });
  it('autentica, busca por cursor, mapeia ADF/select/gestor e deduplica entre páginas', async () => {
    const consultas: URL[] = [];
    const { http, eventos } = await servidor((req, res, url) => {
      expect(req.headers.authorization).toBe(
        `Basic ${Buffer.from('servico@example.invalid:token-ficticio-testes').toString('base64')}`,
      );
      if (url.pathname.endsWith('/myself')) return json(res, { accountId: 'service-account' });
      expect(url.pathname).toBe('/rest/api/3/search/jql');
      consultas.push(url);
      const segunda = url.searchParams.has('nextPageToken');
      json(
        res,
        segunda
          ? {
              issues: [chamado('RH-1'), chamado('RH-2', origem.tipos.terceiro), { key: 'RH-3' }],
              isLast: true,
            }
          : { issues: [chamado('RH-1')], nextPageToken: 'cursor-2', isLast: false },
      );
    });
    const fonte = criarOrigemJiraCloud(http, origem);
    expect(await fonte.testarConexao()).toMatchObject({ modo: 'real', disponivel: true });
    const dados = await fonte.buscarChamadosOnboarding();
    expect(dados).toHaveLength(3);
    expect(chamadoJiraSchema.parse(dados[0]).fields).toMatchObject({
      cpf: '000.000.000-00',
      matricula: 'M123',
      area: 'TI',
      gestor: 'gestor@example.invalid',
      tipoSolicitacao: 'Admissão - Celetista',
    });
    expect(chamadoJiraSchema.parse(dados[1]).fields.tipoSolicitacao).toBe('Admissão - Terceiro');
    expect(chamadoJiraSchema.safeParse(dados[2]).success).toBe(false);
    expect(consultas[1]?.searchParams.get('nextPageToken')).toBe('cursor-2');
    expect(consultas[0]?.searchParams.get('jql')).toContain(
      '"Request Type" in ("Solicitar nova conta - Celetista", "Admissão externa")',
    );
    expect(consultas[0]?.searchParams.get('fields')).toContain('customfield_10010');
    expect(JSON.stringify(eventos)).not.toMatch(/token-ficticio|000\.000|servico@|cursor-2/);
  });

  it.each([
    { issues: [], isLast: false, nextPageToken: 'igual' },
    { issues: 'invalido', isLast: true },
  ])('recusa paginação inválida sem devolver resultado incompleto', async (pagina) => {
    const { http } = await servidor((_req, res) => json(res, pagina));
    await expect(
      criarOrigemJiraCloud(http, origem).buscarChamadosOnboarding(),
    ).rejects.toMatchObject({
      codigo: pagina.issues === 'invalido' ? 'JIRA_RESPOSTA_INVALIDA' : 'JIRA_CURSOR_REPETIDO',
    });
  });

  it('provisiona sem licença, reconcilia grupo parcial e revoga sem duplicar operações', async () => {
    let existe = false;
    let falhar = true;
    const grupos = new Set<string>();
    const escritas: string[] = [];
    const { http } = await servidor((req, res, url, body) => {
      if (url.pathname.endsWith('/user/search'))
        return json(
          res,
          existe
            ? [
                {
                  accountId: 'A1',
                  accountType: 'atlassian',
                  active: true,
                  emailAddress: paramsJira().email,
                },
              ]
            : [],
        );
      if (url.pathname.endsWith('/user/groups'))
        return json(
          res,
          [...grupos].map((name) => ({ name })),
        );
      if (url.pathname.endsWith('/group/user')) {
        const grupo = url.searchParams.get('groupname')!;
        if (req.method === 'POST' && grupo === 'jira-ti' && falhar) {
          falhar = false;
          return json(res, { errors: 'segredo-fornecedor' }, 403);
        }
        escritas.push(`${req.method}:${grupo}`);
        if (req.method === 'DELETE') {
          grupos.delete(grupo);
          res.writeHead(204);
          return res.end();
        }
        expect(body).toEqual({ accountId: 'A1' });
        grupos.add(grupo);
        return json(res, { name: grupo }, 201);
      }
      expect(url.pathname).toBe('/rest/api/3/user');
      expect(body).toEqual({
        emailAddress: paramsJira().email,
        displayName: paramsJira().nome,
        products: [],
      });
      existe = true;
      escritas.push('conta');
      json(res, { accountId: 'A1', accountType: 'atlassian' }, 201);
    });
    const conector = criarDestinoJiraCloud(http, true);
    const ctx = contexto(paramsJira(), { modo: 'real' });
    expect(await conector.provisionar(ctx)).toMatchObject({
      efeito: 'parcial',
      etapa: 'criarConta',
      codigo: 'JIRA_PERMISSAO',
    });
    expect(await conector.conferirExistencia(ctx)).toMatchObject({ etapaComprovada: 'criarConta' });
    expect(await conector.provisionar({ ...ctx, etapaInicial: 'adicionarGrupos' })).toMatchObject({
      efeito: 'confirmado',
    });
    expect(await conector.provisionar(ctx)).toMatchObject({ efeito: 'confirmado' });
    expect(escritas).toEqual(['conta', 'POST:jira-software-users', 'POST:jira-ti']);
    expect(await conector.revogar({ ...ctx, motivo: 'teste' })).toMatchObject({
      efeito: 'confirmado',
    });
    expect(await conector.revogar({ ...ctx, motivo: 'teste' })).toMatchObject({
      efeito: 'confirmado',
    });
    expect(escritas).toHaveLength(5);
  });

  it('registra progresso dentro da revogação de grupos quando o segundo falha', async () => {
    const grupos = new Set(paramsJira().grupos);
    const { http } = await servidor((req, res, url) => {
      if (url.pathname.endsWith('/user/search'))
        return json(res, [
          {
            accountId: 'A1',
            accountType: 'atlassian',
            active: true,
            emailAddress: paramsJira().email,
          },
        ]);
      if (url.pathname.endsWith('/user/groups'))
        return json(
          res,
          [...grupos].map((name) => ({ name })),
        );
      expect(req.method).toBe('DELETE');
      const grupo = url.searchParams.get('groupname')!;
      if (grupo === 'jira-ti') return json(res, {}, 403);
      grupos.delete(grupo);
      res.writeHead(204);
      res.end();
    });
    expect(
      await criarDestinoJiraCloud(http, true).revogar({
        ...contexto(paramsJira(), { modo: 'real' }),
        motivo: 'teste',
      }),
    ).toMatchObject({ efeito: 'parcial', codigo: 'JIRA_PERMISSAO' });
    expect([...grupos]).toEqual(['jira-ti']);
  });

  it('email oculto/ambíguo e conta portal-only nunca permitem criar/alterar outra identidade', async () => {
    let usuarios: unknown[] = [{ accountId: 'oculto', active: true, accountType: 'atlassian' }];
    const { http } = await servidor((req, res, url) => {
      expect(req.method).toBe('GET');
      expect(url.pathname).toContain('user/search');
      json(res, usuarios);
    });
    const conector = criarDestinoJiraCloud(http, true);
    const ctx = contexto(paramsJira(), { modo: 'real' });
    expect(await conector.provisionar(ctx)).toMatchObject({
      efeito: 'semEfeito',
      codigo: 'JIRA_EMAIL_OCULTO',
    });
    usuarios = ['a', 'b'].map((accountId) => ({
      accountId,
      active: true,
      accountType: 'atlassian',
      emailAddress: paramsJira().email,
    }));
    expect(await conector.provisionar(ctx)).toMatchObject({ codigo: 'JIRA_IDENTIDADE_AMBIGUA' });
    usuarios = [
      { accountId: 'a', active: true, accountType: 'customer', emailAddress: paramsJira().email },
    ];
    expect(await conector.provisionar(ctx)).toMatchObject({ codigo: 'JIRA_CONTA_INCOMPATIVEL' });
  });
});

describe('resiliência e configuração Jira', () => {
  const opcoes = {
    baseUrl: 'https://tenant.example.invalid',
    email: 'servico@example.invalid',
    apiToken: 'segredo-ficticio',
  };
  it.each([401, 403, 404, 400])(
    'não retenta recusa HTTP %s e não expõe a resposta',
    async (status) => {
      const fetchFake = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('TOKEN-SECRETO CPF', { status }));
      const http = new HttpJira({ ...opcoes, fetch: fetchFake });
      await expect(http.chamar('teste', 'myself')).rejects.not.toThrow(/TOKEN-SECRETO|CPF/);
      expect(fetchFake).toHaveBeenCalledTimes(1);
    },
  );
  it('retenta leituras 429/503 com backoff e respeita Retry-After', async () => {
    const esperar = vi.fn(async () => {});
    const fetchFake = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ accountId: 'ok' }));
    expect(
      await new HttpJira({ ...opcoes, fetch: fetchFake, esperar }).chamar('teste', 'myself'),
    ).toEqual({ accountId: 'ok' });
    expect(esperar.mock.calls[0]).toEqual([2000]);
    expect(fetchFake).toHaveBeenCalledTimes(3);
  });
  it('não antecipa Retry-After longo e limita tentativas', async () => {
    const esperar = vi.fn(async () => {});
    const fetchFake = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response('', { status: 429, headers: { 'retry-after': '90' } }),
      );
    await expect(
      new HttpJira({ ...opcoes, fetch: fetchFake, esperar }).chamar('teste', 'myself'),
    ).rejects.toMatchObject({ tentarAposMs: 90000 });
    expect(fetchFake).toHaveBeenCalledTimes(1);
    expect(esperar).not.toHaveBeenCalled();
  });
  it.each([500, 503])('escrita HTTP %s é desconhecida e não é repetida', async (status) => {
    const fetchFake = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('', { status }));
    await expect(
      new HttpJira({ ...opcoes, fetch: fetchFake }).chamar('criarUsuario', 'user', {}, 'POST', {}),
    ).rejects.toMatchObject({ tipo: 'respostaPerdida' });
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });
  it('cancela HTTP e não inicia outra chamada depois do prazo da operação', async () => {
    vi.useFakeTimers();
    let sinal: AbortSignal | undefined;
    const fetchFake = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      sinal = init?.signal ?? undefined;
      return new Promise(() => {});
    });
    const http = new HttpJira({
      ...opcoes,
      fetch: fetchFake,
      timeoutMs: 100,
      tentativasLeitura: 1,
    });
    const chamada = http.comPrazo(async () => {
      await expect(http.chamar('criarUsuario', 'user', {}, 'POST')).rejects.toMatchObject({
        tipo: 'timeout',
      });
      await expect(http.chamar('adicionarGrupo', 'group/user', {}, 'POST')).rejects.toMatchObject({
        tipo: 'timeout',
      });
    }, 50);
    await vi.advanceTimersByTimeAsync(51);
    await chamada;
    expect(sinal?.aborted).toBe(true);
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });
  it('não envia credencial em redirect e sanitiza falhas de transporte', async () => {
    const fetchFake = vi.fn<typeof fetch>().mockRejectedValue(new Error('segredo-ficticio'));
    const http = new HttpJira({ ...opcoes, fetch: fetchFake, tentativasLeitura: 1 });
    await expect(http.chamar('teste', 'myself')).rejects.not.toThrow(/segredo-ficticio/);
    expect(fetchFake.mock.calls[0]?.[1]?.redirect).toBe('error');
  });
  it('configuração inválida falha sem fallback nem vazamento', async () => {
    expect(criarJiraDoAmbiente({})).toBeNull();
    expect(() => criarJiraDoAmbiente({ GIA_JIRA_MODO: 'invalido' })).toThrow('GIA_JIRA_MODO');
    expect(() => new HttpJira({ ...opcoes, baseUrl: 'http://x?token=segredo-ficticio' })).toThrow(
      'GIA_JIRA_BASE_URL',
    );
    expect(() => criarJiraDoAmbiente({ GIA_JIRA_MODO: 'real' })).toThrow('GIA_JIRA_BASE_URL');
    expect(() =>
      criarJiraDoAmbiente({ GIA_JIRA_MODO: 'simulado', GIA_JIRA_ESCRITA_HABILITADA: 'true' }),
    ).toThrow('GIA_JIRA_ESCRITA_HABILITADA');
    const fetchFake = vi.fn<typeof fetch>();
    const http = new HttpJira({ ...opcoes, fetch: fetchFake });
    expect(
      await criarDestinoJiraCloud(http).provisionar(contexto(paramsJira(), { modo: 'real' })),
    ).toMatchObject({ codigo: 'JIRA_ESCRITA_DESLIGADA' });
    expect(
      await criarDestinoJiraCloud(http, true).provisionar(contexto(paramsJira())),
    ).toMatchObject({ codigo: 'JIRA_ESCRITA_DESLIGADA' });
    expect(fetchFake).not.toHaveBeenCalled();
  });
});
