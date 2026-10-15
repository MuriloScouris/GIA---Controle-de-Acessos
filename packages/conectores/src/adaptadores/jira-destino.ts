import { normalizarAcesso, type Apontamento, type Conector } from '@gia/dominio';
import { ErroFornecedor } from '../erros.js';
import { criarConector, type Fornecedor, type OpcoesConector } from '../motor.js';

export interface UsuarioJira {
  readonly accountId: string;
  readonly email: string;
  readonly grupos: readonly string[];
}

/** Transporte REST do Jira como destino (criação de conta e grupos). */
export interface ClienteJira {
  testar(): Promise<void>;
  buscarUsuario(email: string): Promise<UsuarioJira | null>;
  grupoExiste(grupo: string): Promise<boolean>;
  /** Cria a conta pelo e-mail e devolve o `accountId`. */
  criarUsuario(email: string, nome: string): Promise<string>;
  adicionarAoGrupo(accountId: string, grupo: string): Promise<void>;
  removerDoGrupo(accountId: string, grupo: string): Promise<void>;
}

export function criarFornecedorJiraDestino(cliente: ClienteJira): Fornecedor<'jira'> {
  return {
    sistema: 'jira',
    testar: () => cliente.testar(),

    async validar(p) {
      const impedimentos: Apontamento[] = [];
      const avisos: Apontamento[] = [];
      if ((await cliente.buscarUsuario(p.email)) !== null) {
        avisos.push({
          codigo: 'USUARIO_JA_EXISTE',
          mensagem: 'Já existe conta Jira com este e-mail; só os grupos serão ajustados.',
        });
      }
      for (const grupo of p.grupos) {
        if (!(await cliente.grupoExiste(grupo))) {
          impedimentos.push({
            codigo: 'GRUPO_INEXISTENTE',
            mensagem: `O grupo "${grupo}" não existe no Jira.`,
          });
        }
      }
      return { impedimentos, avisos };
    },

    async consultar(p) {
      const usuario = await cliente.buscarUsuario(p.email);
      if (usuario === null) {
        return {
          contaExiste: false,
          acessosEncontrados: [],
          etapaComprovada: null,
          referenciaExterna: null,
        };
      }
      const membros = new Set(usuario.grupos.map(normalizarAcesso));
      const completo = p.grupos.every((grupo) => membros.has(normalizarAcesso(grupo)));
      return {
        contaExiste: true,
        acessosEncontrados: usuario.grupos.map((grupo) => `grupo:${grupo}`),
        etapaComprovada: completo ? 'adicionarGrupos' : 'criarConta',
        referenciaExterna: usuario.accountId,
      };
    },

    passos(acao, p) {
      const idDaConta = async (): Promise<string> => {
        const usuario = await cliente.buscarUsuario(p.email);
        if (usuario === null) {
          throw new ErroFornecedor('recusado', 'CONTA_AUSENTE', 'Conta Jira não encontrada.');
        }
        return usuario.accountId;
      };
      if (acao === 'revogar') {
        return [
          {
            etapa: 'removerGrupos',
            executar: async () => {
              const accountId = await idDaConta();
              await alterarGrupos(p.grupos, (grupo) => cliente.removerDoGrupo(accountId, grupo));
              return null;
            },
          },
        ];
      }
      return [
        {
          etapa: 'criarConta',
          // Conta que já existe só é reaproveitada, nunca recriada.
          executar: async () =>
            (await cliente.buscarUsuario(p.email))?.accountId ??
            (await cliente.criarUsuario(p.email, p.nome)),
        },
        {
          etapa: 'adicionarGrupos',
          executar: async () => {
            const accountId = await idDaConta();
            await alterarGrupos(p.grupos, (grupo) => cliente.adicionarAoGrupo(accountId, grupo));
            return null;
          },
        },
      ];
    },

    async estadoParaRevogacao(p) {
      const usuario = await cliente.buscarUsuario(p.email);
      if (usuario === null) return { contaExiste: false, acessoAtivo: false };
      const membros = new Set(usuario.grupos.map(normalizarAcesso));
      return {
        contaExiste: true,
        acessoAtivo: p.grupos.some((g) => membros.has(normalizarAcesso(g))),
      };
    },
  };
}

export function criarConectorJiraDestino(cliente: ClienteJira, opcoes: OpcoesConector): Conector {
  return criarConector(criarFornecedorJiraDestino(cliente), opcoes);
}

async function alterarGrupos(
  grupos: readonly string[],
  alterar: (grupo: string) => Promise<void>,
): Promise<void> {
  let concluidos = 0;
  for (const grupo of new Set(grupos)) {
    try {
      await alterar(grupo);
      concluidos += 1;
    } catch (erro) {
      if (erro instanceof ErroFornecedor && concluidos > 0) {
        throw new ErroFornecedor(erro.tipo, erro.codigo, erro.message, erro.tentarAposMs, true);
      }
      throw erro;
    }
  }
}
