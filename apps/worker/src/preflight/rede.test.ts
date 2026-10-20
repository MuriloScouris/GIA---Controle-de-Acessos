import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import { verificarRede } from './rede.js';

it('DNS inválido falha antes do TCP e TLS', async () => {
  const r = await verificarRede({ host: '\0invalido', porta: 443 }, 100);
  expect(r[0]).toMatchObject({ nome: 'dns', codigo: 'DNS_INDISPONIVEL' });
  expect(r.slice(1).every((c) => c.estado === 'naoExecutado')).toBe(true);
});
it('conexão TCP sem TLS expira e fecha o socket sem enviar credenciais', async () => {
  let bytes = 0;
  const servidor = createServer((s) => {
    s.on('data', (b: Buffer) => {
      bytes += b.length;
    });
  });
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  try {
    const endereco = servidor.address();
    if (!endereco || typeof endereco === 'string') throw new Error();
    // O prazo corre desde o início da conexão: com 100 ms, sob carga a conexão TCP local podia
    // chegar depois dele e o teste via `tcp` esgotado em vez de `ok`. O assunto é o silêncio do
    // servidor depois do TCP; 1 s dá folga para conectar e ainda termina rápido.
    const r = await verificarRede({ host: '127.0.0.1', porta: endereco.port }, 1_000);
    expect(r).toContainEqual({ nome: 'tcp', estado: 'ok', codigo: 'OK' });
    expect(r).toContainEqual({ nome: 'tls', estado: 'bloqueado', codigo: 'TEMPO_ESGOTADO' });
    expect(bytes).toBeGreaterThan(0); // apenas handshake TLS; nenhuma autenticação LDAP/HTTP.
  } finally {
    await new Promise<void>((r) => servidor.close(() => r()));
  }
});
it.skipIf(!process.env['GIA_AD_TESTE_URL'])(
  'LDAPS valida CA e nome; nome errado ou CA ausente nunca passam',
  async () => {
    const u = new URL(process.env['GIA_AD_TESTE_URL']!);
    const ca = await readFile(process.env['GIA_AD_TESTE_CA_ARQUIVO']!);
    const alvo = {
      host: u.hostname,
      porta: Number(u.port || 636),
      nomeTls: process.env['GIA_AD_TESTE_TLS_NOME_SERVIDOR']!,
      ca,
    };
    expect((await verificarRede(alvo, 5000)).every((c) => c.estado === 'ok')).toBe(true);
    expect(
      (await verificarRede({ ...alvo, nomeTls: 'nome-incorreto.invalid' }, 5000)).find(
        (c) => c.nome === 'tls',
      )?.codigo,
    ).toBe('TLS_INVALIDO');
    const semCa = { host: alvo.host, porta: alvo.porta, nomeTls: alvo.nomeTls };
    expect((await verificarRede(semCa, 5000)).find((c) => c.nome === 'tls')?.codigo).toBe(
      'TLS_INVALIDO',
    );
  },
);
