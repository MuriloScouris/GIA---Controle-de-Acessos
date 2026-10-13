/** Tipo somente leitura em profundidade. */
export type Profundo<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly Profundo<U>[]
    : T extends object
      ? { readonly [K in keyof T]: Profundo<T[K]> }
      : T;

/**
 * Congela o objeto e tudo o que ele alcança. Usado em revisões aprovadas e
 * eventos, que são evidência e não podem ser alterados depois de criados.
 * Percorre os descendentes mesmo quando a raiz já está congelada (um
 * `Object.freeze` raso não protege arrays e objetos internos).
 */
export function congelarProfundo<T>(valor: T): T {
  congelarInterno(valor, new WeakSet());
  return valor;
}

function congelarInterno(valor: unknown, vistos: WeakSet<object>): void {
  if (valor === null || typeof valor !== 'object') return;
  if (vistos.has(valor)) return;
  vistos.add(valor);
  for (const chave of Reflect.ownKeys(valor)) {
    congelarInterno((valor as Record<PropertyKey, unknown>)[chave], vistos);
  }
  Object.freeze(valor);
}

/** Igualdade estrutural para dados simples (JSON-like), sem depender da ordem das chaves. */
export function igualdadeEstrutural(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => igualdadeEstrutural(item, b[i]));
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const chavesA = Object.keys(objA);
  const chavesB = Object.keys(objB);
  return (
    chavesA.length === chavesB.length &&
    chavesA.every(
      (chave) => Object.hasOwn(objB, chave) && igualdadeEstrutural(objA[chave], objB[chave]),
    )
  );
}
