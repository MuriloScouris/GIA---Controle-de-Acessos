import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import type * as Ldapts from 'ldapts';
import type { ClientOptions } from 'ldapts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErroFornecedor } from '../erros.js';
import { dentroDoPrazo } from '../prazo.js';
import { criarAbridorLdapts, traduzirErroLdap, type OpcoesConexaoLdap } from './ldap.js';

interface ChamadaFalsa {
  readonly operacao: string;
  readonly timeout: number | undefined;
}

const falso = vi.hoisted(() => ({
  clientes: [] as Array<{ opcoes: { connectTimeout?: number }; chamadas: ChamadaFalsa[] }>,
}));

// Troca só o Client: registra o `timeout` que valia no momento de cada operação.
vi.mock('ldapts', async (importarOriginal) => {
  const original = await importarOriginal<typeof Ldapts>();
  class ClienteFalso {
    readonly chamadas: ChamadaFalsa[] = [];
    constructor(readonly opcoes: ClientOptions) {
      falso.clientes.push(this);
    }
    private registrar(operacao: string) {
      this.chamadas.push({ operacao, timeout: this.opcoes.timeout });
    }
    async bind() {
      this.registrar('bind');
    }
    async search() {
      this.registrar('search');
      return { searchEntries: [], searchReferences: [] };
    }
    async add() {
      this.registrar('add');
    }
    async modify() {
      this.registrar('modify');
    }
    async modifyDN() {
      this.registrar('modifyDN');
    }
    async unbind() {
      this.registrar('unbind');
    }
  }
  return { ...original, Client: ClienteFalso };
});

const BUSCA = {
  base: 'DC=exemplo,DC=com,DC=br',
  escopo: 'sub',
  filtro: '(sAMAccountName=ana)',
  atributos: ['cn'],
} as const;

function abridor(extra: Partial<OpcoesConexaoLdap> = {}) {
  return criarAbridorLdapts({
    urls: ['ldaps://dc1.exemplo.com.br'],
    bindDn: 'CN=gia,DC=exemplo,DC=com,DC=br',
    senha: async () => 'senha-de-teste',
    ca: null,
    nomeServidorTls: null,
    timeoutConexaoMs: 5_000,
    timeoutOperacaoMs: 10_000,
    ...extra,
  });
}

const timeoutsDe = (operacao: string) =>
  falso.clientes.flatMap((c) => c.chamadas.filter((x) => x.operacao === operacao));

