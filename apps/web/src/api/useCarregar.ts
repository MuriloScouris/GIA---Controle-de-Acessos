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
): { estado: EstadoCarga<T>; recarregar: () => void; atualizacaoFalhou: boolean } {
  const [estado, setEstado] = useState<EstadoCarga<T>>({ situacao: 'carregando' });
  const [atualizacaoFalhou, setAtualizacaoFalhou] = useState(false);
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
        setAtualizacaoFalhou(false);
        setEstado({ situacao: 'ok', dados });
      })
      .catch((erro: unknown) => {
        if (!ativo) return;
        ultimoRef.current = null;
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
          setAtualizacaoFalhou(false);
          setEstado({ situacao: 'ok', dados });
        })
        .catch((erro: unknown) => {
          if (!ativo) return;
          if (erro instanceof ErroApi && (erro.status === 401 || erro.status === 403)) {
            // Sessão expirada ou acesso retirado: para de consultar e troca a tela pelo erro,
            // sem manter na tela dados que a pessoa já não pode ver.
            ultimoRef.current = null;
            setAtualizacaoFalhou(false);
            setEstado({ situacao: 'erro', erro });
          } else {
            // Falha transitória: mantém os dados e avisa que a atualização falhou.
            setAtualizacaoFalhou(true);
          }
        });
    }, intervaloMs);
    return () => {
      ativo = false;
      clearInterval(id);
    };
  }, [intervaloMs]);

  return { estado, recarregar, atualizacaoFalhou };
}
