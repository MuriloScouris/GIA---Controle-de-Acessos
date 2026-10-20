import { normalizarAcesso } from '@gia/dominio';
import { ehDn, mesmoDn, normalizarDn, valorDoPrimeiroRdn } from '../dn.js';
import { ErroFornecedor } from '../erros.js';
import type { ClienteAd, ContaAd, NovaContaAd } from '../adaptadores/ad.js';
import { Roteiro } from './roteiro.js';

/** OU onde ficam os grupos declarados só pelo nome. */
export const OU_GRUPOS_SIMULADOS = 'OU=Grupos,DC=exemplo,DC=local';

export interface EstadoInicialAd {
  /** `grupos` por nome ou por DN; `gruposDn`, se informado, prevalece. */
  readonly contas?: readonly (Omit<ContaAd, 'gruposDn'> & {
    readonly gruposDn?: readonly string[];
  })[];
  readonly ous?: readonly string[];
  /**
   * Grupos existentes, por DN (`CN=GG-VPN,OU=TI,DC=...`) ou só pelo nome, que
   * vira `CN=<nome>,OU=Grupos,DC=exemplo,DC=local`. Dois DNs com o mesmo `cn`
   * modelam homônimos em OUs diferentes.
   */
  readonly grupos?: readonly string[];
}

interface ContaSimulada {
  guid: string;
  login: string;
  cpf: string;
  email: string;
  habilitada: boolean;
  senhaDefinida: boolean;
  ou: string;
  /** DNs dos grupos da conta (o `memberOf`). */
  grupos: string[];
}

/** Active Directory simulado em memória. Nunca abre rede nem guarda senha. */
export class AdSimulado implements ClienteAd {
  readonly roteiro = new Roteiro({
    primeiro: 'criarContaDesabilitada',
    ultimo: 'adicionarAoGrupo',
  });
  private readonly contas = new Map<string, ContaSimulada>();
  private readonly ous: Set<string>;
  /** DN normalizado → DN como declarado. */
  private readonly grupos = new Map<string, string>();
  private sequencia = 0;

  constructor(estado: EstadoInicialAd = {}) {
    this.ous = new Set(estado.ous ?? []);
    for (const grupo of estado.grupos ?? []) {
      const dn = ehDn(grupo) ? grupo : `CN=${grupo},${OU_GRUPOS_SIMULADOS}`;
      this.grupos.set(normalizarDn(dn), dn);
    }
    for (const conta of estado.contas ?? []) {
      const { gruposDn, ...resto } = conta;
      this.contas.set(normalizarAcesso(conta.login), {
        ...resto,
        senhaDefinida: true,
        grupos: [...(gruposDn ?? conta.grupos.map((g) => this.dnDeclarado(g)))],
      });
    }
  }

  /** Retrato do que o AD simulado guarda, para as asserções dos testes. */
  conta(login: string): ContaAd | null {
    const conta = this.contas.get(normalizarAcesso(login));
    return conta === undefined ? null : this.publica(conta);
  }

  testar(): Promise<void> {
    return this.roteiro.passar('testar', () => undefined);
  }

  buscarConta(login: string): Promise<ContaAd | null> {
    return this.roteiro.passar('buscarConta', () => this.conta(login));
  }

  buscarContaPorEmail(email: string): Promise<ContaAd | null> {
    return this.roteiro.passar('buscarContaPorEmail', () => {
      const procurado = normalizarAcesso(email);
      const achada = [...this.contas.values()].find((c) => normalizarAcesso(c.email) === procurado);
      return achada === undefined ? null : this.publica(achada);
    });
  }

  ouExiste(ou: string): Promise<boolean> {
    return this.roteiro.passar('ouExiste', () => this.ous.has(ou));
  }

  grupoExiste(grupo: string): Promise<boolean> {
    return this.roteiro.passar('grupoExiste', () => this.dnDoGrupo(grupo) !== null);
  }

  resolverGrupo(grupo: string): Promise<string | null> {
    return this.roteiro.passar('resolverGrupo', () => this.dnDoGrupo(grupo));
  }

