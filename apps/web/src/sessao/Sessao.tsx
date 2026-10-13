import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { encontrarPerfil, type PerfilDemo } from './perfis.js';

/**
 * SESSÃO SIMULADA — TEMPORÁRIA.
 * Enquanto a integração com o Entra ID (OIDC, sessão em cookie seguro no servidor) não existe,
 * o perfil escolhido na tela de login fica só neste contexto e no localStorage do navegador.
 * Nada aqui autentica ou autoriza de verdade: a autorização continua sendo do servidor.
 * Quando o login real entrar, este módulo deve ser trocado pela sessão devolvida pela API.
 */
const CHAVE_ARMAZENAMENTO = 'gia.sessaoSimulada';

interface ValorSessao {
  readonly perfil: PerfilDemo | null;
  entrar(perfil: PerfilDemo): void;
  sair(): void;
}

const SessaoContext = createContext<ValorSessao | null>(null);

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
}: {
  children: ReactNode;
  /** Perfil de partida (testes); ausente = lê do localStorage. */
  perfilInicial?: PerfilDemo | null;
}) {
  const [perfil, setPerfil] = useState<PerfilDemo | null>(() =>
    perfilInicial !== undefined ? perfilInicial : lerPerfilArmazenado(),
  );

  const entrar = useCallback((escolhido: PerfilDemo) => {
    gravarPerfil(escolhido);
    setPerfil(escolhido);
  }, []);

  const sair = useCallback(() => {
    gravarPerfil(null);
    setPerfil(null);
  }, []);

  const valor = useMemo(() => ({ perfil, entrar, sair }), [perfil, entrar, sair]);
  return <SessaoContext.Provider value={valor}>{children}</SessaoContext.Provider>;
}

export function useSessao(): ValorSessao {
  const valor = useContext(SessaoContext);
  if (!valor) throw new Error('useSessao deve ser usado dentro de SessaoProvider');
  return valor;
}
