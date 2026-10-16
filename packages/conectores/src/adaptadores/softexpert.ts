import { type Apontamento, type Conector, type ParametrosSoftexpert } from '@gia/dominio';
import { criarConector, type Fornecedor, type OpcoesConector } from '../motor.js';

export interface UsuarioSoftexpert {
  /** IDUSER: matrícula, ou CPF formatado para quem não tem matrícula (terceiros). */
  readonly identificador: string;
  readonly login: string;
  /** `null` quando o SE Suite não informa a situação (o `getUserData` não devolve). */
  readonly ativo: boolean | null;
  readonly area: string;
  readonly funcao: string;
  /** `null` quando o SE Suite não informa o grupo de acesso (o `getUserData` não devolve). */
  readonly grupoAcesso: string | null;
}

export type NovoUsuarioSoftexpert = Omit<ParametrosSoftexpert, 'sistema'>;

/**
 * Transporte SOAP via API Gateway. O SE Suite identifica o usuário pelo
 * IDUSER (matrícula ou CPF), não pelo login. O transporte real escapa o XML com
 * `escaparXml` e trata 2xx com `Status FAILURE` ou `Fault` como recusa.
 *
 * As consultas de cadastro devolvem `null` quando o fornecedor não oferece como
 * conferir — o `newUser` é quem decide; o adaptador avisa em vez de afirmar.
 */
export interface ClienteSoftexpert {
  testar(): Promise<void>;
  buscarUsuario(identificador: string): Promise<UsuarioSoftexpert | null>;
  areaExiste(area: string): Promise<boolean | null>;
  funcaoExiste(funcao: string): Promise<boolean | null>;
  grupoAcessoExiste(grupo: string): Promise<boolean | null>;
  /** Devolve a chave do usuário no SE Suite. Recriar o mesmo usuário é sucesso (idempotente). */
  criarUsuario(usuario: NovoUsuarioSoftexpert): Promise<string>;
  inativarUsuario(identificador: string): Promise<void>;
}

const igual = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

const CADASTROS = [
  ['area', 'areaExiste', 'AREA_INEXISTENTE', 'A área informada não existe no SoftExpert.'],
  ['funcao', 'funcaoExiste', 'FUNCAO_INEXISTENTE', 'A função informada não existe no SoftExpert.'],
  [
    'grupoAcesso',
    'grupoAcessoExiste',
    'GRUPO_INEXISTENTE',
    'O grupo de acesso informado não existe no SoftExpert.',
  ],
] as const;

export function criarFornecedorSoftexpert(cliente: ClienteSoftexpert): Fornecedor<'softexpert'> {
  return {
    sistema: 'softexpert',
    testar: () => cliente.testar(),

    async validar(p) {
      const impedimentos: Apontamento[] = [];
      const avisos: Apontamento[] = [];
      const existente = await cliente.buscarUsuario(p.identificador);
      if (existente !== null && !igual(existente.login, p.login)) {
        impedimentos.push({
          codigo: 'IDENTIFICADOR_EM_USO',
          mensagem: 'A matrícula/CPF já pertence a outro login no SoftExpert.',
        });
      } else if (existente !== null && existente.ativo !== false) {
        impedimentos.push({
          codigo: 'USUARIO_JA_EXISTE',
          mensagem: 'Já existe usuário SoftExpert com esta matrícula/CPF.',
        });
      }
      for (const [campo, consulta, codigo, mensagem] of CADASTROS) {
        const existe = await cliente[consulta](p[campo]);
        if (existe === false) impedimentos.push({ codigo, mensagem });
        if (existe === null) {
          avisos.push({
            codigo: 'CADASTRO_NAO_VERIFICAVEL',
            mensagem: `A API do SoftExpert não permite conferir o código de ${campo}; o cadastro confirmará.`,
          });
        }
      }
      return { impedimentos, avisos };
    },

    async consultar(p) {
      const usuario = await cliente.buscarUsuario(p.identificador);
      if (usuario === null || usuario.ativo === false || !igual(usuario.login, p.login)) {
        return {
          contaExiste: false,
          acessosEncontrados: [],
          etapaComprovada: null,
          referenciaExterna: null,
        };
      }
      const acessos = [`area:${usuario.area}`, `funcao:${usuario.funcao}`];
      if (usuario.grupoAcesso !== null) acessos.push(`grupoAcesso:${usuario.grupoAcesso}`);
      // Regra 6: só comprova a etapa quem mostra área, função E grupo iguais ao pedido.
      const completo =
        igual(usuario.area, p.area) &&
        igual(usuario.funcao, p.funcao) &&
        usuario.grupoAcesso !== null &&
        igual(usuario.grupoAcesso, p.grupoAcesso);
      return {
        contaExiste: true,
        acessosEncontrados: acessos,
        etapaComprovada: completo ? 'criarUsuario' : null,
        referenciaExterna: usuario.identificador,
      };
    },

    passos(acao, p) {
      if (acao === 'revogar') {
        return [
          {
            etapa: 'inativarUsuario',
            executar: async () => (await cliente.inativarUsuario(p.identificador), null),
          },
        ];
      }
      const { sistema: _sistema, ...usuario } = p;
      void _sistema;
      return [{ etapa: 'criarUsuario', executar: () => cliente.criarUsuario(usuario) }];
    },

    async estadoParaRevogacao(p) {
      const usuario = await cliente.buscarUsuario(p.identificador);
      // Situação desconhecida conta como ativa: inativar de novo é inofensivo, deixar ativo não.
      return {
        contaExiste: usuario !== null,
        acessoAtivo: usuario !== null && usuario.ativo !== false,
      };
    },
  };
}

export function criarConectorSoftexpert(
  cliente: ClienteSoftexpert,
  opcoes: OpcoesConector,
): Conector {
  return criarConector(criarFornecedorSoftexpert(cliente), opcoes);
}
