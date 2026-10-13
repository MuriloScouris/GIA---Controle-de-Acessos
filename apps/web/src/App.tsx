import { useMemo } from 'react';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { rotas } from './rotas.js';
import { SessaoProvider } from './sessao/Sessao.js';

export function App() {
  const router = useMemo(() => createBrowserRouter(rotas), []);
  return (
    <SessaoProvider>
      <RouterProvider router={router} />
    </SessaoProvider>
  );
}
