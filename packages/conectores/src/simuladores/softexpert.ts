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
      this.usuarios.set(normalizarAcesso(usuario.identificador), usuario);
    }
  }

  /** Usuário pelo IDUSER (matrícula ou CPF), como o SE Suite identifica. */
  usuario(identificador: string): UsuarioSoftexpert | null {
    return this.usuarios.get(normalizarAcesso(identificador)) ?? null;
  }

  testar(): Promise<void> {
    return this.roteiro.passar('testar', () => undefined);
  }

  buscarUsuario(identificador: string): Promise<UsuarioSoftexpert | null> {
    return this.roteiro.passar('buscarUsuario', () => this.usuario(identificador));
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
      const existente = this.usuario(novo.identificador);
      if (
        existente !== null &&
        existente.ativo === true &&
        normalizarAcesso(existente.login) === normalizarAcesso(novo.login) &&
        normalizarAcesso(existente.area) === normalizarAcesso(novo.area) &&
        normalizarAcesso(existente.funcao) === normalizarAcesso(novo.funcao) &&
        normalizarAcesso(existente.grupoAcesso ?? '') === normalizarAcesso(novo.grupoAcesso)
      ) {
        // Mesmo usuário já criado (resposta perdida na tentativa anterior): idempotente.
        return existente.identificador;
      }
      if (existente?.ativo === true) {
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
      this.usuarios.set(normalizarAcesso(novo.identificador), {
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

  inativarUsuario(identificador: string): Promise<void> {
    return this.roteiro.passar('inativarUsuario', () => {
      const usuario = this.usuario(identificador);
      if (usuario === null) {
        throw new ErroFornecedor(
          'recusado',
          'CONTA_AUSENTE',
          'O usuário não existe no SoftExpert.',
        );
      }
      this.usuarios.set(normalizarAcesso(identificador), { ...usuario, ativo: false });
    });
  }
}
