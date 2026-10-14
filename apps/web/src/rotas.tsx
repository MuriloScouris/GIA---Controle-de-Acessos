import { Link } from 'react-aria-components';
import type { RouteObject } from 'react-router';
import { Layout } from './Layout.js';
import { PaginaLogin } from './paginas/PaginaLogin.js';
import { PaginaPedido } from './paginas/PaginaPedido.js';
import { PainelPedidos } from './paginas/PainelPedidos.js';

function NaoEncontrada() {
  return (
    <>
      <h1>Página não encontrada</h1>
      <Link href="/">Voltar ao início</Link>
    </>
  );
}

/** Roteamento explícito. Onboarding: painel de chamados e detalhe do pedido. */
export const rotas: RouteObject[] = [
  { path: '/login', element: <PaginaLogin /> },
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <PainelPedidos /> },
      { path: 'pedidos/:pedidoId', element: <PaginaPedido /> },
      { path: '*', element: <NaoEncontrada /> },
    ],
  },
];
