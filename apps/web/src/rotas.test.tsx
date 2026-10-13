import { renderToString } from 'react-dom/server';
import {
  StaticRouterProvider,
  createMemoryRouter,
  createStaticHandler,
  createStaticRouter,
  type StaticHandlerContext,
} from 'react-router';
import { describe, expect, it } from 'vitest';
import { rotas } from './rotas.js';

async function renderizar(caminho: string): Promise<string> {
  const handler = createStaticHandler(rotas);
  const contexto = (await handler.query(
    new Request(`http://teste${caminho}`),
  )) as StaticHandlerContext;
  const router = createStaticRouter(handler.dataRoutes, contexto);
  return renderToString(<StaticRouterProvider router={router} context={contexto} />);
}

describe('rotas do web', () => {
  it('renderiza a página inicial com landmark principal e link de pular conteúdo', async () => {
    const html = await renderizar('/');
    expect(html).toContain('<main');
    expect(html).toContain('Pular para o conteúdo');
    expect(html).toContain('Verificar API');
  });

  it('renderiza página não encontrada em rota desconhecida', async () => {
    expect(await renderizar('/nao-existe')).toContain('Página não encontrada');
  });

  it('declara as rotas explicitamente', () => {
    expect(createMemoryRouter(rotas).routes).toHaveLength(1);
  });
});
