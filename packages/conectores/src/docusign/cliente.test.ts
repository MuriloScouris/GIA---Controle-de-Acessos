import { generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  carregarChaveDocusign,
  carregarConfiguracaoDocusign,
  type ConfiguracaoDocusign,
} from './configuracao.js';
import { criarClienteDocusignReal, montarConectorDocusign } from './cliente.js';
import { criarConectorDocusign } from '../adaptadores/docusign.js';
import { criarFetchComPrazo, dentroDoPrazo } from '../prazo.js';
import { contexto, contextoRevogacao, paramsDocusign } from '../teste/fabricas.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ID = '00000000-0000-4000-8000-000000000001';
const CONFIG: ConfiguracaoDocusign = {
  ambiente: 'demo',
  integracaoId: ID,
  usuarioId: ID,
  contaId: ID,
  chavePrivadaArquivo: 'secret-montado',
  timeoutMs: 2000,
  tentativasLeitura: 3,
  escritaHabilitada: true,
};
const usuario = {
  userId: 'u1',
  email: paramsDocusign().email,
  userStatus: 'Pending',
  permissionProfileId: 'p1',
  groupList: [{ groupName: 'Everyone' }, { groupName: 'Tecnologia' }],
};
const json = (valor: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(valor), { status, ...(headers ? { headers } : {}) });

function cenario(config: Partial<ConfiguracaoDocusign> = {}, agora?: () => number) {
  let existente = false;
  let fechado = false;
  const chamadas: { url: URL; init: RequestInit }[] = [];
  const falhas = new Map<string, Response[]>();
  const responder = async (
    entrada: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(String(entrada));
    chamadas.push({ url, init });
    const programada = falhas.get(`${init.method ?? 'GET'} ${url.pathname}`)?.shift();
    if (programada) return programada;
    if (url.pathname === '/oauth/token')
      return json({ access_token: 'token-ficticio', token_type: 'Bearer', expires_in: 3600 });
    if (url.pathname === '/oauth/userinfo')
      return json({ accounts: [{ account_id: ID, base_uri: 'https://demo.docusign.net' }] });
    if (url.pathname.endsWith('/permission_profiles'))
      return json({
        permissionProfiles: [{ permissionProfileId: 'p1', permissionProfileName: 'Remetente' }],
      });
    if (url.pathname.endsWith('/groups'))
      return json({ groups: [{ groupId: 'g1', groupName: 'Tecnologia' }] });
    if (url.pathname.endsWith('/users/u1'))
      return json({ ...usuario, userStatus: fechado ? 'Closed' : 'Pending' });
    if (init.method === 'POST') {
      existente = true;
      return json({ newUsers: [{ userId: 'u1', userStatus: 'ActivationSent' }] });
    }
    if (init.method === 'DELETE') {
      fechado = true;
      return json({ users: [{ userId: 'u1', userStatus: 'Closed' }] });
    }
    if (url.pathname.endsWith('/users')) return json({ users: existente ? [usuario] : [] });
    throw new Error('Rota inesperada');
  };
  const transporte = vi.fn(responder);
  const cliente = criarClienteDocusignReal({ ...CONFIG, ...config }, privateKey, {
    fetch: transporte,
    ...(agora ? { agora } : {}),
  });
  return {
    cliente,
    chamadas,
    falhas,
    transporte,
    responder,
    tornarExistente: () => {
      existente = true;
    },
    fechar: () => {
      existente = true;
      fechado = true;
    },
  };
}

