import { type Apontamento, type Conector, type ParametrosSoftexpert } from '@gia/dominio';
import { criarConector, type Fornecedor, type OpcoesConector } from '../motor.js';

export interface UsuarioSoftexpert {
  readonly login: string;
  readonly identificador: string;
  readonly ativo: boolean;
  readonly area: string;
  readonly funcao: string;
  readonly grupoAcesso: string;
}

export type NovoUsuarioSoftexpert = Omit<ParametrosSoftexpert, 'sistema'>;

/**
 * Transporte SOAP via API Gateway. O transporte real escapa o XML com
 * `escaparXml` e trata resposta 2xx com falha no corpo (`Fault`) como
 * `ErroFornecedor('recusado')`.
 */
export interface ClienteSoftexpert {
  testar(): Promise<void>;
  buscarUsuario(login: string): Promise<UsuarioSoftexpert | null>;
  areaExiste(area: string): Promise<boolean>;
  funcaoExiste(funcao: string): Promise<boolean>;
  grupoAcessoExiste(grupo: string): Promise<boolean>;
  criarUsuario(usuario: NovoUsuarioSoftexpert): Promise<string>;
  inativarUsuario(login: string): Promise<void>;
}

const igual = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export function criarFornecedorSoftexpert(cliente: ClienteSoftexpert): Fornecedor<'softexpert'> {
  return {
    sistema: 'softexpert',
    testar: () => cliente.testar(),

    async validar(p) {
      const impedimentos: Apontamento[] = [];
      const existente = await cliente.buscarUsuario(p.login);
      if (existente?.ativo === true) {
        impedimentos.push({
          codigo: 'USUARIO_JA_EXISTE',
          mensagem: 'Já existe usuário SoftExpert com este login.',
        });
      }
      if (!(await cliente.areaExiste(p.area))) {
        impedimentos.push({
          codigo: 'AREA_INEXISTENTE',
          mensagem: 'A área informada não existe no SoftExpert.',
        });
      }
      if (!(await cliente.funcaoExiste(p.funcao))) {
        impedimentos.push({
          codigo: 'FUNCAO_INEXISTENTE',
          mensagem: 'A função informada não existe no SoftExpert.',
        });
      }
      if (!(await cliente.grupoAcessoExiste(p.grupoAcesso))) {
        impedimentos.push({
          codigo: 'GRUPO_INEXISTENTE',
          mensagem: 'O grupo de acesso informado não existe no SoftExpert.',
        });
      }
      return { impedimentos, avisos: [] };
    },

    async consultar(p) {
      const usuario = await cliente.buscarUsuario(p.login);
      if (usuario === null || !usuario.ativo) {
        return {
          contaExiste: false,
          acessosEncontrados: [],
          etapaComprovada: null,
          referenciaExterna: null,
        };
      }
      const completo =
        igual(usuario.area, p.area) &&
        igual(usuario.funcao, p.funcao) &&
        igual(usuario.grupoAcesso, p.grupoAcesso);
      return {
        contaExiste: true,
        acessosEncontrados: [
          `area:${usuario.area}`,
          `funcao:${usuario.funcao}`,
          `grupoAcesso:${usuario.grupoAcesso}`,
        ],
        etapaComprovada: completo ? 'criarUsuario' : null,
        referenciaExterna: usuario.identificador,
      };
    },

    passos(acao, p) {
      if (acao === 'revogar') {
        return [
          {
            etapa: 'inativarUsuario',
            executar: async () => (await cliente.inativarUsuario(p.login), null),
          },
        ];
      }
      const { sistema: _sistema, ...usuario } = p;
      void _sistema;
      return [{ etapa: 'criarUsuario', executar: () => cliente.criarUsuario(usuario) }];
    },

    async estadoParaRevogacao(p) {
      const usuario = await cliente.buscarUsuario(p.login);
      return { contaExiste: usuario !== null, acessoAtivo: usuario?.ativo === true };
    },
  };
}

export function criarConectorSoftexpert(
  cliente: ClienteSoftexpert,
  opcoes: OpcoesConector,
): Conector {
  return criarConector(criarFornecedorSoftexpert(cliente), opcoes);
}
