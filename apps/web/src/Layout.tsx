import { Outlet } from 'react-router';
import { TITULO_APLICACAO } from './titulo.js';

export function Layout() {
  return (
    <>
      <a className="pular-conteudo" href="#conteudo">
        Pular para o conteúdo
      </a>
      <header>
        <p>{TITULO_APLICACAO}</p>
      </header>
      <main id="conteudo" tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}
