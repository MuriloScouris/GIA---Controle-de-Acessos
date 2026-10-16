import { normalizarAcesso } from '@gia/dominio';
import { ErroFornecedor } from '../erros.js';
import type { ClienteGraph, UsuarioEntra } from '../adaptadores/m365.js';
import { Roteiro } from './roteiro.js';

export interface EstadoInicialM365 {
  /** Identidades já sincronizadas do AD para o Entra ID, por UPN. */
  readonly usuarios?: readonly (UsuarioEntra & { readonly upn: string })[];
  readonly planos?: readonly string[];
  readonly grupos?: readonly string[];
}

interface UsuarioSimulado {
  id: string;
  paisUso: string | null;
  licencas: string[];
  grupos: string[];
}

/**
 * Microsoft Graph simulado. Não existe operação de criar usuário: a identidade
 * só aparece quando o teste chama `sincronizarIdentidade` (o que o AD faz fora do Gia).
 */
export class GraphSimulado implements ClienteGraph {
  readonly roteiro = new Roteiro({ primeiro: 'definirPaisDeUso', ultimo: 'adicionarAoGrupo' });
  private readonly usuarios = new Map<string, UsuarioSimulado>();
  private readonly planos: Set<string>;
  private readonly grupos: Set<string>;
  private sequencia = 0;

  constructor(estado: EstadoInicialM365 = {}) {
    this.planos = new Set((estado.planos ?? []).map(normalizarAcesso));
    this.grupos = new Set((estado.grupos ?? []).map(normalizarAcesso));
    for (const { upn, ...usuario } of estado.usuarios ?? []) {
      this.usuarios.set(normalizarAcesso(upn), {
        ...usuario,
        licencas: [...usuario.licencas],
        grupos: [...usuario.grupos],
      });
    }
  }

  /** Simula a sincronização AD → Entra ID, que acontece fora do Gia. */
  sincronizarIdentidade(upn: string): void {
    const chave = normalizarAcesso(upn);
    if (this.usuarios.has(chave)) return;
    this.sequencia += 1;
    this.usuarios.set(chave, {
      id: `entra-${this.sequencia}`,
      paisUso: null,
      licencas: [],
      grupos: [],
    });
  }

  usuario(upn: string): UsuarioEntra | null {
    const usuario = this.usuarios.get(normalizarAcesso(upn));
    return usuario === undefined
      ? null
      : { ...usuario, licencas: [...usuario.licencas], grupos: [...usuario.grupos] };
  }

  testar(): Promise<void> {
    return this.roteiro.passar('testar', () => undefined);
  }

  buscarUsuario(upn: string): Promise<UsuarioEntra | null> {
    return this.roteiro.passar('buscarUsuario', () => this.usuario(upn));
  }

  planoExiste(plano: string): Promise<boolean> {
    return this.roteiro.passar('planoExiste', () => this.planos.has(normalizarAcesso(plano)));
  }

  grupoExiste(grupo: string): Promise<boolean> {
    return this.roteiro.passar('grupoExiste', () => this.grupos.has(normalizarAcesso(grupo)));
  }

  definirPaisDeUso(upn: string, pais: string): Promise<void> {
    return this.roteiro.passar('definirPaisDeUso', () => {
      this.exigir(upn).paisUso = pais;
    });
  }

  atribuirLicencas(upn: string, planos: readonly string[]): Promise<void> {
    return this.roteiro.passar('atribuirLicencas', () => {
      const usuario = this.exigir(upn);
      if (usuario.paisUso === null) {
        throw new ErroFornecedor(
          'recusado',
          'PAIS_DE_USO_AUSENTE',
          'Defina o país de uso antes de licenciar.',
        );
      }
      for (const plano of planos) {
        if (!this.planos.has(normalizarAcesso(plano))) {
          throw new ErroFornecedor(
            'recusado',
            'PLANO_INEXISTENTE',
            'O plano de licença não existe.',
          );
        }
        if (!usuario.licencas.some((l) => normalizarAcesso(l) === normalizarAcesso(plano))) {
          usuario.licencas.push(plano);
        }
      }
    });
  }

  adicionarAoGrupo(upn: string, grupo: string): Promise<void> {
    return this.roteiro.passar('adicionarAoGrupo', () => {
      const usuario = this.exigir(upn);
      if (!this.grupos.has(normalizarAcesso(grupo))) {
        throw new ErroFornecedor('recusado', 'GRUPO_INEXISTENTE', 'O grupo não existe no M365.');
      }
      if (!usuario.grupos.some((g) => normalizarAcesso(g) === normalizarAcesso(grupo))) {
        usuario.grupos.push(grupo);
      }
    });
  }

  removerLicencas(upn: string, planos: readonly string[]): Promise<void> {
    return this.roteiro.passar('removerLicencas', () => {
      const usuario = this.exigir(upn);
      const remover = new Set(planos.map(normalizarAcesso));
      usuario.licencas = usuario.licencas.filter((l) => !remover.has(normalizarAcesso(l)));
    });
  }

  /** Pelo UPN ou pelo id do Entra ID, como o Graph aceita. */
  private exigir(idOuUpn: string): UsuarioSimulado {
    const usuario =
      this.usuarios.get(normalizarAcesso(idOuUpn)) ??
      [...this.usuarios.values()].find((u) => u.id === idOuUpn);
    if (usuario === undefined) {
      throw new ErroFornecedor('recusado', 'USUARIO_AUSENTE', 'O usuário não existe no Entra ID.');
    }
    return usuario;
  }
}
