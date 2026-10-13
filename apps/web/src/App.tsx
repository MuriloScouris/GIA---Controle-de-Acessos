import { useMemo } from 'react';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { rotas } from './rotas.js';

export function App() {
  const router = useMemo(() => createBrowserRouter(rotas), []);
  return <RouterProvider router={router} />;
}
