import { normalizarAcesso } from '@gia/dominio';
import { ErroFornecedor } from '../erros.js';
import type {
  ClienteSoftexpert,
  NovoUsuarioSoftexpert,
  UsuarioSoftexpert,
} from '../adaptadores/softexpert.js';
import { Roteiro } from './roteiro.js';

export interface EstadoInicialSoftexpert {
  readonly usuarios?: readonly UsuarioSoftexpert[];
  readonly areas?: readonly string[];
  readonly funcoes?: readonly string[];
  readonly grupos?: readonly string[];
}

/** SoftExpert (SOAP) simulado, sem rede. */
export class SoftexpertSimulado implements ClienteSoftexpert {
  readonly roteiro = new Roteiro({ primeiro: 'criarUsuario', ultimo: 'criarUsuario' });
  private readonly usuarios = new Map<string, UsuarioSoftexpert>();
  private readonly areas: Set<string>;
  private readonly funcoes: Set<string>;
  private readonly grupos: Set<string>;

  constructor(estado: EstadoInicialSoftexpert = {}) {
    this.areas = new Set((estado.areas ?? []).map(normalizarAcesso));
    this.funcoes = new Set((estado.funcoes ?? []).map(normalizarAcesso));
    this.grupos = new Set((estado.grupos ?? []).map(normalizarAcesso));
    for (const usuario of estado.usuarios ?? []) {
      this.usuarios.set(normalizarAcesso(usuario.login), usuario);
    }
  }

  usuario(login: string): UsuarioSoftexpert | null {
    return this.usuarios.get(normalizarAcesso(login)) ?? null;
  }

  testar(): Promise<void> {
    return this.roteiro.passar('testar', () => undefined);
  }

  buscarUsuario(login: string): Promise<UsuarioSoftexpert | null> {
    return this.roteiro.passar('buscarUsuario', () => this.usuario(login));
  }

  areaExiste(area: string): Promise<boolean> {
    return this.roteiro.passar('areaExiste', () => this.areas.has(normalizarAcesso(area)));
  }

  funcaoExiste(funcao: string): Promise<boolean> {
    return this.roteiro.passar('funcaoExiste', () => this.funcoes.has(normalizarAcesso(funcao)));
  }

  grupoAcessoExiste(grupo: string): Promise<boolean> {
    return this.roteiro.passar('grupoAcessoExiste', () => this.grupos.has(normalizarAcesso(grupo)));
  }

  criarUsuario(novo: NovoUsuarioSoftexpert): Promise<string> {
    return this.roteiro.passar('criarUsuario', () => {
      if (this.usuario(novo.login)?.ativo === true) {
        throw new ErroFornecedor(
          'recusado',
          'USUARIO_JA_EXISTE',
          'Já existe usuário com este login.',
        );
      }
      if (
        !this.areas.has(normalizarAcesso(novo.area)) ||
        !this.funcoes.has(normalizarAcesso(novo.funcao)) ||
        !this.grupos.has(normalizarAcesso(novo.grupoAcesso))
      ) {
        throw new ErroFornecedor(
          'recusado',
          'CADASTRO_INEXISTENTE',
          'Área, função ou grupo inexistente.',
        );
      }
      this.usuarios.set(normalizarAcesso(novo.login), {
        login: novo.login,
        identificador: novo.identificador,
        ativo: true,
        area: novo.area,
        funcao: novo.funcao,
        grupoAcesso: novo.grupoAcesso,
      });
      return novo.identificador;
    });
  }

  inativarUsuario(login: string): Promise<void> {
    return this.roteiro.passar('inativarUsuario', () => {
      const usuario = this.usuario(login);
      if (usuario === null) {
        throw new ErroFornecedor(
          'recusado',
          'CONTA_AUSENTE',
          'O usuário não existe no SoftExpert.',
        );
      }
      this.usuarios.set(normalizarAcesso(login), { ...usuario, ativo: false });
    });
  }
}
