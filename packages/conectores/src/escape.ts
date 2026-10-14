/**
 * Entrada humana é escapada nas fronteiras (spec, "Comportamento comum dos
 * adaptadores"). Os transportes reais usam estas funções ao montar filtros
 * LDAP, DNs e envelopes SOAP; nenhum valor de pessoa entra cru numa consulta.
 */

/** RFC 4515: valor de filtro LDAP. Bytes especiais e não ASCII viram `\hh`. */
export function escaparValorFiltroLdap(valor: string): string {
  let saida = '';
  for (const byte of new TextEncoder().encode(valor)) {
    const ehEspecial = byte === 0x5c || byte === 0x2a || byte === 0x28 || byte === 0x29;
    saida +=
      ehEspecial || byte === 0x00 || byte > 0x7f
        ? `\\${byte.toString(16).padStart(2, '0')}`
        : String.fromCharCode(byte);
  }
  return saida;
}

/** RFC 4514: valor de um componente de DN (ex.: o `CN`). */
export function escaparValorDn(valor: string): string {
  let saida = valor.replace(/[\\,+"<>;=]/g, (c) => `\\${c}`).replaceAll('\0', '\\00');
  if (saida.startsWith('#') || saida.startsWith(' ')) saida = `\\${saida}`;
  if (saida.endsWith(' ') && !saida.endsWith('\\ ')) saida = `${saida.slice(0, -1)}\\ `;
  return saida;
}

/** Texto de nó XML (SOAP do SoftExpert). Remove caracteres proibidos em XML 1.0. */
export function escaparXml(valor: string): string {
  return (
    valor
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  );
}
