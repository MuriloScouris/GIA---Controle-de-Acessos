import { normalizarAcesso } from '@gia/dominio';
import { ErroFornecedor } from '../erros.js';
import type { ClienteJira, UsuarioJira } from '../adaptadores/jira-destino.js';
import type { ClienteJiraOrigem, PaginaChamados } from '../adaptadores/jira-origem.js';
import { Roteiro } from './roteiro.js';

export interface EstadoInicialJira {
  readonly usuarios?: readonly UsuarioJira[];
  readonly grupos?: readonly string[];
}

interface UsuarioSimulado {
  accountId: string;
  email: string;
  grupos: string[];
}

/** Jira (destino) simulado: conta pelo e-mail e grupos. */
export class JiraDestinoSimulado implements ClienteJira {
  readonly roteiro = new Roteiro({ primeiro: 'criarUsuario', ultimo: 'adicionarAoGrupo' });
  private readonly usuarios = new Map<string, UsuarioSimulado>();
  private readonly grupos: Set<string>;
  private sequencia = 0;

  constructor(estado: EstadoInicialJira = {}) {
    this.grupos = new Set((estado.grupos ?? []).map(normalizarAcesso));
    for (const usuario of estado.usuarios ?? []) {
      this.usuarios.set(normalizarAcesso(usuario.email), {
        ...usuario,
        grupos: [...usuario.grupos],
      });
    }
  }

  usuario(email: string): UsuarioJira | null {
    const usuario = this.usuarios.get(normalizarAcesso(email));
    return usuario === undefined ? null : { ...usuario, grupos: [...usuario.grupos] };
  }

  testar(): Promise<void> {
    return this.roteiro.passar('testar', () => undefined);
  }

  buscarUsuario(email: string): Promise<UsuarioJira | null> {
    return this.roteiro.passar('buscarUsuario', () => this.usuario(email));
  }

  grupoExiste(grupo: string): Promise<boolean> {
    return this.roteiro.passar('grupoExiste', () => this.grupos.has(normalizarAcesso(grupo)));
  }

  criarUsuario(email: string, _nome: string): Promise<string> {
    return this.roteiro.passar('criarUsuario', () => {
      if (this.usuarios.has(normalizarAcesso(email))) {
        throw new ErroFornecedor(
          'recusado',
          'USUARIO_JA_EXISTE',
          'Já existe conta com este e-mail.',
        );
      }
      this.sequencia += 1;
      const accountId = `jira-conta-${this.sequencia}`;
      this.usuarios.set(normalizarAcesso(email), { accountId, email, grupos: [] });
      return accountId;
    });
  }

  adicionarAoGrupo(accountId: string, grupo: string): Promise<void> {
    return this.roteiro.passar('adicionarAoGrupo', () => {
      const usuario = this.porId(accountId);
      if (!this.grupos.has(normalizarAcesso(grupo))) {
        throw new ErroFornecedor('recusado', 'GRUPO_INEXISTENTE', 'O grupo não existe no Jira.');
      }
      if (!usuario.grupos.some((g) => normalizarAcesso(g) === normalizarAcesso(grupo))) {
        usuario.grupos.push(grupo);
      }
    });
  }

  removerDoGrupo(accountId: string, grupo: string): Promise<void> {
    return this.roteiro.passar('removerDoGrupo', () => {
      const usuario = this.porId(accountId);
      usuario.grupos = usuario.grupos.filter(
        (g) => normalizarAcesso(g) !== normalizarAcesso(grupo),
      );
    });
  }

  private porId(accountId: string): UsuarioSimulado {
    const usuario = [...this.usuarios.values()].find((u) => u.accountId === accountId);
    if (usuario === undefined) {
      throw new ErroFornecedor('recusado', 'CONTA_AUSENTE', 'A conta não existe no Jira.');
    }
    return usuario;
  }
}

/** Jira (origem) simulado: páginas de chamados crus, sem rede. */
export class JiraOrigemSimulado implements ClienteJiraOrigem {
  readonly roteiro = new Roteiro({ primeiro: 'buscarPagina', ultimo: 'buscarPagina' });

  constructor(private readonly chamados: readonly unknown[] = []) {}

  testar(): Promise<void> {
    return this.roteiro.passar('testar', () => undefined);
  }

  buscarPagina(consulta: {
    readonly tiposSolicitacao: readonly string[];
    readonly inicio: number;
    readonly tamanho: number;
  }): Promise<PaginaChamados> {
    return this.roteiro.passar('buscarPagina', () => {
      // Como o JQL do Jira real: o filtro por request type vem antes da paginação e do total.
      // Lista vazia não casa com nada (um `IN ()` não seleciona chamado algum).
      const tipos = new Set(consulta.tiposSolicitacao);
      const filtrados = this.chamados.filter((chamado) => {
        const tipo = tipoDe(chamado);
        return tipo !== null && tipos.has(tipo);
      });
      return {
        chamados: structuredClone(
          filtrados.slice(consulta.inicio, consulta.inicio + consulta.tamanho),
        ),
        total: filtrados.length,
      };
    });
  }
}

function tipoDe(chamado: unknown): string | null {
  if (typeof chamado !== 'object' || chamado === null) return null;
  const { fields } = chamado as { fields?: unknown };
  if (typeof fields !== 'object' || fields === null) return null;
  const { tipoSolicitacao } = fields as { tipoSolicitacao?: unknown };
  return typeof tipoSolicitacao === 'string' ? tipoSolicitacao : null;
}
