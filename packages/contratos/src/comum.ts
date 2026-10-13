import { contemSegredo, ehInstanteValido } from '@gia/dominio';
import { z } from 'zod';

/** Cria um `z.enum` a partir de uma lista de literais exportada pelo domínio. */
export function enumDe<T extends string>(valores: readonly T[]): z.ZodType<T> {
  return z.enum(valores as unknown as [T, ...T[]]) as unknown as z.ZodType<T>;
}

export const uuidSchema = z.uuid();

/** Instante UTC em ISO 8601 com sufixo `Z`; mesma regra do domínio. */
export const instanteSchema = z.string().refine(ehInstanteValido, 'Instante UTC inválido');

export const versaoSchema = z.number().int().min(1);

/** Texto obrigatório, sem espaços nas pontas e sem segredo (regra 12). */
export function textoSchema(maximo = 500) {
  return z
    .string()
    .trim()
    .min(1, 'Informe o texto')
    .max(maximo)
    .refine((texto) => !contemSegredo(texto), 'Senhas, tokens e chaves não são permitidos');
}

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email());
