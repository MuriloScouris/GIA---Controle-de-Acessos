import { useState } from 'react';
import { Button } from 'react-aria-components';
import { criarClienteApi } from '../api/cliente.js';
import { useSessao } from '../sessao/Sessao.js';

const cliente = criarClienteApi('/api');

export function PaginaInicial({ api = cliente }: { api?: typeof cliente }) {
  const { perfil } = useSessao();
  const [estado, setEstado] = useState<'ocioso' | 'carregando' | 'ok' | 'erro'>('ocioso');

  async function verificar() {
    setEstado('carregando');
    try {
      await api.saude();
      setEstado('ok');
    } catch {
      setEstado('erro');
    }
  }

  return (
    <>
      <h1>Início</h1>
      <p>
        Perfil ativo: <strong>{perfil?.nome}</strong> (sessão simulada)
      </p>
      <p>Scaffold: nenhuma tela funcional ainda.</p>
      <Button
        className="botao-secundario"
        onPress={() => void verificar()}
        isDisabled={estado === 'carregando'}
      >
        Verificar API
      </Button>
      <p role="status">
        {estado === 'carregando' && 'Verificando…'}
        {estado === 'ok' && 'API disponível.'}
        {estado === 'erro' && 'API indisponível.'}
      </p>
    </>
  );
}
