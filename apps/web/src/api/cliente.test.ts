import { describe, expect, it } from 'vitest';
import { ErroApi, criarClienteApi } from './cliente.js';

const json = (corpo: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(corpo), { status }));

describe('cliente da API', () => {
  it('devolve a saúde validada pelo contrato', async () => {
    const cliente = criarClienteApi('http://api.teste', () => json({ status: 'ok' }));
    await expect(cliente.saude()).resolves.toEqual({ status: 'ok' });
  });

  it('rejeita resposta fora do contrato', async () => {
    const cliente = criarClienteApi('', () => json({ status: 'quebrado' }));
    await expect(cliente.saude()).rejects.toBeInstanceOf(ErroApi);
  });

  it('propaga o status HTTP de erro', async () => {
    const cliente = criarClienteApi('', () => json({}, 503));
    await expect(cliente.saude()).rejects.toMatchObject({ status: 503 });
  });

  describe('onboarding', () => {
    const pedidoId = '11111111-1111-4111-8111-111111111111';

    it('lista pedidos validando pelo contrato e rejeita lista fora dele', async () => {
      const ok = criarClienteApi('', () => json({ pedidos: [] }));
      await expect(ok.listarPedidos()).resolves.toEqual({ pedidos: [] });
      const ruim = criarClienteApi('', () => json({ pedidos: [{ id: 'x' }] }));
      await expect(ruim.listarPedidos()).rejects.toThrow('fora do contrato');
    });

    it('toda escrita envia o cabeçalho CSRF e cookies, e o comando leva a versão sem ator', async () => {
      const chamadas: { url: string; init: RequestInit }[] = [];
      const cliente = criarClienteApi('/api', (url, init) => {
        chamadas.push({ url, init: init ?? {} });
        return json({ ok: true, status: 'aprovado', versao: 4, operacaoId: null });
      });
      await cliente.executarComando(pedidoId, 3, { acao: 'aprovar', dados: {} });
      const { url, init } = chamadas[0]!;
      expect(url).toBe(`/api/pedidos/${pedidoId}/comandos`);
      expect(init.method).toBe('POST');
      expect(init.credentials).toBe('include');
      expect(init.headers).toMatchObject({ 'x-gia-csrf': '1' });
      const corpo = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(corpo).toEqual({ acao: 'aprovar', dados: {}, pedidoId, versaoEsperada: 3 });
      expect(Object.keys(corpo)).not.toContain('ator');
    });

    it('recusa da API vira ErroApi com o código estável e a mensagem do contrato', async () => {
      const cliente = criarClienteApi('', () =>
        json(
          {
            ok: false,
            codigo: 'CONFLITO_DE_VERSAO',
            mensagem: 'O registro foi alterado por outra pessoa.',
          },
          409,
        ),
      );
      await expect(
        cliente.executarComando(pedidoId, 1, { acao: 'aprovar', dados: {} }),
      ).rejects.toMatchObject({
        status: 409,
        codigo: 'CONFLITO_DE_VERSAO',
        message: 'O registro foi alterado por outra pessoa.',
      });
    });

    it('rede fora do ar vira ErroApi sem status', async () => {
      const cliente = criarClienteApi('', () => Promise.reject(new TypeError('failed')));
      await expect(cliente.listarPedidos()).rejects.toMatchObject({
        message: 'API indisponível',
      });
    });

    it('abre a sessão simulada com o papel e importa do Jira com CSRF', async () => {
      const chamadas: { url: string; init: RequestInit }[] = [];
      const cliente = criarClienteApi('', (url, init) => {
        chamadas.push({ url, init: init ?? {} });
        return url.endsWith('/sessao/simulada')
          ? json({
              usuarioId: '66666666-6666-4666-8666-666666666666',
              nome: 'Pessoa Ficticia',
              papeis: ['revisor'],
              expiraEm: '2026-10-14T20:00:00.000Z',
            })
          : json({ criados: [], duplicados: [], ignorados: [], recusados: [] });
      });
      await cliente.abrirSessaoSimulada('revisor');
      await cliente.importarDoJira();
      expect(JSON.parse(String(chamadas[0]!.init.body))).toEqual({ papel: 'revisor' });
      expect(chamadas[1]!.url).toBe('/importacoes/jira');
      expect(chamadas[1]!.init.headers).toMatchObject({ 'x-gia-csrf': '1' });
    });
  });
});

describe('cliente da API: login', () => {
  it('modo da sessão vem do servidor; falha ou resposta estranha é indisponível (nunca simulada)', async () => {
    expect(await criarClienteApi('', () => json({ modo: 'oidc' })).modoSessao()).toBe('oidc');
    expect(await criarClienteApi('', () => json({ modo: 'root' })).modoSessao()).toBe(
      'indisponivel',
    );
    expect(await criarClienteApi('', () => Promise.reject(new Error('rede'))).modoSessao()).toBe(
      'indisponivel',
    );
  });

  it('sessão atual: 401 é ausência de sessão; 200 é validada pelo contrato', async () => {
    expect(
      await criarClienteApi('', () => json({ codigo: 'NAO_AUTENTICADO' }, 401)).sessaoAtual(),
    ).toBeNull();
    const sessao = {
      usuarioId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      nome: 'Pessoa',
      papeis: ['revisor'],
      expiraEm: '2026-10-15T20:00:00.000Z',
    };
    expect(await criarClienteApi('', () => json(sessao)).sessaoAtual()).toEqual(sessao);
  });

  it('entrar com Microsoft aponta para a API com o retorno codificado', () => {
    expect(criarClienteApi('/api').urlEntrarOidc('/pedidos/1?a=b')).toBe(
      '/api/sessao/oidc/entrar?retorno=%2Fpedidos%2F1%3Fa%3Db',
    );
  });

  it('logout é POST com CSRF e só aceita destino do Entra ID', async () => {
    const chamadas: RequestInit[] = [];
    const sair = (destino: unknown, status = 200) =>
      criarClienteApi('/api', (_url, init) => {
        chamadas.push(init ?? {});
        return json({ redirecionarPara: destino }, status);
      }).sairOidc();
    expect(await sair('https://login.microsoftonline.com/t/oauth2/v2.0/logout')).toBe(
      'https://login.microsoftonline.com/t/oauth2/v2.0/logout',
    );
    expect(chamadas[0]).toMatchObject({ method: 'POST', headers: { 'x-gia-csrf': '1' } });
    for (const fora of [
      'https://atacante.exemplo/logout',
      'javascript:alert(1)',
      'http://login.microsoftonline.com/x',
      42,
    ]) {
      expect(await sair(fora)).toBeNull();
    }
    expect(await sair('https://login.microsoftonline.com/x', 403)).toBeNull();
  });
});
