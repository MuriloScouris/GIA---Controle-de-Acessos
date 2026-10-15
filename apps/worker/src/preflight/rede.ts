import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { checkServerIdentity, connect } from 'node:tls';
import type { Check } from './tipos.js';

export interface AlvoTls {
  readonly host: string;
  readonly porta: number;
  readonly nomeTls?: string;
  readonly ca?: Buffer;
}

/** DNS e handshake sem credenciais. Erros e certificados nunca são serializados. */
export async function verificarRede(alvo: AlvoTls, timeoutMs: number): Promise<readonly Check[]> {
  const checks: Check[] = [];
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!isIP(alvo.host))
      await Promise.race([
        lookup(alvo.host),
        new Promise<never>((_r, rejeitar) => {
          temporizador = setTimeout(() => rejeitar(new Error()), timeoutMs);
        }),
      ]);
    checks.push({ nome: 'dns', estado: 'ok', codigo: 'OK' });
  } catch {
    return [
      { nome: 'dns', estado: 'bloqueado', codigo: 'DNS_INDISPONIVEL' },
      { nome: 'tcp', estado: 'naoExecutado', codigo: 'DEPENDENCIA_BLOQUEADA' },
      { nome: 'tls', estado: 'naoExecutado', codigo: 'DEPENDENCIA_BLOQUEADA' },
    ];
  } finally {
    if (temporizador) clearTimeout(temporizador);
  }
  await new Promise<void>((resolver) => {
    let conectado = false;
    let encerrado = false;
    const nome = alvo.nomeTls ?? alvo.host;
    const socket = connect({
      host: alvo.host,
      port: alvo.porta,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      ...(alvo.ca ? { ca: alvo.ca } : {}),
      ...(!isIP(nome) ? { servername: nome } : {}),
      checkServerIdentity: (_host, cert) => checkServerIdentity(nome, cert),
    });
    const terminar = (ok: boolean, timeout = false) => {
      if (encerrado) return;
      encerrado = true;
      clearTimeout(prazo);
      checks.push({
        nome: 'tcp',
        estado: conectado ? 'ok' : 'bloqueado',
        codigo: conectado ? 'OK' : timeout ? 'TEMPO_ESGOTADO' : 'TCP_INDISPONIVEL',
      });
      checks.push({
        nome: 'tls',
        estado: ok ? 'ok' : conectado ? 'bloqueado' : 'naoExecutado',
        codigo: ok
          ? 'OK'
          : conectado
            ? timeout
              ? 'TEMPO_ESGOTADO'
              : 'TLS_INVALIDO'
            : 'DEPENDENCIA_BLOQUEADA',
      });
      socket.destroy();
      resolver();
    };
    const prazo = setTimeout(() => terminar(false, true), timeoutMs);
    socket.once('connect', () => {
      conectado = true;
    });
    socket.once('secureConnect', () => terminar(socket.authorized));
    socket.once('error', () => terminar(false));
  });
  return checks;
}
