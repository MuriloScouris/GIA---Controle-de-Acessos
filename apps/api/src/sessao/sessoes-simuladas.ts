import { randomBytes } from 'node:crypto';
import type { PapelHumano } from '@gia/contratos';
import { compararInstantes, somarMs, type Instante, type SessaoAutenticada } from '@gia/dominio';
import type { Relogio } from '../aplicacao/portas.js';

/**
 * Sessão simulada no servidor, no lugar do OIDC com Entra ID. O navegador só
 * guarda um identificador opaco em cookie `HttpOnly`; quem é a pessoa e quais
 * papéis tem fica aqui, no servidor (regra 13). Limitação: as sessões vivem na
 * memória do processo, então não sobrevivem a reinício nem são compartilhadas
 * entre instâncias.
 */
export const PESSOAS_FICTICIAS: Readonly<Record<PapelHumano, SessaoAutenticada>> = {
  solicitante: {
    usuarioId: '5e0f6a10-0000-4000-8000-000000000001',
    nome: 'Solicitante Fictícia (RH)',
    papeis: ['solicitante'],
  },
  revisor: {
    usuarioId: '5e0f6a10-0000-4000-8000-000000000002',
    nome: 'Revisor Fictício',
    papeis: ['revisor'],
  },
  executor: {
    usuarioId: '5e0f6a10-0000-4000-8000-000000000003',
    nome: 'Executora Fictícia',
    papeis: ['executor'],
  },
  auditor: {
    usuarioId: '5e0f6a10-0000-4000-8000-000000000004',
    nome: 'Auditor Fictício',
    papeis: ['auditor'],
  },
  administradorTecnico: {
    usuarioId: '5e0f6a10-0000-4000-8000-000000000005',
    nome: 'Administradora Técnica Fictícia',
    papeis: ['administradorTecnico'],
  },
  administradorGia: {
    usuarioId: '5e0f6a10-0000-4000-8000-000000000006',
    nome: 'Administrador do Gia Fictício',
    papeis: ['administradorGia'],
  },
};

/** Expiração absoluta: a sessão não é renovada pelo uso. */
export const DURACAO_SESSAO_MS = 8 * 60 * 60 * 1000;

export interface SessaoAberta {
  readonly id: string;
  readonly sessao: SessaoAutenticada;
  readonly expiraEm: Instante;
}

export interface SessoesSimuladas {
  abrir(sessao: SessaoAutenticada): SessaoAberta;
  /** Sessão válida para o identificador do cookie, ou `null` se ausente, desconhecida ou expirada. */
  autenticar(id: string | undefined): SessaoAberta | null;
  encerrar(id: string | undefined): void;
}

export function criarSessoesSimuladas(
  relogio: Relogio,
  duracaoMs: number = DURACAO_SESSAO_MS,
): SessoesSimuladas {
  const sessoes = new Map<string, SessaoAberta>();
  return {
    abrir(sessao) {
      const aberta: SessaoAberta = {
        id: randomBytes(32).toString('base64url'),
        sessao: { usuarioId: sessao.usuarioId, nome: sessao.nome, papeis: [...sessao.papeis] },
        expiraEm: somarMs(relogio.agora(), duracaoMs),
      };
      sessoes.set(aberta.id, aberta);
      return aberta;
    },
    autenticar(id) {
      if (id === undefined) return null;
      const aberta = sessoes.get(id);
      if (aberta === undefined) return null;
      if (compararInstantes(relogio.agora(), aberta.expiraEm) >= 0) {
        sessoes.delete(id);
        return null;
      }
      return aberta;
    },
    encerrar(id) {
      if (id !== undefined) sessoes.delete(id);
    },
  };
}
