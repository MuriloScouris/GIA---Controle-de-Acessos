import { normalizarAcesso } from '@gia/dominio';
import { ErroFornecedor } from '../erros.js';
import type { ClienteAd, ContaAd, NovaContaAd } from '../adaptadores/ad.js';
import { Roteiro } from './roteiro.js';

export interface EstadoInicialAd {
  readonly contas?: readonly ContaAd[];
  readonly ous?: readonly string[];
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
  private readonly grupos: Set<string>;
  private sequencia = 0;

  constructor(estado: EstadoInicialAd = {}) {
    this.ous = new Set(estado.ous ?? []);
    this.grupos = new Set((estado.grupos ?? []).map(normalizarAcesso));
    for (const conta of estado.contas ?? []) {
      this.contas.set(normalizarAcesso(conta.login), {
        ...conta,
        senhaDefinida: true,
        grupos: [...conta.grupos],
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
    return this.roteiro.passar('grupoExiste', () => this.grupos.has(normalizarAcesso(grupo)));
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
      if (!this.grupos.has(normalizarAcesso(grupo))) {
        throw new ErroFornecedor('recusado', 'GRUPO_INEXISTENTE', 'O grupo não existe no AD.');
      }
      if (!conta.grupos.some((g) => normalizarAcesso(g) === normalizarAcesso(grupo))) {
        conta.grupos.push(grupo);
      }
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
      grupos: [...conta.grupos],
    };
  }
}
