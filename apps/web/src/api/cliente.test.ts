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
