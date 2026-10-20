import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext, createServer as criarServidorTls, type TLSSocket } from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { dentroDoPrazo } from '../prazo.js';
import { criarAbridorLdapts, type SessaoLdap } from './ldap.js';

/**
 * Regressão do P2 do PR #32, contra o ldapts de verdade e um LDAPS local com certificado verificado:
 * se o socket cai depois do bind, o ldapts reconectaria sozinho antes de enviar, e uma escrita podia
 * sair depois do prazo do motor. A sessão precisa falhar sem enviar nada e sem reconectar.
 *
 * O certificado de teste é gerado na hora com o `openssl` do ambiente (existe no CI e no Windows
 * com Git), vale por um dia e fica só em loopback; nada disso vai para o repositório.
 */
function temOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const TEM_OPENSSL = temOpenssl();

describe('LDAPS local: openssl disponível', () => {
  it('no CI a regressão de reconexão roda de verdade', () => {
    if (process.env['CI']) expect(TEM_OPENSSL).toBe(true);
  });
});

const TAG_BIND = 0x60;
const TAG_ADD = 0x68;
const TAG_MODIFY = 0x66;
const TAG_MODIFY_DN = 0x6c;
const TAG_SEARCH = 0x63;
const ESCRITAS = new Set([TAG_ADD, TAG_MODIFY, TAG_MODIFY_DN]);

/** Tag do protocolOp de uma LDAPMessage: SEQUENCE { messageID INTEGER, protocolOp ... }. */
function lerMensagem(dados: Buffer): { id: number; tag: number } {
  let i = 1;
  i += dados[1]! & 0x80 ? 1 + (dados[1]! & 0x7f) : 1;
  const tamanhoId = dados[i + 1]!;
  return { id: dados[i + 2]!, tag: dados[i + 2 + tamanhoId]! };
}

/** LDAPResult de sucesso (sem matchedDN nem diagnóstico) para a resposta de tag `tagResposta`. */
const sucesso = (id: number, tagResposta: number) =>
  Buffer.from([
    0x30,
    0x0c,
    0x02,
    0x01,
    id,
    tagResposta,
    0x07,
    0x0a,
    0x01,
    0x00,
    0x04,
    0x00,
    0x04,
    0x00,
  ]);

