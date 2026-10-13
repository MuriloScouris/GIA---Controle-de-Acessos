/**
 * Completa 9 dígitos com os verificadores, para gerar CPFs válidos e
 * fictícios nas fixtures sem escrever um CPF completo no código.
 */
export function cpfFicticio(noveDigitos: string): string {
  if (!/^\d{9}$/.test(noveDigitos)) throw new Error('Informe exatamente 9 dígitos');
  const numeros = [...noveDigitos].map(Number);
  const digito = (base: readonly number[]): number => {
    const soma = base.reduce((acc, n, i) => acc + n * (base.length + 1 - i), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const primeiro = digito(numeros);
  const segundo = digito([...numeros, primeiro]);
  return `${noveDigitos}${primeiro}${segundo}`;
}
