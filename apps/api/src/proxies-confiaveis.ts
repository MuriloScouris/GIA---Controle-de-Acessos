import { isIP } from 'node:net';

/**
 * Validação de `GIA_API_PROXY_CONFIAVEL`: IPs e CIDRs dos proxies em que a API confia para ler o IP
 * do cliente em `X-Forwarded-For` (M8). Redes largas viram confiança em quase todo mundo e
 * desfazem o limite por origem, então são recusadas.
 *
 * O Fastify compara um cliente IPv4 com uma rede IPv6 mapeada (`::ffff:a.b.c.d/N`) como se fosse a
 * rede IPv4 equivalente. Por isso o prefixo IPv6 não é o que vale: `::ffff:0.0.0.0/96` tem prefixo
 * 96, mas confia em qualquer IPv4 (é o `0.0.0.0/0`). Os endereços mapeados são normalizados para
 * IPv4 e o prefixo efetivo (`N - 96`) passa pelo mesmo mínimo do IPv4. Redes IPv6 que contêm o
 * bloco mapeado inteiro também são recusadas.
 */
const MINIMO_BITS_IPV4 = 8;
const MINIMO_BITS_IPV6 = 16;
/** Os 96 bits iniciais de um IPv4 mapeado: `::ffff:0:0/96`. */
const PREFIXO_MAPEADO = 0xffffn << 32n;
const BITS_PREFIXO_MAPEADO = 96;

/** Valor de 128 bits de um IPv6 (com `::`, grafia hexadecimal ou IPv4 no fim); `null` se malformado. */
function valorIpv6(ip: string): bigint | null {
  let texto = ip.toLowerCase();
  const pontilhado = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(texto);
  if (pontilhado !== null) {
    if (isIP(pontilhado[1]!) !== 4) return null;
    const octetos = pontilhado[1]!.split('.').map(Number);
    const alto = ((octetos[0]! << 8) | octetos[1]!).toString(16);
    const baixo = ((octetos[2]! << 8) | octetos[3]!).toString(16);
    texto = `${texto.slice(0, pontilhado.index)}${alto}:${baixo}`;
  }
  const partes = texto.split('::');
  if (partes.length > 2) return null;
  const separar = (t: string) => (t === '' ? [] : t.split(':'));
  const inicio = separar(partes[0]!);
  const fim = partes.length === 2 ? separar(partes[1]!) : [];
  const faltam = 8 - inicio.length - fim.length;
  if (partes.length === 1 ? faltam !== 0 : faltam < 1) return null;
  const grupos = [...inicio, ...Array<string>(partes.length === 2 ? faltam : 0).fill('0'), ...fim];
  let valor = 0n;
  for (const grupo of grupos) {
    if (!/^[0-9a-f]{1,4}$/.test(grupo)) return null;
    valor = (valor << 16n) | BigInt(parseInt(grupo, 16));
  }
  return valor;
}

const ipv4DeValor = (v: bigint) =>
  [24n, 16n, 8n, 0n].map((s) => Number((v >> s) & 0xffn)).join('.');

/** Entrada normalizada, ou `null` se a rede for inválida, larga demais ou ambígua. */
function normalizar(entrada: string): string | null {
  const [ip, prefixo, ...resto] = entrada.split('/');
  if (ip === undefined || resto.length > 0 || ip.includes('%')) return null;
  const versao = isIP(ip);
  if (versao === 0) return null;
  const bits = prefixo === undefined ? null : /^\d{1,3}$/.test(prefixo) ? Number(prefixo) : NaN;

  if (versao === 4) {
    if (bits !== null && !(bits >= MINIMO_BITS_IPV4 && bits <= 32)) return null;
    return entrada;
  }

  const valor = valorIpv6(ip);
  if (valor === null) return null;
  const total = bits ?? 128;
  if (!(total >= MINIMO_BITS_IPV6 && total <= 128)) return null;

  if (total >= BITS_PREFIXO_MAPEADO) {
    if (valor >> 32n === PREFIXO_MAPEADO >> 32n) {
      // Rede dentro do bloco mapeado: vale como o IPv4 equivalente, com o prefixo IPv4 efetivo.
      const efetivo = total - BITS_PREFIXO_MAPEADO;
      if (!(efetivo >= MINIMO_BITS_IPV4 && efetivo <= 32)) return null;
      const v4 = ipv4DeValor(valor & 0xffffffffn);
      return bits === null || efetivo === 32 ? v4 : `${v4}/${efetivo}`;
    }
    return entrada;
  }
  // Rede maior que o bloco mapeado: se ela o contém, confia nos IPv4 que ela cobre.
  const deslocamento = BigInt(128 - total);
  return valor >> deslocamento === PREFIXO_MAPEADO >> deslocamento ? null : entrada;
}

/**
 * Lista, separada por vírgula, de IPs ou CIDRs. Vazio (padrão) = nenhum proxy confiável, e o
 * cabeçalho é ignorado. Devolve a lista normalizada (IPv4 mapeado vira IPv4) ou `'invalido'`.
 */
export function proxiesConfiaveis(valor: string | undefined): readonly string[] | 'invalido' {
  const texto = valor?.trim() ?? '';
  if (texto === '') return [];
  const lista: string[] = [];
  for (const bruto of texto.split(',')) {
    const normalizada = normalizar(bruto.trim());
    if (normalizada === null) return 'invalido';
    lista.push(normalizada);
  }
  return lista;
}
