import { Button } from 'react-aria-components';
import { Navigate, Outlet } from 'react-router';
import { useSessao } from './sessao/Sessao.js';
import { TITULO_APLICACAO } from './titulo.js';

/** Layout das telas internas; sem sessão (simulada) redireciona para o login. */
export function Layout() {
  const { perfil, sair } = useSessao();
  if (!perfil) return <Navigate to="/login" replace />;

  return (
    <>
      <a className="pular-conteudo" href="#conteudo">
        Pular para o conteúdo
      </a>
      <header className="cabecalho">
        <p className="cabecalho-titulo">{TITULO_APLICACAO}</p>
        <div className="cabecalho-sessao">
          <span>
            Perfil: <strong>{perfil.nome}</strong>
          </span>
          <Button className="botao-link" onPress={sair}>
            Sair
          </Button>
        </div>
      </header>
      <main id="conteudo" className="conteudo" tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}
