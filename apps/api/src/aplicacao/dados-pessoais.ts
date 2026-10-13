import {
  exigirPermissao,
  mascararCpf,
  mascararCpfEmTexto,
  nivelDeAcesso,
  type ContextoComando,
} from '@gia/dominio';

/**
 * Proteção de dados pessoais nas respostas. Quem não tem permissão plena
 * recebe a projeção INTEIRA mascarada, não só os campos dedicados: CPF e
 * matrícula colados em texto livre (motivo, nome do RH, observação, chave da
 * issue...) também saem mascarados.
 *
 * Valor completo só para quem edita a proposta e precisa reenviar os
 * parâmetros (revisor/aprovador) ou tem acesso total a dados pessoais
 * (Administrador do Gia).
 */
export function podeVerDadosPessoais(ctx: ContextoComando): boolean {
  return (
    exigirPermissao(ctx.ator, 'editarProposta').ok ||
    nivelDeAcesso(ctx.ator.papeis, 'consultarDadosPessoais') === 'total'
  );
}

/** Mantém só os 2 últimos caracteres: `***01`. */
export function mascararMatricula(matricula: string): string {
  const valor = matricula.trim();
  return valor.length <= 2 ? '***' : `***${valor.slice(-2)}`;
}

/** Identificadores técnicos não são dado pessoal e não podem ser alterados pela máscara. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Matrículas curtas demais casariam com pedaços de outros textos. */
const TAMANHO_MINIMO_MATRICULA = 3;

const PROFUNDIDADE_MAXIMA = 12;

function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface DadosSensiveis {
  /** Matrículas da(s) pessoa(s) da projeção, mascaradas onde aparecerem em texto. */
  readonly matriculas: readonly (string | null)[];
}

/**
 * Devolve uma cópia com todo CPF válido mascarado (por nome de campo `cpf*`
 * e por valor, em qualquer texto) e as matrículas conhecidas mascaradas (no
 * campo `matricula` e onde aparecerem em texto). UUIDs ficam intactos.
 */
export function mascararDadosPessoais<T>(
  valor: T,
  sensiveis: DadosSensiveis = { matriculas: [] },
): T {
  const matriculas = [
    ...new Set(
      sensiveis.matriculas
        .filter((m): m is string => m !== null)
        .map((m) => m.trim())
        .filter((m) => m.length >= TAMANHO_MINIMO_MATRICULA),
    ),
  ]
    // Mais longas primeiro, para uma não mascarar só o pedaço de outra.
    .sort((a, b) => b.length - a.length)
    .map((m) => [new RegExp(escaparRegex(m), 'gi'), mascararMatricula(m)] as const);

  const texto = (s: string): string => {
    if (UUID.test(s)) return s;
    return matriculas.reduce(
      (acc, [padrao, troca]) => acc.replace(padrao, troca),
      mascararCpfEmTexto(s),
    );
  };

  const percorrer = (atual: unknown, profundidade: number): unknown => {
    if (typeof atual === 'string') return texto(atual);
    if (atual === null || typeof atual !== 'object' || profundidade >= PROFUNDIDADE_MAXIMA) {
      return atual;
    }
    if (Array.isArray(atual)) return atual.map((item) => percorrer(item, profundidade + 1));
    const copia: Record<string, unknown> = {};
    for (const [chave, item] of Object.entries(atual)) {
      if (typeof item === 'string' && /^cpf/i.test(chave)) copia[chave] = mascararCpf(item);
      else if (typeof item === 'string' && /^matricula$/i.test(chave)) {
        copia[chave] = mascararMatricula(item);
      } else copia[chave] = percorrer(item, profundidade + 1);
    }
    return copia;
  };
  return percorrer(valor, 0) as T;
}

/** Aplica a máscara só para quem não tem permissão plena. */
export function projetarParaAtor<T>(ctx: ContextoComando, valor: T, sensiveis?: DadosSensiveis): T {
  return podeVerDadosPessoais(ctx) ? valor : mascararDadosPessoais(valor, sensiveis);
}
