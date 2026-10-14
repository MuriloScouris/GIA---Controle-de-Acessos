import { Button } from 'react-aria-components';
import type { ErroApi } from '../api/cliente.js';
import { useSessao } from '../sessao/Sessao.js';

/** Estados de erro de leitura e de falta de permissão, distintos entre si (spec). */
export function ErroCarga({ erro, onTentarDeNovo }: { erro: ErroApi; onTentarDeNovo: () => void }) {
  const { sair } = useSessao();

  if (erro.status === 401) {
    return (
      <div role="alert" className="estado estado-erro">
        <p>Sua sessão expirou ou não foi aberta no servidor.</p>
        <Button className="botao-primario" onPress={sair}>
          Entrar novamente
        </Button>
      </div>
    );
  }
  if (erro.status === 403) {
    return (
      <div role="alert" className="estado estado-erro">
        <p>Você não tem permissão para ver esta informação.</p>
      </div>
    );
  }
  if (erro.status === 404) {
    return (
      <div role="alert" className="estado estado-erro">
        <p>Não encontrado. O registro não existe ou você não tem acesso a ele.</p>
      </div>
    );
  }
  return (
    <div role="alert" className="estado estado-erro">
      <p>Não foi possível carregar os dados. Tente de novo.</p>
      <Button className="botao-secundario" onPress={onTentarDeNovo}>
        Tentar de novo
      </Button>
    </div>
  );
}
