/**
 * Regra 12 — Segredos fora de tudo. Senhas e chaves nunca aparecem em código,
 * respostas, logs ou eventos. Toda evidência, mensagem de conector, detalhe de
 * erro e estado antes/depois de evento passa por aqui antes de ser gravado.
 */

export const VALOR_OCULTO = '[OCULTO]';

/**
 * Nomes de campo que carregam segredo. `chaveIdempotencia` não é segredo e
 * propositalmente não casa com nenhum padrão abaixo.
 */
const CHAVE_SENSIVEL =
  /(senha|password|passwd|pwd|secret|segredo|token|api[-_]?key|chave[-_]?(api|privada|acesso|secreta)|private[-_]?key|credencia|credential|authorization|cookie|certificado|assinatura[-_]?jwt)/i;

const PADROES_DE_VALOR: readonly (readonly [RegExp, string])[] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/g, `$1 ${VALOR_OCULTO}`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, VALOR_OCULTO],
  [
    /\b(senha|password|passwd|pwd|secret|segredo|token|api[-_]?key|client[-_]?secret)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    `$1$2${VALOR_OCULTO}`,
  ],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, VALOR_OCULTO],
];

const PROFUNDIDADE_MAXIMA = 12;

export function ehChaveSensivel(chave: string): boolean {
  return CHAVE_SENSIVEL.test(chave);
}

export function sanitizarTexto(texto: string): string {
  return PADROES_DE_VALOR.reduce((acc, [padrao, troca]) => acc.replace(padrao, troca), texto);
}

/**
 * Devolve uma cópia do valor sem segredos: campos com nome sensível têm o
 * valor substituído e textos têm tokens/senhas embutidos mascarados.
 */
export function sanitizar<T>(valor: T): T {
  return sanitizarInterno(valor, 0, new WeakSet()) as T;
}

function sanitizarInterno(valor: unknown, profundidade: number, vistos: WeakSet<object>): unknown {
  if (typeof valor === 'string') return sanitizarTexto(valor);
  if (valor === null || typeof valor !== 'object') {
    return typeof valor === 'function' || typeof valor === 'symbol' ? undefined : valor;
  }
  if (profundidade >= PROFUNDIDADE_MAXIMA) return '[PROFUNDIDADE_EXCEDIDA]';
  if (vistos.has(valor)) return '[REFERENCIA_CIRCULAR]';
  vistos.add(valor);
  if (Array.isArray(valor)) {
    return valor.map((item: unknown) => sanitizarInterno(item, profundidade + 1, vistos));
  }
  const copia: Record<string, unknown> = {};
  for (const [chave, item] of Object.entries(valor)) {
    copia[chave] = ehChaveSensivel(chave)
      ? VALOR_OCULTO
      : sanitizarInterno(item, profundidade + 1, vistos);
  }
  return copia;
}

/** Verdadeiro se o valor tem algum campo de nome sensível preenchido ou segredo embutido em texto. */
export function contemSegredo(valor: unknown): boolean {
  return contemSegredoInterno(valor, 0, new WeakSet());
}

function contemSegredoInterno(
  valor: unknown,
  profundidade: number,
  vistos: WeakSet<object>,
): boolean {
  if (typeof valor === 'string') return sanitizarTexto(valor) !== valor;
  if (valor === null || typeof valor !== 'object' || profundidade >= PROFUNDIDADE_MAXIMA) {
    return false;
  }
  if (vistos.has(valor)) return false;
  vistos.add(valor);
  const entradas: [string, unknown][] = Array.isArray(valor)
    ? valor.map((item: unknown, i) => [String(i), item])
    : Object.entries(valor);
  return entradas.some(
    ([chave, item]) =>
      (ehChaveSensivel(chave) && item !== null && item !== undefined && item !== '') ||
      contemSegredoInterno(item, profundidade + 1, vistos),
  );
}

/** Mascara CPF para exibição em logs: `123.***.***-09`. */
export function mascararCpf(cpf: string): string {
  const digitos = cpf.replace(/\D/g, '');
  if (digitos.length !== 11) return '***';
  return `${digitos.slice(0, 3)}.***.***-${digitos.slice(9)}`;
}

/**
 * Mascara campos de CPF (`cpf`, `cpfTitular`...) em qualquer profundidade.
 * Eventos referenciam a pessoa pelo `colaboradorId`; o CPF completo fica só
 * no cadastro do colaborador, que é o alvo da anonimização.
 */
export function mascararCpfs<T>(valor: T): T {
  return mascararCpfsInterno(valor, 0) as T;
}

function mascararCpfsInterno(valor: unknown, profundidade: number): unknown {
  if (valor === null || typeof valor !== 'object' || profundidade >= PROFUNDIDADE_MAXIMA) {
    return valor;
  }
  if (Array.isArray(valor)) {
    return valor.map((item: unknown) => mascararCpfsInterno(item, profundidade + 1));
  }
  const copia: Record<string, unknown> = {};
  for (const [chave, item] of Object.entries(valor)) {
    copia[chave] =
      /^cpf/i.test(chave) && typeof item === 'string'
        ? mascararCpf(item)
        : mascararCpfsInterno(item, profundidade + 1);
  }
  return copia;
}
