import { normalizarAcesso } from '@gia/dominio';

/**
 * Distinguished names (DN) do AD, comparados sem depender de maiúsculas nem de
 * espaços em volta de `,` e `=`. Dois grupos com o mesmo `cn` em OUs
 * diferentes têm DNs diferentes: é o DN que identifica o grupo (DEV-305).
 */

/** RDNs do DN, respeitando vírgula escapada (`\,`). */
export function rdns(dn: string): string[] {
  const partes: string[] = [];
  let atual = '';
  for (let i = 0; i < dn.length; i += 1) {
    const c = dn[i]!;
    if (c === '\\' && i + 1 < dn.length) {
      atual += c + dn[i + 1]!;
      i += 1;
    } else if (c === ',') {
      partes.push(atual.trim());
      atual = '';
    } else {
      atual += c;
    }
  }
  if (atual.trim() !== '') partes.push(atual.trim());
  return partes;
}

export function primeiroRdn(dn: string): string {
  return rdns(dn)[0] ?? dn;
}

export function paiDe(dn: string): string {
  return rdns(dn).slice(1).join(',');
}

/** Valor do primeiro RDN sem escapes (ex.: o `cn` do grupo a partir do DN em `memberOf`). */
export function valorDoPrimeiroRdn(dn: string): string {
  const rdn = primeiroRdn(dn);
  const valor = rdn.slice(rdn.indexOf('=') + 1);
  return valor.replace(/\\([0-9a-fA-F]{2}|.)/g, (_, c: string) =>
    c.length === 2 ? String.fromCharCode(parseInt(c, 16)) : c,
  );
}

export function normalizarDn(dn: string): string {
  return rdns(dn)
    .map((rdn) => {
      const igual = rdn.indexOf('=');
      return `${rdn.slice(0, igual).trim().toLowerCase()}=${normalizarAcesso(rdn.slice(igual + 1))}`;
    })
    .join(',');
}

export function mesmoDn(a: string, b: string): boolean {
  return normalizarDn(a) === normalizarDn(b);
}

export function dentroDe(dn: string, base: string): boolean {
  const filho = normalizarDn(dn);
  const pai = normalizarDn(base);
  return filho === pai || filho.endsWith(`,${pai}`);
}

/**
 * O texto é um DN (`CN=GG-VPN,OU=Grupos,DC=...`) e não um nome de grupo? Exige
 * ao menos dois RDNs, cada um no formato `atributo=valor`.
 */
export function ehDn(texto: string): boolean {
  const partes = rdns(texto.trim());
  return partes.length >= 2 && partes.every((rdn) => /^[A-Za-z][A-Za-z0-9-]*\s*=\s*\S/.test(rdn));
}