  criarContaDesabilitada(nova: NovaContaAd): Promise<string> {
    return this.roteiro.passar('criarContaDesabilitada', () => {
      if (this.contas.has(normalizarAcesso(nova.login))) {
        throw new ErroFornecedor('recusado', 'LOGIN_EM_USO', 'O login já existe no AD.');
      }
      this.sequencia += 1;
      const guid = `ad-guid-${this.sequencia}`;
      this.contas.set(normalizarAcesso(nova.login), {
        guid,
        login: nova.login,
        cpf: nova.cpf,
        email: nova.email,
        habilitada: false,
        senhaDefinida: false,
        ou: nova.ou,
        grupos: [],
      });
      return guid;
    });
  }

  definirSenhaInicial(login: string): Promise<void> {
    return this.roteiro.passar('definirSenhaInicial', () => {
      this.exigir(login).senhaDefinida = true;
    });
  }

  habilitarConta(login: string): Promise<void> {
    return this.roteiro.passar('habilitarConta', () => {
      const conta = this.exigir(login);
      if (!conta.senhaDefinida) {
        throw new ErroFornecedor(
          'recusado',
          'SENHA_NAO_DEFINIDA',
          'A conta não pode ser habilitada sem senha.',
        );
      }
      conta.habilitada = true;
    });
  }

  adicionarAoGrupo(login: string, grupo: string): Promise<void> {
    return this.roteiro.passar('adicionarAoGrupo', () => {
      const conta = this.exigir(login);
      const dn = this.dnDoGrupo(grupo);
      if (dn === null) {
        throw new ErroFornecedor('recusado', 'GRUPO_INEXISTENTE', 'O grupo não existe no AD.');
      }
      if (!conta.grupos.some((g) => mesmoDn(g, dn))) conta.grupos.push(dn);
    });
  }

  desabilitarConta(login: string): Promise<void> {
    return this.roteiro.passar('desabilitarConta', () => {
      this.exigir(login).habilitada = false;
    });
  }

  moverParaOu(login: string, ou: string): Promise<void> {
    return this.roteiro.passar('moverParaOu', () => {
      this.exigir(login).ou = ou;
    });
  }

  /** Como o transporte real: por DN exato, ou por `cn` recusando homônimos. */
  private dnDoGrupo(grupo: string): string | null {
    if (ehDn(grupo)) return this.grupos.get(normalizarDn(grupo)) ?? null;
    const achados = [...this.grupos.values()].filter(
      (dn) => normalizarAcesso(valorDoPrimeiroRdn(dn)) === normalizarAcesso(grupo),
    );
    if (achados.length > 1) {
      throw new ErroFornecedor(
        'recusado',
        'AD_GRUPO_AMBIGUO',
        'Mais de um grupo no AD tem este nome; confira no diretório.',
      );
    }
    return achados[0] ?? null;
  }

  /** DN de um grupo da conta inicial informado por nome (o grupo declarado, se único). */
  private dnDeclarado(grupo: string): string {
    if (ehDn(grupo)) return grupo;
    try {
      return this.dnDoGrupo(grupo) ?? `CN=${grupo},${OU_GRUPOS_SIMULADOS}`;
    } catch {
      return `CN=${grupo},${OU_GRUPOS_SIMULADOS}`;
    }
  }

  private exigir(login: string): ContaSimulada {
    const conta = this.contas.get(normalizarAcesso(login));
    if (conta === undefined) {
      throw new ErroFornecedor('recusado', 'CONTA_AUSENTE', 'A conta não existe no AD.');
    }
    return conta;
  }

  private publica(conta: ContaSimulada): ContaAd {
    return {
      guid: conta.guid,
      login: conta.login,
      cpf: conta.cpf,
      email: conta.email,
      habilitada: conta.habilitada,
      ou: conta.ou,
      grupos: conta.grupos.map(valorDoPrimeiroRdn),
      gruposDn: [...conta.grupos],
    };
  }
}
