import { useCallback, useEffect, useRef, useState } from 'react';
import { ErroApi } from './cliente.js';

export type EstadoCarga<T> =
  | { readonly situacao: 'carregando' }
  | { readonly situacao: 'ok'; readonly dados: T }
  | { readonly situacao: 'erro'; readonly erro: ErroApi };

interface Opcoes<T> {
  /**
   * Atualiza os dados a cada `intervaloMs` enquanto o predicado, aplicado aos dados mais
   * recentes, for verdadeiro (progresso por item sem recarregar a página). A atualização em
   * segundo plano não troca a tela por "carregando" nem derruba a tela em caso de falha.
   */
  readonly atualizarEnquanto?: {
    readonly intervaloMs: number;
    readonly quando: (dados: T) => boolean;
  };
}

/**
 * Carrega dados da API. Quem usa deve remontar o componente (`key`) quando a consulta muda.
 * `recarregar` busca de novo mantendo os dados atuais na tela; só um erro volta a "carregando".
 */
export function useCarregar<T>(
  carregar: () => Promise<T>,
  opcoes: Opcoes<T> = {},
): { estado: EstadoCarga<T>; recarregar: () => void } {
  const [estado, setEstado] = useState<EstadoCarga<T>>({ situacao: 'carregando' });
  const [contador, setContador] = useState(0);
  const carregarRef = useRef(carregar);
  const ultimoRef = useRef<T | null>(null);
  const atualizar = opcoes.atualizarEnquanto;
  const atualizarRef = useRef(atualizar);

  useEffect(() => {
    carregarRef.current = carregar;
    atualizarRef.current = atualizar;
  });

  const recarregar = useCallback(() => {
    setEstado((atual) => (atual.situacao === 'erro' ? { situacao: 'carregando' } : atual));
    setContador((n) => n + 1);
  }, []);

  useEffect(() => {
    let ativo = true;
    carregarRef
      .current()
      .then((dados) => {
        if (!ativo) return;
        ultimoRef.current = dados;
        setEstado({ situacao: 'ok', dados });
      })
      .catch((erro: unknown) => {
        if (!ativo) return;
        setEstado({
          situacao: 'erro',
          erro: erro instanceof ErroApi ? erro : new ErroApi('Falha inesperada'),
        });
      });
    return () => {
      ativo = false;
    };
  }, [contador]);

  const intervaloMs = atualizar?.intervaloMs ?? null;
  useEffect(() => {
    if (intervaloMs === null) return undefined;
    let ativo = true;
    const id = setInterval(() => {
      const ultimo = ultimoRef.current;
      const quando = atualizarRef.current?.quando;
      if (ultimo === null || quando === undefined || !quando(ultimo)) return;
      carregarRef
        .current()
        .then((dados) => {
          if (!ativo) return;
          ultimoRef.current = dados;
          setEstado({ situacao: 'ok', dados });
        })
        .catch(() => undefined);
    }, intervaloMs);
    return () => {
      ativo = false;
      clearInterval(id);
    };
  }, [intervaloMs]);

  return { estado, recarregar };
}