describe('configuração segura DocuSign', () => {
  const env = {
    GIA_DOCUSIGN_AMBIENTE: 'demo',
    GIA_DOCUSIGN_INTEGRACAO_ID: ID,
    GIA_DOCUSIGN_USUARIO_ID: ID,
    GIA_DOCUSIGN_CONTA_ID: ID,
    GIA_DOCUSIGN_CHAVE_PRIVADA_ARQUIVO: 'secret-montado',
  };
  it('exige ambiente e IDs; escrita nasce desligada', () => {
    expect(carregarConfiguracaoDocusign(env).escritaHabilitada).toBe(false);
    expect(() => carregarConfiguracaoDocusign({ ...env, GIA_AMBIENTE: 'producao' })).toThrow(
      'GIA_DOCUSIGN_AMBIENTE',
    );
    expect(() =>
      carregarConfiguracaoDocusign({ ...env, GIA_DOCUSIGN_CONTA_ID: 'segredo-invalido' }),
    ).toThrow('Configuração inválida: GIA_DOCUSIGN_CONTA_ID');
    expect(() =>
      carregarConfiguracaoDocusign({ ...env, GIA_DOCUSIGN_TIMEOUT_MS: '30000' }),
    ).toThrow('GIA_DOCUSIGN_TIMEOUT_MS');
  });
  describe('política única de timeout (M5)', () => {
    it('sem teto, vale o que o ambiente configurou; padrão de 20 s', () => {
      expect(carregarConfiguracaoDocusign(env).timeoutMs).toBe(20_000);
      expect(
        carregarConfiguracaoDocusign({ ...env, GIA_DOCUSIGN_TIMEOUT_MS: '7500' }).timeoutMs,
      ).toBe(7_500);
    });
    it('o teto do motor limita o padrão e o valor configurado, nunca o aumenta', () => {
      const limite = { prazoMaximoMs: 4_900 };
      expect(carregarConfiguracaoDocusign(env, limite).timeoutMs).toBe(4_900);
      expect(
        carregarConfiguracaoDocusign({ ...env, GIA_DOCUSIGN_TIMEOUT_MS: '9000' }, limite).timeoutMs,
      ).toBe(4_900);
      expect(
        carregarConfiguracaoDocusign({ ...env, GIA_DOCUSIGN_TIMEOUT_MS: '1500' }, limite).timeoutMs,
      ).toBe(1_500);
    });
    it('valor fora do contrato é recusado também com teto, em vez de ajustado em silêncio', () => {
      for (const invalido of ['30000', '99', '0', '', '1e3', '12.5', ' 500', '-1', 'abc'])
        expect(() =>
          carregarConfiguracaoDocusign(
            { ...env, GIA_DOCUSIGN_TIMEOUT_MS: invalido },
            { prazoMaximoMs: 25_000 },
          ),
        ).toThrow('GIA_DOCUSIGN_TIMEOUT_MS');
    });
    it('o prazo do conector montado vem da configuração; o timeout de conexão do chamador prevalece', async () => {
      const lento = vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolver, rejeitar) =>
            init?.signal?.addEventListener('abort', () => rejeitar(init.signal?.reason), {
              once: true,
            }),
          ),
      );
      const inicio = Date.now();
      const conector = montarConectorDocusign(
        { ...CONFIG, timeoutMs: 2_000 },
        privateKey,
        { timeoutConexaoMs: 50 },
        { fetch: lento },
      );
      expect(await conector.testarConexao()).toMatchObject({ disponivel: false });
      expect(Date.now() - inicio).toBeLessThan(1_500);
      expect(lento).toHaveBeenCalledTimes(1);
    });
  });
  it('não expõe o caminho nem dados de erro ao falhar na carga da chave', async () => {
    await expect(carregarChaveDocusign('caminho-inexistente-ficticio')).rejects.toThrow(
      'Configuração inválida: GIA_DOCUSIGN_CHAVE_PRIVADA_ARQUIVO',
    );
  });
});

