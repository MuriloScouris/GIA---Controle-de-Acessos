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
  // Ordem das consultas: só vale a resposta mais nova já recebida; respostas antigas, que chegam
  // fora de ordem, são descartadas e nunca restauram dados nem escondem um erro mais recente.
  const iniciadasRef = useRef(0);
  const aplicadaRef = useRef(0);
  // Após 401/403 nada em voo pode reabrir a tela; só uma recarga explícita desbloqueia.
  const bloqueadoRef = useRef(false);
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
    bloqueadoRef.current = false;
    const ordem = ++iniciadasRef.current;
    aplicadaRef.current = ordem; // a recarga invalida tudo o que já estava em voo
    const vale = () => {
      if (!ativo || ordem < aplicadaRef.current) return false;
      aplicadaRef.current = ordem;
      return true;
    };
    carregarRef
      .current()
      .then((dados) => {
        if (!vale()) return;
        ultimoRef.current = dados;
        setAtualizacaoFalhou(false);
        setEstado({ situacao: 'ok', dados });
      })
      .catch((erro: unknown) => {
        if (!vale()) return;
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
      const ordem = ++iniciadasRef.current;
      const vale = () => {
        if (!ativo || bloqueadoRef.current || ordem < aplicadaRef.current) return false;
        aplicadaRef.current = ordem;
        return true;
      };
      carregarRef
        .current()
        .then((dados) => {
          if (!vale()) return;
          ultimoRef.current = dados;
          setAtualizacaoFalhou(false);
          setEstado({ situacao: 'ok', dados });
        })
        .catch((erro: unknown) => {
          if (!vale()) return;
          if (erro instanceof ErroApi && (erro.status === 401 || erro.status === 403)) {
            bloqueadoRef.current = true;
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
