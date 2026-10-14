import { normalizarAcesso } from '@gia/dominio';
import { ErroFornecedor } from '../erros.js';
import type {
  ClienteDocusign,
  NovoUsuarioDocusign,
  SituacaoDocusign,
  UsuarioDocusign,
} from '../adaptadores/docusign.js';
import { Roteiro } from './roteiro.js';

export interface EstadoInicialDocusign {
  readonly usuarios?: readonly UsuarioDocusign[];
  readonly perfis?: readonly string[];
  readonly grupos?: readonly string[];
}

/** DocuSign eSignature simulado: o usuário nasce `pendente` até o convite ser aceito. */
export class DocusignSimulado implements ClienteDocusign {
  readonly roteiro = new Roteiro({ primeiro: 'criarUsuario', ultimo: 'criarUsuario' });
  private readonly usuarios = new Map<string, UsuarioDocusign>();
  private readonly perfis: Set<string>;
  private readonly grupos: Set<string>;
  private sequencia = 0;

  constructor(estado: EstadoInicialDocusign = {}) {
    this.perfis = new Set((estado.perfis ?? []).map(normalizarAcesso));
    this.grupos = new Set((estado.grupos ?? []).map(normalizarAcesso));
    for (const usuario of estado.usuarios ?? []) {
      this.usuarios.set(normalizarAcesso(usuario.email), usuario);
    }
  }

  /** Simula a pessoa aceitando o convite (acontece fora do Gia). */
  mudarSituacao(email: string, situacao: SituacaoDocusign): void {
    const usuario = this.usuarios.get(normalizarAcesso(email));
    if (usuario !== undefined) this.usuarios.set(normalizarAcesso(email), { ...usuario, situacao });
  }

  usuario(email: string): UsuarioDocusign | null {
    return this.usuarios.get(normalizarAcesso(email)) ?? null;
  }

  testar(): Promise<void> {
    return this.roteiro.passar('testar', () => undefined);
  }

  buscarUsuario(email: string): Promise<UsuarioDocusign | null> {
    return this.roteiro.passar('buscarUsuario', () => this.usuario(email));
  }

  perfilExiste(perfil: string): Promise<boolean> {
    return this.roteiro.passar('perfilExiste', () => this.perfis.has(normalizarAcesso(perfil)));
  }

  grupoExiste(grupo: string): Promise<boolean> {
    return this.roteiro.passar('grupoExiste', () => this.grupos.has(normalizarAcesso(grupo)));
  }

  criarUsuario(novo: NovoUsuarioDocusign): Promise<string> {
    return this.roteiro.passar('criarUsuario', () => {
      const existente = this.usuario(novo.email);
      if (existente !== null && existente.situacao !== 'encerrado') {
        throw new ErroFornecedor(
          'recusado',
          'USUARIO_JA_EXISTE',
          'Já existe usuário com este e-mail.',
        );
      }
      if (
        !this.perfis.has(normalizarAcesso(novo.perfil)) ||
        !this.grupos.has(normalizarAcesso(novo.grupo))
      ) {
        throw new ErroFornecedor(
          'recusado',
          'PERFIL_OU_GRUPO_INEXISTENTE',
          'Perfil ou grupo inexistente.',
        );
      }
      this.sequencia += 1;
      const id = `docusign-${this.sequencia}`;
      this.usuarios.set(normalizarAcesso(novo.email), {
        id,
        email: novo.email,
        situacao: 'pendente',
        perfil: novo.perfil,
        grupo: novo.grupo,
      });
      return id;
    });
  }

  encerrarUsuario(email: string): Promise<void> {
    return this.roteiro.passar('encerrarUsuario', () => {
      const usuario = this.usuario(email);
      if (usuario === null) {
        throw new ErroFornecedor('recusado', 'CONTA_AUSENTE', 'O usuário não existe no DocuSign.');
      }
      this.usuarios.set(normalizarAcesso(email), { ...usuario, situacao: 'encerrado' });
    });
  }
}
