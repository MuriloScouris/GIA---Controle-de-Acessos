import { type Apontamento, type Conector, type ParametrosDocusign } from '@gia/dominio';
import { criarConector, type Fornecedor, type OpcoesConector } from '../motor.js';

export type SituacaoDocusign = 'pendente' | 'ativo' | 'encerrado';

export interface UsuarioDocusign {
  readonly id: string;
  readonly email: string;
  /** `pendente` até o convite ser aceito. */
  readonly situacao: SituacaoDocusign;
  readonly perfil: string;
  readonly grupo: string;
}

export type NovoUsuarioDocusign = Omit<ParametrosDocusign, 'sistema'>;

/**
 * Transporte da eSignature REST (JWT Grant). O transporte real trata 2xx com
 * `errorDetails` como erro e lança `ErroFornecedor('recusado')`.
 */
export interface ClienteDocusign {
  testar(): Promise<void>;
  buscarUsuario(email: string): Promise<UsuarioDocusign | null>;
  perfilExiste(perfil: string): Promise<boolean>;
  grupoExiste(grupo: string): Promise<boolean>;
  /** Devolve o ID do usuário criado. */
  criarUsuario(usuario: NovoUsuarioDocusign): Promise<string>;
  encerrarUsuario(email: string): Promise<void>;
}

export function criarFornecedorDocusign(cliente: ClienteDocusign): Fornecedor<'docusign'> {
  return {
    sistema: 'docusign',
    testar: () => cliente.testar(),

    async validar(p) {
      const impedimentos: Apontamento[] = [];
      const avisos: Apontamento[] = [];
      const existente = await cliente.buscarUsuario(p.email);
      if (existente !== null && existente.situacao !== 'encerrado') {
        impedimentos.push({
          codigo: 'USUARIO_JA_EXISTE',
          mensagem: 'Já existe usuário DocuSign com este e-mail.',
        });
      }
      if (!(await cliente.perfilExiste(p.perfil))) {
        impedimentos.push({
          codigo: 'PERFIL_INEXISTENTE',
          mensagem: 'O perfil informado não existe no DocuSign.',
        });
      }
      if (!(await cliente.grupoExiste(p.grupo))) {
        impedimentos.push({
          codigo: 'GRUPO_INEXISTENTE',
          mensagem: 'O grupo informado não existe no DocuSign.',
        });
      }
      avisos.push({
        codigo: 'CONVITE_PENDENTE',
        mensagem: 'A conta fica pendente até a pessoa aceitar o convite.',
      });
      return { impedimentos, avisos };
    },

    async consultar(p) {
      const usuario = await cliente.buscarUsuario(p.email);
      if (usuario === null || usuario.situacao === 'encerrado') {
        return {
          contaExiste: false,
          acessosEncontrados: [],
          etapaComprovada: null,
          referenciaExterna: null,
        };
      }
      const perfilOk = usuario.perfil.trim().toLowerCase() === p.perfil.trim().toLowerCase();
      const grupoOk = usuario.grupo.trim().toLowerCase() === p.grupo.trim().toLowerCase();
      return {
        contaExiste: true,
        acessosEncontrados: [`perfil:${usuario.perfil}`, `grupo:${usuario.grupo}`],
        etapaComprovada: perfilOk && grupoOk ? 'criarUsuarioComPerfilEGrupo' : null,
        referenciaExterna: usuario.id,
      };
    },

    passos(acao, p) {
      if (acao === 'revogar') {
        return [
          {
            etapa: 'encerrarUsuario',
            executar: async () => (await cliente.encerrarUsuario(p.email), null),
          },
        ];
      }
      const { sistema: _sistema, ...usuario } = p;
      void _sistema;
      return [
        { etapa: 'criarUsuarioComPerfilEGrupo', executar: () => cliente.criarUsuario(usuario) },
      ];
    },

    async estadoParaRevogacao(p) {
      const usuario = await cliente.buscarUsuario(p.email);
      return {
        contaExiste: usuario !== null,
        acessoAtivo: usuario !== null && usuario.situacao !== 'encerrado',
      };
    },
  };
}

export function criarConectorDocusign(cliente: ClienteDocusign, opcoes: OpcoesConector): Conector {
  return criarConector(criarFornecedorDocusign(cliente), opcoes);
}
