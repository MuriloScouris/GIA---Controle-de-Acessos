import { Link } from 'react-aria-components';
import type { RouteObject } from 'react-router';
import { Layout } from './Layout.js';
import { PaginaInicial } from './paginas/PaginaInicial.js';

function NaoEncontrada() {
  return (
    <>
      <h1>Página não encontrada</h1>
      <Link href="/">Voltar ao início</Link>
    </>
  );
}

/** Roteamento explícito. Telas de negócio entram em issues próprias. */
export const rotas: RouteObject[] = [
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <PaginaInicial /> },
      { path: '*', element: <NaoEncontrada /> },
    ],
  },
];