describe('DocuSign real: contrato HTTP e motor', () => {
  it('renova o JWT antes de expirar e descarta o token após 401 sem repetir a requisição', async () => {
    let instante = Date.now();
    const c = cenario({}, () => instante);
    await c.cliente.testar();
    instante += 3_550_000;
    await c.cliente.testar();
    expect(c.chamadas.filter((r) => r.url.pathname === '/oauth/token')).toHaveLength(2);
    c.falhas.set(`GET /restapi/v2.1/accounts/${ID}/users`, [json({}, 401)]);
    await expect(c.cliente.testar()).rejects.toMatchObject({ codigo: 'DOCUSIGN_AUTENTICACAO' });
    await c.cliente.testar();
    expect(c.chamadas.filter((r) => r.url.pathname === '/oauth/token')).toHaveLength(3);
  });

  it('traduz consentimento ausente sem expor error_description', async () => {
    const c = cenario();
    c.falhas.set('POST /oauth/token', [
      json({ error: 'consent_required', error_description: 'segredo' }, 400),
    ]);
    await expect(c.cliente.testar()).rejects.toMatchObject({
      codigo: 'DOCUSIGN_CONSENTIMENTO_NECESSARIO',
      message: 'Falha ao acessar o DocuSign.',
    });
    expect(c.chamadas).toHaveLength(1);
  });

  it('recusa mapeamento ausente ou ambíguo antes de criar', async () => {
    for (const grupos of [
      [],
      [
        { groupId: 'g1', groupName: 'Tecnologia' },
        { groupId: 'g2', groupName: 'tecnologia' },
      ],
    ]) {
      const c = cenario();
      c.falhas.set(`GET /restapi/v2.1/accounts/${ID}/groups`, [json({ groups: grupos })]);
      await expect(c.cliente.criarUsuario(paramsDocusign())).rejects.toMatchObject({
        tipo: 'recusado',
      });
      expect(
        c.chamadas.some((r) => r.init.method === 'POST' && r.url.pathname.endsWith('/users')),
      ).toBe(false);
    }
  });

  it('não refaz criação com resposta perdida e permite conferência posterior', async () => {
    const c = cenario();
    c.transporte.mockImplementation(async (url, init) => {
      const resposta = await c.responder(url, init);
      if (init?.method === 'POST' && String(url).endsWith('/users'))
        throw new Error('token-ficticio segredo');
      return resposta;
    });
    const conector = criarConectorDocusign(c.cliente, { modo: 'real' });
    expect(await conector.provisionar(contexto(paramsDocusign()))).toMatchObject({
      efeito: 'desconhecido',
      codigo: 'DOCUSIGN_RESPOSTA_PERDIDA',
    });
    expect(await conector.conferirExistencia(contexto(paramsDocusign()))).toMatchObject({
      contaExiste: true,
      etapaComprovada: 'criarUsuarioComPerfilEGrupo',
    });
    expect(
      c.chamadas.filter((r) => r.init.method === 'POST' && r.url.pathname.endsWith('/users')),
    ).toHaveLength(1);
  });

  it('não reduz Retry-After longo a uma espera curta por overflow do temporizador', async () => {
    const c = cenario();
    c.falhas.set(`GET /restapi/v2.1/accounts/${ID}/users`, [
      json({}, 429, { 'retry-after': '3000000' }),
    ]);
    await expect(c.cliente.buscarUsuario(paramsDocusign().email)).rejects.toMatchObject({
      tipo: 'limiteDeTaxa',
      tentarAposMs: 3_000_000_000,
    });
    expect(c.chamadas.filter((r) => r.url.pathname.endsWith('/users'))).toHaveLength(1);
  });
  it('assina JWT RS256 e reutiliza token; cria, confere todos os grupos e encerra sem duplicar', async () => {
    const c = cenario();
    const conector = criarConectorDocusign(c.cliente, { modo: 'real' });
    expect(await conector.provisionar(contexto(paramsDocusign()))).toMatchObject({
      modo: 'real',
      efeito: 'confirmado',
      referenciaExterna: 'u1',
    });
    expect(await conector.provisionar(contexto(paramsDocusign()))).toMatchObject({
      efeito: 'semEfeito',
      codigo: 'USUARIO_JA_EXISTE',
    });
    expect(await conector.conferirExistencia(contexto(paramsDocusign()))).toMatchObject({
      etapaComprovada: 'criarUsuarioComPerfilEGrupo',
      acessosEncontrados: ['perfil:Remetente', 'grupo:Everyone', 'grupo:Tecnologia'],
    });
    expect(await conector.revogar(contextoRevogacao(paramsDocusign()))).toMatchObject({
      efeito: 'confirmado',
      etapa: 'encerrarUsuario',
    });
    expect(await conector.revogar(contextoRevogacao(paramsDocusign()))).toMatchObject({
      codigo: 'JA_REVOGADO',
    });
    const token = c.chamadas.filter((r) => r.url.pathname === '/oauth/token');
    expect(token).toHaveLength(1);
    const assertion = new URLSearchParams(String(token[0]?.init.body)).get('assertion') ?? '';
    const [header, payload, signature] = assertion.split('.');
    expect(JSON.parse(Buffer.from(payload ?? '', 'base64url').toString())).toMatchObject({
      iss: ID,
      sub: ID,
      aud: 'account-d.docusign.com',
      scope: 'signature impersonation',
    });
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature ?? '', 'base64url'),
      ),
    ).toBe(true);
    const escritas = c.chamadas.filter(
      (r) => ['POST', 'DELETE'].includes(r.init.method ?? '') && !r.url.pathname.includes('oauth'),
    );
    expect(escritas).toHaveLength(2);
    expect(JSON.parse(String(escritas[0]?.init.body))).toEqual({
      newUsers: [
        {
          email: paramsDocusign().email,
          userName: paramsDocusign().nome,
          company: 'Exemplo',
          jobTitle: 'Analista',
          permissionProfileId: 'p1',
          groupList: [{ groupId: 'g1' }],
          sendActivationEmail: 'true',
          userSettings: { localePolicy: { cultureName: 'pt-BR' } },
        },
      ],
    });
  });

  it('não contorna escrita desligada nem reabre conta encerrada', async () => {
    const desligado = cenario({ escritaHabilitada: false });
    await expect(desligado.cliente.criarUsuario(paramsDocusign())).rejects.toMatchObject({
      codigo: 'DOCUSIGN_ESCRITA_DESLIGADA',
    });
    expect(desligado.chamadas).toHaveLength(0);
    const c = cenario();
    c.fechar();
    await expect(c.cliente.criarUsuario(paramsDocusign())).rejects.toMatchObject({
      codigo: 'DOCUSIGN_CONTA_ENCERRADA',
    });
    await c.cliente.encerrarUsuario(paramsDocusign().email);
    expect(c.chamadas.some((r) => r.init.method === 'DELETE')).toBe(false);
  });

  it('deduplica chamadas simultâneas para o mesmo e-mail normalizado', async () => {
    const c = cenario();
    const resultados = await Promise.allSettled([
      c.cliente.criarUsuario(paramsDocusign()),
      c.cliente.criarUsuario(paramsDocusign({ email: paramsDocusign().email.toUpperCase() })),
    ]);
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      c.chamadas.filter((r) => r.init.method === 'POST' && r.url.pathname.endsWith('/users')),
    ).toHaveLength(1);
  });

  it.each([401, 403, 408, 429, 503])(
    'traduz HTTP %s sem vazar corpo e sem repetir escrita',
    async (status) => {
      const c = cenario();
      c.falhas.set(`POST /restapi/v2.1/accounts/${ID}/users`, [
        json({ message: 'token-ficticio segredo' }, status, { 'retry-after': '2' }),
      ]);
      const resultado = await criarConectorDocusign(c.cliente, { modo: 'real' }).provisionar(
        contexto(paramsDocusign()),
      );
      expect(resultado.efeito).toBe(
        status === 503 || status === 408 ? 'desconhecido' : 'semEfeito',
      );
      expect(JSON.stringify(resultado)).not.toMatch(/token-ficticio|segredo/);
      expect(
        c.chamadas.filter((r) => r.init.method === 'POST' && r.url.pathname.endsWith('/users')),
      ).toHaveLength(1);
      if (status === 429)
        expect(resultado).toMatchObject({ transitorio: true, tentarAposMs: 2000 });
    },
  );

  it('trata erro interno 2xx e resposta de escrita malformada de forma distinta', async () => {
    for (const [body, efeito] of [
      [{ newUsers: [{ errorDetails: { errorCode: 'ERRO', message: 'segredo' } }] }, 'semEfeito'],
      [{ newUsers: [] }, 'desconhecido'],
      [{}, 'desconhecido'],
      [
        { newUsers: [{ userId: 'u1', errorDetails: { errorCode: 'ERRO_PARCIAL' } }] },
        'desconhecido',
      ],
      [null, 'desconhecido'],
      [[], 'desconhecido'],
    ] as const) {
      const c = cenario();
      c.falhas.set(`POST /restapi/v2.1/accounts/${ID}/users`, [json(body)]);
      expect(
        await criarConectorDocusign(c.cliente, { modo: 'real' }).provisionar(
          contexto(paramsDocusign()),
        ),
      ).toMatchObject({ efeito });
    }
  });

  it('retenta somente leituras transitórias, com Retry-After e limite', async () => {
    const c = cenario();
    c.falhas.set(`GET /restapi/v2.1/accounts/${ID}/users`, [
      json({}, 429, { 'retry-after': '0' }),
      json({}, 503, { 'retry-after': '0' }),
    ]);
    await expect(c.cliente.buscarUsuario(paramsDocusign().email)).resolves.toBeNull();
    expect(c.chamadas.filter((r) => r.url.pathname.endsWith('/users'))).toHaveLength(3);
  });

  it('pagina usuários, mantém o filtro e ignora nextUri não confiável', async () => {
    const c = cenario();
    c.tornarExistente();
    c.falhas.set(`GET /restapi/v2.1/accounts/${ID}/users`, [
      json({
        users: [{ ...usuario, email: 'outra@exemplo.com' }],
        endPosition: '0',
        nextUri: 'https://invalido.example/roubar',
      }),
    ]);
    expect(await c.cliente.buscarUsuario(paramsDocusign().email)).toMatchObject({ id: 'u1' });
    const paginas = c.chamadas.filter((r) => r.url.pathname.endsWith('/users'));
    expect(paginas[1]?.url.searchParams.get('start_position')).toBe('1');
    expect(
      paginas.every(
        (r) =>
          r.url.hostname === 'demo.docusign.net' &&
          r.url.searchParams.get('email') === paramsDocusign().email,
      ),
    ).toBe(true);
  });

  it('recusa conta não autorizada e base URI fora do ambiente', async () => {
    for (const accounts of [
      [],
      [{ account_id: ID, base_uri: 'https://atacante.example' }],
      [{ account_id: ID, base_uri: 'https://na2.docusign.net' }],
    ]) {
      const c = cenario();
      c.falhas.set('GET /oauth/userinfo', [json({ accounts })]);
      await expect(c.cliente.testar()).rejects.toBeDefined();
      expect(c.chamadas.every((r) => r.url.hostname === 'account-d.docusign.com')).toBe(true);
    }
  });

  it('prazo do motor estourado no transporte compartilhado também é timeout, não resposta perdida', async () => {
    const c = cenario({ timeoutMs: 20_000 });
    c.transporte.mockRejectedValue(new DOMException('prazo do motor', 'TimeoutError'));
    await expect(c.cliente.testar()).rejects.toMatchObject({
      tipo: 'timeout',
      codigo: 'DOCUSIGN_TIMEOUT',
    });
    await expect(c.cliente.criarUsuario(paramsDocusign())).rejects.toMatchObject({
      tipo: 'timeout',
    });
    expect(c.chamadas).toHaveLength(0);
  });

  it('M3: 2xx de criação recebido depois do prazo do motor vira desconhecido, nunca sem efeito', async () => {
    const c = cenario();
    // O destino processa o POST e responde 2xx, mas só depois do prazo do motor (300 ms).
    const atrasado = vi.fn(async (entrada: string | URL | Request, init?: RequestInit) => {
      const resposta = await c.responder(entrada, init);
      if (init?.method === 'POST' && new URL(String(entrada)).pathname.endsWith('/users'))
        await new Promise((resolver) => setTimeout(resolver, 450));
      return resposta;
    });
    const cliente = criarClienteDocusignReal({ ...CONFIG, timeoutMs: 20_000 }, privateKey, {
      fetch: criarFetchComPrazo(atrasado as unknown as typeof fetch),
    });
    const conector = criarConectorDocusign(cliente, { modo: 'real' });
    const resultado = await dentroDoPrazo(300, () =>
      conector.provisionar(contexto(paramsDocusign())),
    );
    expect(
      c.chamadas.some((r) => r.init.method === 'POST' && r.url.pathname.endsWith('/users')),
    ).toBe(true);
    expect(resultado.efeito).toBe('desconhecido');
    expect(resultado.efeito).not.toBe('semEfeito');
    expect(resultado.codigo).toBe('INTEGRACAO_RESPOSTA_APOS_PRAZO');
  });

  it('M3: a mesma criação com a resposta dentro do prazo é confirmada', async () => {
    const c = cenario();
    const cliente = criarClienteDocusignReal({ ...CONFIG, timeoutMs: 20_000 }, privateKey, {
      fetch: criarFetchComPrazo(c.responder as unknown as typeof fetch),
    });
    const conector = criarConectorDocusign(cliente, { modo: 'real' });
    const resultado = await dentroDoPrazo(5_000, () =>
      conector.provisionar(contexto(paramsDocusign())),
    );
    expect(resultado.efeito).toBe('confirmado');
  });

  it('timeout aborta o envio; não dispara escrita após estourar o prazo durante uma leitura', async () => {
    const c = cenario({ timeoutMs: 30 });
    c.transporte.mockImplementation(async (url, init) => {
      if (String(url).includes('/users?'))
        return new Promise((_resolver, rejeitar) => {
          init?.signal?.addEventListener('abort', () => rejeitar(new Error('timeout')), {
            once: true,
          });
        });
      return c.responder(url, init);
    });
    await expect(c.cliente.criarUsuario(paramsDocusign())).rejects.toMatchObject({
      tipo: 'timeout',
    });
    expect(
      c.chamadas.some((r) => r.init.method === 'POST' && r.url.pathname.endsWith('/users')),
    ).toBe(false);
  });
});

