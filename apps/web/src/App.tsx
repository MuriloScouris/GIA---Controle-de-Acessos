import { useMemo } from 'react';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { ApiProvider } from './api/ApiProvider.js';
import { rotas } from './rotas.js';
import { SessaoProvider } from './sessao/Sessao.js';

export function App() {
  const router = useMemo(() => createBrowserRouter(rotas), []);
  return (
    <ApiProvider>
      <SessaoProvider>
        <RouterProvider router={router} />
      </SessaoProvider>
    </ApiProvider>
  );
}
