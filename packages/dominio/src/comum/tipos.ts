/** Identificador UUID gerado fora do domínio (ver `ContextoComando.novoId`). */
export type Uuid = string;

/** Instante em UTC, ISO 8601 com sufixo `Z` (ex.: `2026-10-13T12:00:00.000Z`). */
export type Instante = string;

/** Data civil sem fuso, `AAAA-MM-DD`. Fica separada dos instantes por convenção do modelo. */
export type DataCivil = string;

const PADRAO_INSTANTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const PADRAO_DATA_CIVIL = /^(\d{4})-(\d{2})-(\d{2})$/;

export function ehInstanteValido(valor: string): boolean {
  return PADRAO_INSTANTE.test(valor) && !Number.isNaN(Date.parse(valor));
}

export function ehDataCivilValida(valor: string): boolean {
  const partes = PADRAO_DATA_CIVIL.exec(valor);
  if (!partes) return false;
  const [, ano, mes, dia] = partes.map(Number) as [number, number, number, number];
  const data = new Date(Date.UTC(ano, mes - 1, dia));
  return (
    data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia
  );
}

/** Soma milissegundos a um instante, devolvendo outro instante UTC. */
export function somarMs(instante: Instante, ms: number): Instante {
  return new Date(Date.parse(instante) + ms).toISOString();
}

/** Negativo se `a` < `b`, zero se iguais, positivo se `a` > `b`. */
export function compararInstantes(a: Instante, b: Instante): number {
  return Date.parse(a) - Date.parse(b);
}

export function textoPreenchido(valor: string | null | undefined): valor is string {
  return typeof valor === 'string' && valor.trim().length > 0;
}