describe('integração HTTP local com fetch real', () => {
  let servidor: Server | undefined;
  afterEach(async () => {
    if (servidor) {
      servidor.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        servidor?.close((erro) => (erro ? reject(erro) : resolve())),
      );
      servidor = undefined;
    }
  });

  it('percorre OAuth e API por sockets reais e traduz a falha do fornecedor', async () => {
    const c = cenario();
    servidor = createServer(async (req, res) => {
      const partes: Buffer[] = [];
      for await (const parte of req) partes.push(Buffer.from(parte));
      const url = new URL(req.url ?? '/', 'https://demo.docusign.net');
      const resposta = await c.responder(url, {
        method: req.method ?? 'GET',
        body: Buffer.concat(partes).toString(),
      });
      res.writeHead(resposta.status, { 'content-type': 'application/json' });
      res.end(await resposta.text());
    });
    servidor.listen(0, '127.0.0.1');
    await once(servidor, 'listening');
    const endereco = servidor.address();
    if (!endereco || typeof endereco === 'string') throw new Error('Servidor indisponível');
    const cliente = criarClienteDocusignReal(CONFIG, privateKey, {
      fetch: (url, init) =>
        fetch(
          `http://127.0.0.1:${endereco.port}${new URL(String(url)).pathname}${new URL(String(url)).search}`,
          init,
        ),
    });
    const conector = criarConectorDocusign(cliente, { modo: 'real' });
    expect(await conector.provisionar(contexto(paramsDocusign()))).toMatchObject({
      efeito: 'confirmado',
      referenciaExterna: 'u1',
    });
    expect(await conector.conferirExistencia(contexto(paramsDocusign()))).toMatchObject({
      contaExiste: true,
    });
    c.falhas.set(`DELETE /restapi/v2.1/accounts/${ID}/users`, [
      json({ errorDetails: { message: 'segredo' } }),
    ]);
    expect(await conector.revogar(contextoRevogacao(paramsDocusign()))).toMatchObject({
      efeito: 'semEfeito',
      codigo: 'DOCUSIGN_ERRO_INTERNO',
    });
  });
});
