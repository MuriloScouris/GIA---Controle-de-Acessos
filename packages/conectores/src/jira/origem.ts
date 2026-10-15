import { ErroConfiguracao, type ChamadoJira } from '@gia/contratos';
import type { JiraOrigem } from '../adaptadores/jira-origem.js';
import { ErroFornecedor } from '../erros.js';
import { type HttpJira, invalida, objeto, texto } from './http.js';

export type MapeamentoJira = Readonly<Record<keyof ChamadoJira['fields'], string>>;

export interface OpcoesOrigemJiraCloud {
  readonly projeto: string;
  readonly tipos: { readonly celetista: string; readonly terceiro: string };
  /** Caminhos relativos a fields; ex.: customfield_10010.requestType.name. */
  readonly campos: MapeamentoJira;
  readonly tamanhoPagina?: number;
  readonly maxPaginas?: number;
}

export function validarOrigem(opcoes: OpcoesOrigemJiraCloud): void {
  const campos: (keyof ChamadoJira['fields'])[] = [
    'tipoSolicitacao',
    'nomeCompleto',
    'cpf',
    'matricula',
    'emailCorporativo',
    'area',
    'cargo',
    'dataAdmissao',
    'gestor',
  ];
  if (
    typeof opcoes.projeto !== 'string' ||
    !/^[A-Z][A-Z0-9_]*$/.test(opcoes.projeto) ||
    typeof opcoes.tipos?.celetista !== 'string' ||
    typeof opcoes.tipos?.terceiro !== 'string' ||
    typeof opcoes.campos !== 'object' ||
    opcoes.campos === null ||
    Object.keys(opcoes.campos).length !== campos.length ||
    !opcoes.tipos.celetista.trim() ||
    !opcoes.tipos.terceiro.trim() ||
    opcoes.tipos.celetista.toLocaleLowerCase() === opcoes.tipos.terceiro.toLocaleLowerCase() ||
    campos.some(
      (campo) =>
        typeof opcoes.campos[campo] !== 'string' ||
        !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$/.test(opcoes.campos[campo]),
    ) ||
    !Number.isInteger(opcoes.tamanhoPagina ?? 50) ||
    (opcoes.tamanhoPagina ?? 50) < 1 ||
    (opcoes.tamanhoPagina ?? 50) > 100 ||
    !Number.isInteger(opcoes.maxPaginas ?? 200) ||
    (opcoes.maxPaginas ?? 200) < 1 ||
    (opcoes.maxPaginas ?? 200) > 1_000
  ) {
    throw new ErroConfiguracao(['GIA_JIRA_ORIGEM_JSON']);
  }
}

export function criarOrigemJiraCloud(http: HttpJira, opcoes: OpcoesOrigemJiraCloud): JiraOrigem {
  validarOrigem(opcoes);
  return {
    async testarConexao() {
      try {
        texto(objeto(await http.chamar('autenticar', 'myself')).accountId);
        return {
          modo: 'real',
          disponivel: true,
          codigo: 'OK',
          mensagem: 'Conexão Jira estabelecida.',
        };
      } catch (erro) {
        return {
          modo: 'real',
          disponivel: false,
          codigo: erro instanceof ErroFornecedor ? erro.codigo : 'JIRA_RESPOSTA_INVALIDA',
          mensagem: 'Não foi possível conectar ao Jira.',
        };
      }
    },
    async buscarChamadosOnboarding() {
      const vistos = new Set<string>();
      const cursores = new Set<string>();
      const chamados: unknown[] = [];
      let cursor: string | undefined;
      const literal = (v: string) => `"${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
      const jql = `project = ${literal(opcoes.projeto)} AND "Request Type" in (${literal(opcoes.tipos.celetista)}, ${literal(opcoes.tipos.terceiro)}) ORDER BY created ASC, key ASC`;
      for (let pagina = 0; pagina < (opcoes.maxPaginas ?? 200); pagina += 1) {
        const resposta = objeto(
          await http.chamar('buscarChamados', 'search/jql', {
            jql,
            fields: [...new Set(Object.values(opcoes.campos).map((p) => p.split('.')[0]))].join(
              ',',
            ),
            maxResults: String(opcoes.tamanhoPagina ?? 50),
            ...(cursor === undefined ? {} : { nextPageToken: cursor }),
          }),
        );
        if (!Array.isArray(resposta.issues) || typeof resposta.isLast !== 'boolean')
          throw invalida();
        for (const bruto of resposta.issues) {
          // Falha de um chamado vira rejeição individual no schema da API.
          const normalizado = mapearChamado(bruto, opcoes);
          const key = normalizado.key;
          if (typeof key === 'string') {
            if (vistos.has(key)) continue;
            vistos.add(key);
          }
          chamados.push(normalizado);
        }
        if (resposta.isLast) return chamados;
        cursor = texto(resposta.nextPageToken);
        if (cursores.has(cursor)) throw new ErroFornecedor('recusado', 'JIRA_CURSOR_REPETIDO');
        cursores.add(cursor);
      }
      throw new ErroFornecedor('recusado', 'JIRA_PAGINACAO_EXCEDIDA');
    },
  };
}

function mapearChamado(
  bruto: unknown,
  opcoes: OpcoesOrigemJiraCloud,
): { key: unknown; fields: Record<string, unknown> } {
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto))
    return { key: null, fields: {} };
  const issue = bruto as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const [nome, caminho] of Object.entries(opcoes.campos)) {
    let valor: unknown = issue.fields;
    for (const parte of caminho.split('.')) {
      valor =
        typeof valor === 'object' && valor !== null && Object.hasOwn(valor, parte)
          ? (valor as Record<string, unknown>)[parte]
          : undefined;
    }
    fields[nome] = extrair(valor, 0);
  }
  const tipo = fields.tipoSolicitacao;
  if (typeof tipo === 'string') {
    if (tipo.toLocaleLowerCase() === opcoes.tipos.celetista.toLocaleLowerCase())
      fields.tipoSolicitacao = 'Admissão - Celetista';
    else if (tipo.toLocaleLowerCase() === opcoes.tipos.terceiro.toLocaleLowerCase())
      fields.tipoSolicitacao = 'Admissão - Terceiro';
    else fields.tipoSolicitacao = null; // não confiar em issue fora do filtro retornada pelo fornecedor
  }
  return { key: typeof issue.key === 'string' ? issue.key.trim() : null, fields };
}

/** ADF, select e single-user picker; lista ambígua é recusada, nunca escolhe uma pessoa. */
function extrair(valor: unknown, profundidade: number): unknown {
  if (profundidade > 15) return undefined;
  if (valor === null || valor === undefined || typeof valor === 'string') return valor;
  if (Array.isArray(valor))
    return valor.length === 1 ? extrair(valor[0], profundidade + 1) : undefined;
  if (typeof valor !== 'object') return undefined;
  const v = valor as Record<string, unknown>;
  if (v.type === 'doc' || v.type === 'paragraph' || v.type === 'text' || v.type === 'hardBreak') {
    if (v.type === 'text') return typeof v.text === 'string' ? v.text : undefined;
    if (v.type === 'hardBreak') return '\n';
    if (!Array.isArray(v.content)) return undefined;
    const partes = v.content.map((p) => extrair(p, profundidade + 1));
    return partes.every((p) => typeof p === 'string')
      ? partes.join(v.type === 'doc' ? '\n' : '').trim()
      : undefined;
  }
  // emailAddress identifica o gestor; displayName sozinho pode ser homônimo.
  if (typeof v.emailAddress === 'string') return v.emailAddress;
  if (typeof v.value === 'string') return v.value;
  return undefined;
}
