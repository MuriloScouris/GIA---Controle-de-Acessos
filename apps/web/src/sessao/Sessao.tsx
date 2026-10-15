import type { Papel } from '@gia/dominio';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useApi } from '../api/ApiProvider.js';
import type { ModoSessao } from '../api/cliente.js';
import { encontrarPerfil, type PerfilDemo } from './perfis.js';

/**
 * Sessão da interface. Quem decide como as pessoas entram é o servidor
 * (`GET /sessao/modo`):
 *
 * - `oidc` (produção): a sessão é a do servidor, em cookie `HttpOnly` aberto pelo
 *   login do Entra ID; a interface só lê `GET /sessao` e sai por `POST`.
 * - `simulada` (só desenvolvimento): o perfil de demonstração escolhido fica neste
 *   contexto e no localStorage, como antes. Nada aqui autoriza de verdade.
 * - `indisponivel`: nenhum login é oferecido — nunca se cai na simulada por falha.
 *
 * A autorização é sempre do servidor; os papéis aqui só decidem o que MOSTRAR.
 */
const CHAVE_ARMAZENAMENTO = 'gia.sessaoSimulada';

/** Quem está na sessão: nome e papéis (vários, quando vêm do Entra ID). */
export interface UsuarioSessao {
  readonly nome: string;
  readonly papeis: readonly Papel[];
}

interface ValorSessao {
  readonly modo: ModoSessao | 'carregando';
  readonly perfil: UsuarioSessao | null;
  /** Só na sessão simulada (desenvolvimento). */
  entrar(perfil: PerfilDemo): void;
  sair(): void;
}

const SessaoContext = createContext<ValorSessao | null>(null);

function usuarioDoPerfil(perfil: PerfilDemo | null): UsuarioSessao | null {
  return perfil === null ? null : { nome: perfil.nome, papeis: [perfil.id] };
}

function lerPerfilArmazenado(): PerfilDemo | null {
  try {
    return encontrarPerfil(window.localStorage.getItem(CHAVE_ARMAZENAMENTO));
  } catch {
    return null;
  }
}

function gravarPerfil(perfil: PerfilDemo | null): void {
  try {
    if (perfil) window.localStorage.setItem(CHAVE_ARMAZENAMENTO, perfil.id);
    else window.localStorage.removeItem(CHAVE_ARMAZENAMENTO);
  } catch {
    // Sem armazenamento disponível: a sessão simulada vale só em memória.
  }
}

export function SessaoProvider({
  children,
  perfilInicial,
  navegar = (url) => window.location.assign(url),
}: {
  children: ReactNode;
  /** Perfil de partida (testes): sessão simulada sem consultar o servidor. */
  perfilInicial?: PerfilDemo | null;
  /** Navegação para fora da aplicação (logout do Entra ID); os testes injetam. */
  navegar?: (url: string) => void;
}) {
  const api = useApi();
  const deTeste = perfilInicial !== undefined;
  const [modo, setModo] = useState<ModoSessao | 'carregando'>(deTeste ? 'simulada' : 'carregando');
  const [perfil, setPerfil] = useState<UsuarioSessao | null>(() =>
    deTeste ? usuarioDoPerfil(perfilInicial) : null,
  );

  useEffect(() => {
    if (deTeste) return;
    let ativo = true;
    void (async () => {
      const lido = await api.modoSessao();
      let usuario: UsuarioSessao | null = null;
      if (lido === 'oidc') {
        const sessao = await api.sessaoAtual().catch(() => null);
        usuario = sessao === null ? null : { nome: sessao.nome, papeis: sessao.papeis };
      } else if (lido === 'simulada') {
        usuario = usuarioDoPerfil(lerPerfilArmazenado());
      }
      if (!ativo) return;
      setPerfil(usuario);
      setModo(lido);
    })();
    return () => {
      ativo = false;
    };
  }, [api, deTeste]);

  const entrar = useCallback(
    (escolhido: PerfilDemo) => {
      if (modo !== 'simulada') return;
      gravarPerfil(escolhido);
      setPerfil(usuarioDoPerfil(escolhido));
    },
    [modo],
  );

  const sair = useCallback(() => {
    setPerfil(null);
    if (modo === 'oidc') {
      // A sessão local cai no servidor; depois, o logout do Entra ID (se o servidor indicar).
      void api
        .sairOidc()
        .catch(() => null)
        .then((destino) => {
          if (destino !== null) navegar(destino);
        });
      return;
    }
    gravarPerfil(null);
    // O logout local vale mesmo se o servidor não responder; o cookie expira por conta própria.
    api.encerrarSessao().catch(() => undefined);
  }, [api, modo, navegar]);

  const valor = useMemo(() => ({ modo, perfil, entrar, sair }), [modo, perfil, entrar, sair]);
  return <SessaoContext.Provider value={valor}>{children}</SessaoContext.Provider>;
}

export function useSessao(): ValorSessao {
  const valor = useContext(SessaoContext);
  if (!valor) throw new Error('useSessao deve ser usado dentro de SessaoProvider');
  return valor;
}