describe('timeout LDAP limitado ao prazo restante do motor (M4)', () => {
  const inicio = new Date('2026-01-01T12:00:00Z').getTime();

  beforeEach(() => {
    falso.clientes.length = 0;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(inicio);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const avancar = (ms: number) => vi.setSystemTime(Date.now() + ms);

  it('prazo restante menor que o timeout da operação: cada operação usa o que resta', async () => {
    await dentroDoPrazo(300, async () => {
      const sessao = await abridor({ timeoutOperacaoMs: 10_000 })();
      expect(falso.clientes[0]!.opcoes.connectTimeout).toBe(300);
      expect(timeoutsDe('bind')[0]!.timeout).toBe(300);

      avancar(100);
      await sessao.buscar(BUSCA);
      avancar(50);
      await sessao.incluir('CN=x,DC=exemplo', { cn: ['x'] });
      avancar(50);
      await sessao.alterar('CN=x,DC=exemplo', []);
      avancar(60);
      await sessao.renomear('CN=x,DC=exemplo', 'CN=y,DC=exemplo');
    });
    expect(timeoutsDe('search')[0]!.timeout).toBe(200);
    expect(timeoutsDe('add')[0]!.timeout).toBe(150);
    expect(timeoutsDe('modify')[0]!.timeout).toBe(100);
    expect(timeoutsDe('modifyDN')[0]!.timeout).toBe(40);
  });

  it('prazo restante maior que o timeout da operação: vale o timeoutOperacaoMs', async () => {
    await dentroDoPrazo(60_000, async () => {
      const sessao = await abridor({ timeoutOperacaoMs: 300, timeoutConexaoMs: 200 })();
      avancar(1_000);
      await sessao.buscar(BUSCA);
      await sessao.alterar('CN=x,DC=exemplo', []);
    });
    expect(falso.clientes[0]!.opcoes.connectTimeout).toBe(200);
    expect(timeoutsDe('bind')[0]!.timeout).toBe(300);
    expect(timeoutsDe('search')[0]!.timeout).toBe(300);
    expect(timeoutsDe('modify')[0]!.timeout).toBe(300);
  });

  it('prazo restante igual ao timeout da operação: o mesmo valor, sem ultrapassar', async () => {
    await dentroDoPrazo(500, async () => {
      const sessao = await abridor({ timeoutOperacaoMs: 500 })();
      await sessao.buscar(BUSCA);
    });
    expect(timeoutsDe('search')[0]!.timeout).toBe(500);
  });

  it('prazo expirado durante a sessão: nada é enviado e o erro é o timeout do motor', async () => {
    await dentroDoPrazo(300, async () => {
      const sessao = await abridor()();
      for (const gasto of [300, 1_000]) {
        // 300 = vence exatamente agora (restante 0); 1000 = vencido há tempo.
        vi.setSystemTime(inicio + gasto);
        for (const operacao of [
          () => sessao.buscar(BUSCA),
          () => sessao.incluir('CN=x,DC=exemplo', { cn: ['x'] }),
          () => sessao.alterar('CN=x,DC=exemplo', []),
          () => sessao.renomear('CN=x,DC=exemplo', 'CN=y,DC=exemplo'),
        ]) {
          const erro = await operacao().then(
            () => null,
            (e: unknown) => e,
          );
          expect(erro).toBeInstanceOf(ErroFornecedor);
          expect(erro).toMatchObject({ tipo: 'timeout', codigo: 'INTEGRACAO_TIMEOUT' });
        }
      }
    });
    expect(falso.clientes[0]!.chamadas.map((c) => c.operacao)).toEqual(['bind']);
  });

  it('prazo expirado antes de abrir a sessão: não cria cliente nem conecta', async () => {
    const erro = await dentroDoPrazo(0, () => abridor()()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(erro).toMatchObject({ tipo: 'timeout', codigo: 'INTEGRACAO_TIMEOUT' });
    expect(falso.clientes).toEqual([]);
  });

  it('prazo que vence enquanto a senha é lida: não faz o bind', async () => {
    const abrir = abridor({
      senha: async () => {
        avancar(400);
        return 'senha-de-teste';
      },
    });
    const erro = await dentroDoPrazo(300, () => abrir()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(erro).toMatchObject({ tipo: 'timeout', codigo: 'INTEGRACAO_TIMEOUT' });
    expect(timeoutsDe('bind')).toEqual([]);
  });

  it('fora de um prazo do motor vale só o timeoutOperacaoMs', async () => {
    const sessao = await abridor({ timeoutOperacaoMs: 200 })();
    avancar(1_000_000);
    await sessao.buscar(BUSCA);
    expect(timeoutsDe('search')[0]!.timeout).toBe(200);
  });
});

/**
 * Contrato com o ldapts de verdade (sem TLS, num servidor local): ele lê o `timeout` do mesmo objeto
 * de opções a cada requisição. É isso que permite ajustar o timeout por operação; se uma versão
 * futura copiar as opções no construtor, este teste falha em vez de o limite sumir em silêncio.
 */
describe('ldapts respeita o timeout alterado depois da conexão', () => {
  let servidor: Server | undefined;
  const sockets = new Set<Socket>();

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolver) =>
      servidor ? servidor.close(() => resolver()) : resolver(),
    );
  });

  /** Responde ao bind e nunca responde a mais nada, como um DC que travou. */
  async function iniciarServidorQueTrava() {
    servidor = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('data', (dados) => {
        // LDAPMessage = SEQUENCE { messageID INTEGER, protocolOp }; o bind é curto (IDs de 1 byte).
        const ehBind = dados[4 + dados[3]!] === 0x60;
        if (!ehBind) return;
        // BindResponse: resultCode success, matchedDN e diagnosticMessage vazios.
        socket.write(
          Buffer.from([
            0x30,
            0x0c,
            0x02,
            0x01,
            dados[4]!,
            0x61,
            0x07,
            0x0a,
            0x01,
            0x00,
            0x04,
            0x00,
            0x04,
            0x00,
          ]),
        );
      });
    });
    await new Promise<void>((resolver) => servidor!.listen(0, '127.0.0.1', resolver));
    return `ldap://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  }

  it('a busca expira no timeout menor definido depois do bind, não no original', async () => {
    const { Client } = await vi.importActual<typeof Ldapts>('ldapts');
    const opcoes: ClientOptions = {
      url: await iniciarServidorQueTrava(),
      timeout: 30_000,
      connectTimeout: 2_000,
    };
    const cliente = new Client(opcoes);
    await cliente.bind('CN=gia,DC=exemplo', 'senha-de-teste');

    opcoes.timeout = 200;
    const comeco = Date.now();
    const erro = await cliente.search(BUSCA.base, { scope: 'sub', filter: BUSCA.filtro }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(Date.now() - comeco).toBeLessThan(5_000);
    expect(erro).toBeInstanceOf(Error);
    expect(traduzirErroLdap(erro, 'operacao')).toMatchObject({
      tipo: 'timeout',
      codigo: 'AD_TEMPO_ESGOTADO',
    });
  }, 15_000);
});
