/** Remove a máscara e devolve só os 11 dígitos. */
export function normalizarCpf(cpf: string): string {
  return cpf.replace(/\D/g, '');
}

/** Valida os dígitos verificadores do CPF. */
export function ehCpfValido(cpf: string): boolean {
  const digitos = normalizarCpf(cpf);
  if (!/^\d{11}$/.test(digitos) || /^(\d)\1{10}$/.test(digitos)) return false;
  const numeros = Array.from({ length: 11 }, (_, i) => Number(digitos.charAt(i)));
  const verificador = (quantidade: number): number => {
    const soma = numeros
      .slice(0, quantidade)
      .reduce((acc, numero, i) => acc + numero * (quantidade + 1 - i), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return verificador(9) === numeros[9] && verificador(10) === numeros[10];
}
