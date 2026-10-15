import { normalizarAcesso, type Apontamento, type Conector, type Etapa } from '@gia/dominio';
import { ErroFornecedor } from '../erros.js';
import { criarConector, type Fornecedor, type OpcoesConector } from '../motor.js';

export interface UsuarioEntra {
  readonly id: string;
  readonly paisUso: string | null;
  /** Planos de licença atribuídos. */
  readonly licencas: readonly string[];
  readonly grupos: readonly string[];
}

/**
 * Transporte do Microsoft Graph. Regra 7: não há método para criar usuário;
 * o M365 só licencia a identidade que o AD já sincronizou para o Entra ID.
 */
export interface ClienteGraph {
  testar(): Promise<void>;
  /**
   * Procura pelo UPN e, se não achar, pelo e-mail: o UPN do AD só sobrevive à
   * sincronização quando o sufixo é domínio verificado no tenant.
   */
  buscarUsuario(upn: string, email?: string): Promise<UsuarioEntra | null>;
  planoExiste(plano: string): Promise<boolean>;
  /** Assentos livres do plano; `null` quando o transporte não informa. */
  assentosLivres?(plano: string): Promise<number | null>;
  grupoExiste(grupo: string): Promise<boolean>;
  /** As escritas recebem o objectId do Entra ID (ou o UPN): o Graph aceita os dois. */
  definirPaisDeUso(idOuUpn: string, pais: string): Promise<void>;
  /** Atribui só as licenças informadas (as já atribuídas não são repetidas pelo adaptador). */
  atribuirLicencas(idOuUpn: string, planos: readonly string[]): Promise<void>;
  adicionarAoGrupo(idOuUpn: string, grupo: string): Promise<void>;
  /** Remove só os planos informados que a conta tiver; nenhuma outra licença. */
  removerLicencas(idOuUpn: string, planos: readonly string[]): Promise<void>;
}

/** Abaixo disto a validação avisa que os assentos do plano estão acabando. */
export const LIMITE_AVISO_ASSENTOS = 3;

export function criarFornecedorM365(cliente: ClienteGraph): Fornecedor<'m365'> {
  return {
    sistema: 'm365',
    testar: () => cliente.testar(),

    async validar(p) {
      const impedimentos: Apontamento[] = [];
      const avisos: Apontamento[] = [];
      if ((await cliente.buscarUsuario(p.upn, p.email)) === null) {
        avisos.push({
          codigo: 'IDENTIDADE_NAO_SINCRONIZADA',
          mensagem:
            'A identidade ainda não está no Entra ID; o licenciamento aguarda a sincronização do AD.',
        });
      }
      for (const plano of p.planosLicenca) {
        if (!(await cliente.planoExiste(plano))) {
          impedimentos.push({
            codigo: 'PLANO_INEXISTENTE',
            mensagem: `O plano de licença "${plano}" não existe no tenant.`,
          });
          continue;
        }
        const livres = (await cliente.assentosLivres?.(plano)) ?? null;
        if (livres !== null && livres <= 0) {
          impedimentos.push({
            codigo: 'SEM_ASSENTO',
            mensagem: `Não há assento livre do plano "${plano}" no tenant.`,
          });
        } else if (livres !== null && livres <= LIMITE_AVISO_ASSENTOS) {
          avisos.push({
            codigo: 'POUCOS_ASSENTOS',
            mensagem: `Restam ${livres} assento(s) do plano "${plano}" no tenant.`,
          });
        }
      }
      if (p.grupo !== null && !(await cliente.grupoExiste(p.grupo))) {
        impedimentos.push({
          codigo: 'GRUPO_INEXISTENTE',
          mensagem: 'O grupo informado não existe no M365.',
        });
      }
      return { impedimentos, avisos };
    },

    async consultar(p) {
      const usuario = await cliente.buscarUsuario(p.upn, p.email);
      if (usuario === null) {
        return {
          contaExiste: false,
          acessosEncontrados: [],
          etapaComprovada: null,
          referenciaExterna: null,
        };
      }
      const licencas = new Set(usuario.licencas.map(normalizarAcesso));
      const grupos = new Set(usuario.grupos.map(normalizarAcesso));
      const temPais = usuario.paisUso !== null && usuario.paisUso.toUpperCase() === p.paisUso;
      const temLicencas = p.planosLicenca.every((plano) => licencas.has(normalizarAcesso(plano)));
      const temGrupo = p.grupo === null || grupos.has(normalizarAcesso(p.grupo));
      // Cada etapa só é comprovada se as anteriores também foram.
      const cadeia: readonly (readonly [Etapa, boolean])[] = [
        ['aguardarIdentidadeSincronizada', true],
        ['definirPais', temPais],
        ['atribuirLicencas', temLicencas],
        ['adicionarGrupo', temGrupo],
      ];
      let etapaComprovada: Etapa | null = null;
      for (const [etapa, comprovada] of cadeia) {
        if (!comprovada) break;
        etapaComprovada = etapa;
      }
      return {
        contaExiste: true,
        acessosEncontrados: [
          ...usuario.licencas.map((plano) => `licenca:${plano}`),
          ...usuario.grupos.map((grupo) => `grupo:${grupo}`),
        ],
        etapaComprovada,
        referenciaExterna: usuario.id,
      };
    },

    passos(acao, p) {
      // A conta é resolvida a cada passo (retomada) e as escritas vão pelo objectId:
      // o UPN do AD pode ter virado `onmicrosoft.com` na sincronização.
      const sincronizado = async (): Promise<UsuarioEntra> => {
        const usuario = await cliente.buscarUsuario(p.upn, p.email);
        if (usuario === null) throw new ErroFornecedor('identidadeNaoSincronizada');
        return usuario;
      };
      if (acao === 'revogar') {
        return [
          {
            etapa: 'removerLicencas',
            executar: async () => {
              const usuario = await cliente.buscarUsuario(p.upn, p.email);
              await cliente.removerLicencas(usuario?.id ?? p.upn, p.planosLicenca);
              return null;
            },
          },
        ];
      }
      return [
        {
          etapa: 'aguardarIdentidadeSincronizada',
          executar: async () => (await sincronizado()).id,
        },
        {
          etapa: 'definirPais',
          executar: async () => {
            await cliente.definirPaisDeUso((await sincronizado()).id, p.paisUso);
            return null;
          },
        },
        {
          etapa: 'atribuirLicencas',
          executar: async () => {
            const usuario = await sincronizado();
            const atuais = new Set(usuario.licencas.map(normalizarAcesso));
            const faltantes = p.planosLicenca.filter(
              (plano) => !atuais.has(normalizarAcesso(plano)),
            );
            if (faltantes.length > 0) await cliente.atribuirLicencas(usuario.id, faltantes);
            return null;
          },
        },
        {
          etapa: 'adicionarGrupo',
          executar: async () => {
            if (p.grupo !== null)
              await cliente.adicionarAoGrupo((await sincronizado()).id, p.grupo);
            return null;
          },
        },
      ];
    },

    async estadoParaRevogacao(p) {
      const usuario = await cliente.buscarUsuario(p.upn, p.email);
      if (usuario === null) return { contaExiste: false, acessoAtivo: false };
      const atuais = new Set(usuario.licencas.map(normalizarAcesso));
      return {
        contaExiste: true,
        acessoAtivo: p.planosLicenca.some((plano) => atuais.has(normalizarAcesso(plano))),
      };
    },
  };
}

export function criarConectorM365(cliente: ClienteGraph, opcoes: OpcoesConector): Conector {
  return criarConector(criarFornecedorM365(cliente), opcoes);
}
