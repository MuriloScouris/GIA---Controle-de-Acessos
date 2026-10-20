import { normalizarAcesso, type Apontamento, type Conector, type ParametrosAd } from '@gia/dominio';
import { ErroFornecedor } from '../erros.js';
import { escaparValorDn } from '../escape.js';
import { criarConector, type Fornecedor, type OpcoesConector } from '../motor.js';

export interface ContaAd {
  readonly guid: string;
  readonly login: string;
  readonly cpf: string;
  readonly email: string;
  readonly habilitada: boolean;
  readonly ou: string;
  readonly grupos: readonly string[];
}

/** Dados da conta nova. Sem senha: o transporte gera a credencial inicial a partir do cofre (regra 12). */
export type NovaContaAd = Omit<ParametrosAd, 'sistema'> & { readonly dn: string };

/**
 * Transporte do Active Directory (LDAPS). O transporte real escapa os valores
 * de filtro com `escaparValorFiltroLdap` e lança `ErroFornecedor` nas falhas;
 * adicionar quem já é membro é sucesso (idempotente).
 */
export interface ClienteAd {
  testar(): Promise<void>;
  buscarConta(login: string): Promise<ContaAd | null>;
  buscarContaPorEmail(email: string): Promise<ContaAd | null>;
  ouExiste(ou: string): Promise<boolean>;
  grupoExiste(grupo: string): Promise<boolean>;
  /** Devolve o `objectGUID`. */
  criarContaDesabilitada(conta: NovaContaAd): Promise<string>;
  definirSenhaInicial(login: string): Promise<void>;
  habilitarConta(login: string): Promise<void>;
  adicionarAoGrupo(login: string, grupo: string): Promise<void>;
  desabilitarConta(login: string): Promise<void>;
  moverParaOu(login: string, ou: string): Promise<void>;
}

export interface OpcoesAd {
  /** OU para onde a conta revogada é movida. */
  readonly ouInativos: string;
}

export function criarFornecedorAd(cliente: ClienteAd, opcoes: OpcoesAd): Fornecedor<'ad'> {
  return {
    sistema: 'ad',
    testar: () => cliente.testar(),

    async validar(p) {
      const impedimentos: Apontamento[] = [];
      const avisos: Apontamento[] = [];
      const porLogin = await cliente.buscarConta(p.login);
      if (porLogin !== null) {
        if (porLogin.cpf === p.cpf) {
          avisos.push({
            codigo: 'CONTA_JA_EXISTE_DO_MESMO_TITULAR',
            mensagem:
              'Já existe conta com este login para a mesma pessoa; confira antes de provisionar.',
          });
        } else {
          impedimentos.push({
            codigo: 'LOGIN_EM_USO',
            mensagem: 'O login já está em uso por outra pessoa no AD.',
          });
        }
      }
      const porEmail = await cliente.buscarContaPorEmail(p.email);
      if (porEmail !== null && porEmail.login !== p.login) {
        impedimentos.push({
          codigo: 'EMAIL_EM_USO',
          mensagem: 'O e-mail já está em uso por outra conta no AD.',
        });
      }
      if (!(await cliente.ouExiste(p.ou))) {
        impedimentos.push({
          codigo: 'OU_INEXISTENTE',
          mensagem: 'A OU informada não existe no AD.',
        });
      }
      for (const grupo of p.grupos) {
        if (!(await cliente.grupoExiste(grupo))) {
          impedimentos.push({
            codigo: 'GRUPO_INEXISTENTE',
            mensagem: `O grupo "${grupo}" não existe no AD.`,
          });
        }
      }
      return { impedimentos, avisos };
    },

    async consultar(p) {
      const conta = await cliente.buscarConta(p.login);
      if (conta === null) {
        return {
          contaExiste: false,
          acessosEncontrados: [],
          etapaComprovada: null,
          referenciaExterna: null,
        };
      }
      const membros = new Set(conta.grupos.map(normalizarAcesso));
      const gruposCompletos = p.grupos.every((g) => membros.has(normalizarAcesso(g)));
      return {
        contaExiste: true,
        acessosEncontrados: conta.grupos.map((grupo) => `grupo:${grupo}`),
        etapaComprovada: !conta.habilitada
          ? 'criarContaDesabilitada'
          : gruposCompletos
            ? 'adicionarGrupos'
            : 'habilitarConta',
        referenciaExterna: conta.guid,
      };
    },

    passos(acao, p) {
      if (acao === 'revogar') {
        return [
          {
            etapa: 'desabilitarConta',
            executar: async () => (await cliente.desabilitarConta(p.login), null),
          },
          {
            etapa: 'moverParaOuInativos',
            executar: async () => (await cliente.moverParaOu(p.login, opcoes.ouInativos), null),
          },
        ];
      }
      return [
        {
          etapa: 'criarContaDesabilitada',
          executar: () =>
            cliente.criarContaDesabilitada({
              ...semSistema(p),
              dn: `CN=${escaparValorDn(p.nomeExibicao)},${p.ou}`,
            }),
        },
        {
          etapa: 'definirSenha',
          executar: async () => (await cliente.definirSenhaInicial(p.login), null),
        },
        {
          etapa: 'habilitarConta',
          executar: async () => (await cliente.habilitarConta(p.login), null),
        },
        {
          etapa: 'adicionarGrupos',
          executar: async () => {
            await adicionarGrupos(cliente, p.login, p.grupos);
            return null;
          },
        },
      ];
    },

    async estadoParaRevogacao(p) {
      const conta = await cliente.buscarConta(p.login);
      return {
        contaExiste: conta !== null,
        acessoAtivo: conta !== null && (conta.habilitada || conta.ou !== opcoes.ouInativos),
      };
    },
  };
}

/**
 * Adiciona os grupos um a um, sem repetir o mesmo grupo na chamada. Se um
 * grupo falha depois de outro já ter entrado, a falha carrega
 * `progressoConfirmado` (M2): o resultado vira `parcial`, e não `semEfeito`,
 * então o worker não retenta a etapa inteira às cegas e o item não aparece
 * como "nada feito". Na retomada, adicionar quem já é membro não escreve nada
 * (o transporte confere o `memberOf` por DN antes de alterar o grupo).
 */
async function adicionarGrupos(
  cliente: ClienteAd,
  login: string,
  grupos: readonly string[],
): Promise<void> {
  const vistos = new Set<string>();
  let adicionados = 0;
  for (const grupo of grupos) {
    const chave = normalizarAcesso(grupo);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    try {
      await cliente.adicionarAoGrupo(login, grupo);
      adicionados += 1;
    } catch (erro) {
      if (erro instanceof ErroFornecedor && adicionados > 0) {
        throw new ErroFornecedor(erro.tipo, erro.codigo, erro.message, erro.tentarAposMs, true);
      }
      throw erro;
    }
  }
}

function semSistema(p: ParametrosAd): Omit<ParametrosAd, 'sistema'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { sistema: _sistema, ...resto } = p;
  return resto;
}

export function criarConectorAd(cliente: ClienteAd, opcoes: OpcoesAd & OpcoesConector): Conector {
  return criarConector(criarFornecedorAd(cliente, opcoes), opcoes);
}
