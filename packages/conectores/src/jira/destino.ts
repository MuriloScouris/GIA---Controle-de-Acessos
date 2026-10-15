import type { Conector, ContextoItem, ResultadoOperacao } from '@gia/dominio';
import {
  criarConectorJiraDestino,
  type ClienteJira,
  type UsuarioJira,
} from '../adaptadores/jira-destino.js';
import { ErroFornecedor } from '../erros.js';
import type { OpcoesConector } from '../motor.js';
import { type HttpJira, invalida, objeto, texto } from './http.js';

export function criarClienteJiraCloud(http: HttpJira): ClienteJira {
  async function grupos(accountId: string): Promise<string[]> {
    const dados = await http.chamar('listarGruposUsuario', 'user/groups', { accountId });
    if (!Array.isArray(dados)) throw invalida();
    return dados.map((g) => texto(objeto(g).name));
  }
  return {
    async testar() {
      texto(objeto(await http.chamar('autenticar', 'myself')).accountId);
    },
    async buscarUsuario(email): Promise<UsuarioJira | null> {
      const encontrados = new Map<string, Record<string, unknown>>();
      let oculto = false;
      for (let pagina = 0; pagina < 100; pagina += 1) {
        const dados = await http.chamar('buscarUsuario', 'user/search', {
          query: email,
          startAt: String(pagina * 50),
          maxResults: '50',
        });
        if (!Array.isArray(dados)) throw invalida();
        for (const item of dados) {
          const usuario = objeto(item);
          const accountId = texto(usuario.accountId);
          if (typeof usuario.emailAddress !== 'string') oculto = true;
          else if (usuario.emailAddress.trim().toLowerCase() === email.trim().toLowerCase())
            encontrados.set(accountId, usuario);
        }
        if (dados.length < 50) {
          if (encontrados.size > 1) throw new ErroFornecedor('recusado', 'JIRA_IDENTIDADE_AMBIGUA');
          const usuario = [...encontrados.values()][0];
          if (usuario === undefined) {
            if (oculto) throw new ErroFornecedor('recusado', 'JIRA_EMAIL_OCULTO');
            return null;
          }
          if (usuario.accountType !== 'atlassian' || usuario.active !== true)
            throw new ErroFornecedor('recusado', 'JIRA_CONTA_INCOMPATIVEL');
          const accountId = texto(usuario.accountId);
          return { accountId, email, grupos: await grupos(accountId) };
        }
      }
      throw new ErroFornecedor('recusado', 'JIRA_PAGINACAO_EXCEDIDA');
    },
    async grupoExiste(grupo) {
      const dados = objeto(
        await http.chamar('buscarGrupo', 'group/bulk', { groupName: grupo, maxResults: '100' }),
      );
      if (!Array.isArray(dados.values)) throw invalida();
      // groupName é um filtro exato da API; rejeita uma resposta que perdeu a paginação.
      if (dados.isLast !== true) throw invalida();
      return dados.values.some((g) => texto(objeto(g).name).toLowerCase() === grupo.toLowerCase());
    },
    async criarUsuario(email, nome) {
      const dados = await http.chamar('criarUsuario', 'user', {}, 'POST', {
        emailAddress: email,
        displayName: nome,
        products: [],
      });
      try {
        const usuario = objeto(dados);
        if (usuario.accountType !== 'atlassian') throw invalida();
        return texto(usuario.accountId);
      } catch {
        // 2xx de escrita com contrato inválido pode já ter criado a conta.
        throw new ErroFornecedor('respostaPerdida', 'JIRA_RESPOSTA_INVALIDA');
      }
    },
    async adicionarAoGrupo(accountId, grupo) {
      if ((await grupos(accountId)).some((g) => g.toLowerCase() === grupo.toLowerCase())) return;
      const dados = await http.chamar(
        'adicionarGrupo',
        'group/user',
        { groupname: grupo },
        'POST',
        { accountId },
      );
      try {
        texto(objeto(dados).name);
      } catch {
        throw new ErroFornecedor('respostaPerdida', 'JIRA_RESPOSTA_INVALIDA');
      }
    },
    async removerDoGrupo(accountId, grupo) {
      if (!(await grupos(accountId)).some((g) => g.toLowerCase() === grupo.toLowerCase())) return;
      const dados = await http.chamar(
        'removerGrupo',
        'group/user',
        { groupname: grupo, accountId },
        'DELETE',
      );
      if (dados !== null) throw new ErroFornecedor('respostaPerdida', 'JIRA_RESPOSTA_INVALIDA');
    },
  };
}

/** Composição real explícita. Um contexto simulado jamais chega ao transporte de escrita. */
export function criarDestinoJiraCloud(
  http: HttpJira,
  escritaHabilitada = false,
  limites: Omit<OpcoesConector, 'modo'> = {},
): Conector {
  // O timeout externo precisa cobrir a etapa inteira (diversos HTTPs); o HTTP cancela cada chamada.
  const timeoutChamadaMs = limites.timeoutChamadaMs ?? 30_000;
  const conector = criarConectorJiraDestino(criarClienteJiraCloud(http), {
    ...limites,
    modo: 'real',
    timeoutChamadaMs,
  });
  const bloqueio = (ctx: ContextoItem): ResultadoOperacao | null => {
    if (escritaHabilitada && ctx.modo === 'real') return null;
    return {
      modo: ctx.modo,
      efeito: 'semEfeito',
      etapa: null,
      codigo: 'JIRA_ESCRITA_DESLIGADA',
      mensagem: 'Escrita Jira não habilitada para esta operação.',
      referenciaExterna: null,
      transitorio: false,
      tentarAposMs: null,
    };
  };
  return {
    ...conector,
    provisionar: async (ctx) =>
      bloqueio(ctx) ??
      (await http.comPrazo(() => conector.provisionar(ctx), Math.max(1, timeoutChamadaMs - 1))),
    revogar: async (ctx) =>
      bloqueio(ctx) ??
      (await http.comPrazo(() => conector.revogar(ctx), Math.max(1, timeoutChamadaMs - 1))),
  };
}
