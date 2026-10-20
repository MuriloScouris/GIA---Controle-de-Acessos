import { normalizarAcesso, type Apontamento, type Conector, type ParametrosAd } from '@gia/dominio';
import { mesmoDn } from '../dn.js';
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
  /** `cn` de cada grupo (só para exibição: dois grupos podem ter o mesmo `cn`). */
  readonly grupos: readonly string[];
  /** DN exato de cada grupo (`memberOf`): é por ele que a filiação é comparada (DEV-305). */
  readonly gruposDn: readonly string[];
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
  /**
   * DN do grupo configurado (por DN ou por nome), ou `null` se não existe.
   * Nome com mais de um grupo no AD lança `AD_GRUPO_AMBIGUO`.
   */
  resolverGrupo(grupo: string): Promise<string | null>;
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
        let dn: string | null;
        try {
          dn = await cliente.resolverGrupo(grupo);
        } catch (erro) {
          if (erro instanceof ErroFornecedor && erro.codigo === CODIGO_GRUPO_AMBIGUO) {
            impedimentos.push({
              codigo: 'GRUPO_AMBIGUO',
              mensagem: `Há mais de um grupo "${grupo}" no AD; configure o grupo pelo DN.`,
            });
            continue;
          }
          throw erro;
        }
        if (dn === null) {
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
      // Presente só se o DN do grupo configurado está no memberOf: um homônimo
      // em outra OU não conta (DEV-305). O configurado confirmado aparece no
      // formato de `acessosEsperados`; as demais filiações, pelo DN.
      const presentes: string[] = [];
      const confirmados: string[] = [];
      for (const grupo of p.grupos) {
        const dn = await cliente.resolverGrupo(grupo);
        const membro = dn === null ? undefined : conta.gruposDn.find((m) => mesmoDn(m, dn));
        if (membro !== undefined) {
          presentes.push(grupo);
          confirmados.push(membro);
        }
      }
      const gruposCompletos = presentes.length === p.grupos.length;
      const outros = conta.gruposDn.filter((dn) => !confirmados.some((c) => mesmoDn(c, dn)));
      const acessos = new Map<string, string>();
      for (const acesso of [
        ...presentes.map((grupo) => `grupo:${grupo}`),
        ...outros.map((dn) => `grupo:${dn}`),
      ])
        if (!acessos.has(normalizarAcesso(acesso))) acessos.set(normalizarAcesso(acesso), acesso);
      return {
        contaExiste: true,
        acessosEncontrados: [...acessos.values()],
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

export const CODIGO_GRUPO_AMBIGUO = 'AD_GRUPO_AMBIGUO';

/**
 * Adiciona os grupos configurados que a conta ainda não tem. Cada grupo é
 * resolvido para o DN e comparado com o `memberOf` pelo DN (DEV-305), então:
 *
 * - na retomada (M2), o grupo já aplicado numa tentativa anterior não é
 *   reenviado, e um homônimo em outra OU não conta como aplicado;
 * - grupo repetido na configuração (mesmo DN) entra uma vez só;
 * - a escrita usa o DN resolvido, nunca o nome.
 *
 * Se algo falha depois de um grupo ter entrado nesta chamada, a falha carrega
 * `progressoConfirmado` e o resultado é `parcial`, não `semEfeito` (M2).
 */
async function adicionarGrupos(
  cliente: ClienteAd,
  login: string,
  grupos: readonly string[],
): Promise<void> {
  let adicionados = 0;
  const comProgresso = async <T>(chamar: () => Promise<T>, leitura: boolean): Promise<T> => {
    try {
      return await chamar();
    } catch (erro) {
      if (!(erro instanceof ErroFornecedor)) throw erro;
      // Uma leitura que não respondeu não mudou nada no destino.
      const tipo =
        leitura && (erro.tipo === 'timeout' || erro.tipo === 'respostaPerdida')
          ? 'conexaoRecusada'
          : erro.tipo;
      throw new ErroFornecedor(tipo, erro.codigo, erro.message, erro.tentarAposMs, adicionados > 0);
    }
  };
  const conta = await comProgresso(() => cliente.buscarConta(login), true);
  if (conta === null) {
    throw new ErroFornecedor('recusado', 'CONTA_AUSENTE', 'A conta não existe no AD.');
  }
  const aplicados = [...conta.gruposDn];
  for (const grupo of grupos) {
    const dn = await comProgresso(() => cliente.resolverGrupo(grupo), true);
    if (dn === null) {
      throw new ErroFornecedor(
        'recusado',
        'GRUPO_INEXISTENTE',
        'O grupo não existe no AD.',
        null,
        adicionados > 0,
      );
    }
    if (aplicados.some((membro) => mesmoDn(membro, dn))) continue;
    await comProgresso(() => cliente.adicionarAoGrupo(login, dn), false);
    aplicados.push(dn);
    adicionados += 1;
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
