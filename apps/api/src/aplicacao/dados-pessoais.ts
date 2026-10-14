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

/**
 * Campos técnicos do contrato (identificadores, instantes, datas civis,
 * enums, códigos e caminhos de campo): o valor é preservado como está, para
 * a resposta continuar válida no schema mesmo quando uma matrícula coincide
 * com parte dele (ex.: matrícula `2026` num instante, `jira` num sistema).
 */
const CAMPOS_TECNICOS: ReadonlySet<string> = new Set([
  'acao',
  'campo',
  'campos',
  'codigo',
  'de',
  'dependeDe',
  'efeito',
  'etapaAlcancada',
  'exige',
  'fonte',
  'modo',
  'origem',
  'papeis',
  'para',
  'pendenciaIdentidade',
  'recurso',
  'sistema',
  'sistemaDosParametros',
  'sistemas',
  'sistemasDescartados',
  'sistemasPropostos',
  'situacao',
  'status',
  'statusAtual',
  'statusDependencia',
  'statusItem',
  'statusOperacao',
  'statusPermitidos',
  'tipoVinculo',
  'versaoRegras',
  'vinculo',
]);

/** `id`, `...Id`, `...Ids`, instantes `...Em` e datas civis `data...`. */
const PADRAO_CAMPO_TECNICO = /^(?:id|data[A-Z]\w*|\w+(?:Id|Ids|Em))$/;

function ehCampoTecnico(chave: string): boolean {
  return CAMPOS_TECNICOS.has(chave) || PADRAO_CAMPO_TECNICO.test(chave);
}

/** Só valores escalares (ou listas deles) são preservados; objetos continuam sendo percorridos. */
function ehValorTecnico(valor: unknown): boolean {
  return (
    typeof valor !== 'object' ||
    valor === null ||
    (Array.isArray(valor) && valor.every((item) => typeof item !== 'object' || item === null))
  );
}

/**
 * Datas e instantes ISO 8601 dentro de texto livre também são preservados.
 * Só valem com fronteira: colados a letra/dígito (`778899-01-01`) são parte
 * de um identificador, não uma data.
 */
const DATA_ISO =
  /(?<![\p{L}\p{N}])\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?(?!\d)/gu;

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
 * campo `matricula` e onde aparecerem em texto livre). Campos técnicos,
 * UUIDs e datas/instantes ISO ficam intactos. A substituição é literal: a
 * matrícula pode ter qualquer caractere (inclusive `$&`, `` $` ``, `$'`).
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

  /**
   * CPF e matrícula são procurados no texto inteiro, nunca em pedaços entre
   * datas: uma data não pode cortar um identificador (`<cpf>-01-01` e
   * `778899-01-01` casariam `8909-01-01`/`8899-01-01`). A matrícula só fica
   * intacta quando a ocorrência está inteira dentro de uma data legítima
   * (ex.: `2026` em `2026-01-15`).
   */
  const texto = (original: string): string => {
    if (UUID.test(original)) return original;
    return matriculas.reduce((acc, [padrao, troca]) => {
      const datas = [...acc.matchAll(DATA_ISO)].map(
        (data) => [data.index, data.index + data[0].length] as const,
      );
      // Callback: o texto de troca é inserido literalmente, sem padrões `$`.
      return acc.replace(padrao, (achado: string, posicao: number) =>
        datas.some(([inicio, fim]) => posicao >= inicio && posicao + achado.length <= fim)
          ? achado
          : troca,
      );
    }, mascararCpfEmTexto(original));
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
      } else if (ehCampoTecnico(chave) && ehValorTecnico(item)) {
        copia[chave] = Array.isArray(item) ? [...item] : item;
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