describe.skipIf(!TEM_OPENSSL)('sessão LDAPS que perde a conexão depois do bind', () => {
  let pasta: string;
  let ca: Buffer;
  let chave: Buffer;

  beforeAll(() => {
    pasta = mkdtempSync(join(tmpdir(), 'gia-ldaps-'));
    execFileSync(
      'openssl',
      [
        ...['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'],
        ...['-subj', '/CN=localhost', '-days', '1'],
        ...['-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
        ...['-keyout', join(pasta, 'chave.pem'), '-out', join(pasta, 'cert.pem')],
      ],
      { stdio: 'ignore' },
    );
    ca = readFileSync(join(pasta, 'cert.pem'));
    chave = readFileSync(join(pasta, 'chave.pem'));
  });
  afterAll(() => rmSync(pasta, { recursive: true, force: true }));

  const encerrar: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of encerrar.splice(0)) await fn();
  });

  /**
   * O primeiro socket aceita o bind e é fechado em seguida (queda depois do bind), salvo
   * `derrubarAposBind: false`. Todo handshake
   * seguinte demora `atrasoReconexaoMs` (via SNI assíncrono), como uma reconexão lenta. Registra o
   * que chegou ao servidor e quando.
   */
  async function iniciarServidor(
    atrasoReconexaoMs: number,
    { derrubarAposBind = true }: { derrubarAposBind?: boolean } = {},
  ) {
    const contexto = createSecureContext({ key: chave, cert: ca });
    const conexoes: number[] = [];
    const recebidas: Array<{ tag: number; em: number }> = [];
    const sockets = new Set<Socket>();
    let handshakes = 0;
    const servidor = criarServidorTls(
      {
        SNICallback: (_nome, cb) => {
          handshakes += 1;
          if (handshakes === 1) cb(null, contexto);
          else setTimeout(() => cb(null, contexto), atrasoReconexaoMs);
        },
      },
      (socket: TLSSocket) => {
        sockets.add(socket);
        socket.on('error', () => undefined);
        const derrubar = derrubarAposBind && handshakes === 1;
        socket.on('data', (dados) => {
          const { id, tag } = lerMensagem(dados);
          recebidas.push({ tag, em: Date.now() });
          if (tag === TAG_BIND) socket.write(sucesso(id, 0x61), () => derrubar && socket.end());
          else if (tag === TAG_ADD) socket.write(sucesso(id, 0x69));
        });
      },
    );
    servidor.on('connection', () => conexoes.push(Date.now()));
    await new Promise<void>((resolver) => servidor.listen(0, '127.0.0.1', resolver));
    encerrar.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolver) => servidor.close(() => resolver()));
    });
    return {
      url: `ldaps://127.0.0.1:${(servidor.address() as AddressInfo).port}`,
      conexoes,
      recebidas,
    };
  }

  function abridor(url: string) {
    return criarAbridorLdapts({
      urls: [url],
      bindDn: 'CN=gia,DC=exemplo,DC=com,DC=br',
      senha: async () => 'senha-de-teste',
      ca,
      nomeServidorTls: 'localhost',
      timeoutConexaoMs: 5_000,
      timeoutOperacaoMs: 10_000,
    });
  }

  const esperar = (ms: number) => new Promise((resolver) => setTimeout(resolver, ms));
  const falha = (promessa: Promise<unknown>) =>
    promessa.then(
      () => null,
      (erro: unknown) => erro,
    );

  const OPERACOES: Array<[string, (s: SessaoLdap) => Promise<unknown>]> = [
    [
      'busca',
      (s) => s.buscar({ base: 'DC=exemplo', escopo: 'sub', filtro: '(cn=x)', atributos: ['cn'] }),
    ],
    ['inclusão', (s) => s.incluir('CN=x,DC=exemplo', { cn: ['x'] })],
    ['alteração', (s) => s.alterar('CN=x,DC=exemplo', [])],
    ['renomeação', (s) => s.renomear('CN=x,DC=exemplo', 'CN=y,DC=exemplo')],
  ];

  it('reconexão lenta com o prazo quase no fim: a inclusão não é enviada depois do deadline', async () => {
    const servidor = await iniciarServidor(300);
    const inicio = Date.now();
    const prazoMs = 700;
    const erro = await dentroDoPrazo(prazoMs, async () => {
      const sessao = await abridor(servidor.url)();
      // O servidor fechou o socket do bind; sobram ~150 ms de prazo, menos que a reconexão (300 ms).
      await esperar(prazoMs - 150 - (Date.now() - inicio));
      return falha(sessao.incluir('CN=x,DC=exemplo', { cn: ['x'] }));
    });
    const deadline = inicio + prazoMs;
    // Espera mais que o atraso da reconexão: se o ldapts reconectasse, a escrita chegaria agora.
    await esperar(600);

    expect(erro).toMatchObject({ tipo: 'conexaoRecusada', codigo: 'AD_CONEXAO_PERDIDA' });
    expect(servidor.recebidas.filter((r) => ESCRITAS.has(r.tag))).toEqual([]);
    expect(servidor.recebidas.filter((r) => r.em > deadline)).toEqual([]);
    expect(servidor.conexoes).toHaveLength(1);
  });

  it.each(OPERACOES)(
    'com prazo de sobra, %s numa sessão sem conexão falha sem reconectar nem enviar',
    async (_nome, operacao) => {
      const servidor = await iniciarServidor(0);
      const erro = await dentroDoPrazo(60_000, async () => {
        const sessao = await abridor(servidor.url)();
        await esperar(150);
        return falha(operacao(sessao));
      });
      await esperar(200);

      expect(erro).toMatchObject({ tipo: 'conexaoRecusada', codigo: 'AD_CONEXAO_PERDIDA' });
      expect(servidor.recebidas.map((r) => r.tag)).toEqual([TAG_BIND]);
      expect(servidor.conexoes).toHaveLength(1);
      expect(servidor.recebidas.some((r) => r.tag === TAG_SEARCH)).toBe(false);
    },
  );

  it('sem queda, a escrita dentro do prazo continua sendo enviada (controle)', async () => {
    const servidor = await iniciarServidor(0, { derrubarAposBind: false });
    await dentroDoPrazo(60_000, async () => {
      const sessao = await abridor(servidor.url)();
      await sessao.incluir('CN=x,DC=exemplo', { cn: ['x'] });
    });
    expect(servidor.recebidas.map((r) => r.tag)).toEqual([TAG_BIND, TAG_ADD]);
    expect(servidor.conexoes).toHaveLength(1);
  });
});
