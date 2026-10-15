import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';
import { criarBancoDeTeste, TEM_BANCO } from '@gia/persistencia/teste';
import { simuladoresPara, subirGia, subirWorker, type Gia } from '../e2e/apoio.js';
import type { CatalogoSimulado } from '@gia/conectores';

interface Ambiente {
  readonly gia: Gia;
  readonly url: string;
  executarWorker(preparar?: (catalogo: CatalogoSimulado) => void): Promise<void>;
}

/** Somente testes: SPA compilada + proxy HTTP local + API real + banco descartável + worker. */
export const test = base.extend<{ ambiente: Ambiente }>({
  ambiente: async ({ page }, use) => {
    await page.route('**/*', (route) => {
      const host = new URL(route.request().url()).hostname;
      return host === '127.0.0.1' || host === 'localhost' ? route.continue() : route.abort();
    });
    if (!TEM_BANCO)
      throw new Error('E2E exige GIA_DATABASE_URL_TESTE; nenhum teste de navegador é pulado.');
    const banco = await criarBancoDeTeste();
    const gia = subirGia(banco);
    let catalogo: CatalogoSimulado | undefined;
    const dist = fileURLToPath(new URL('../../apps/web/dist/', import.meta.url));
    const raiz = resolve(dist);
    const apiUrl = await gia.app.listen({ host: '127.0.0.1', port: 0 });
    const web = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname.startsWith('/api/')) {
          const partes: Buffer[] = [];
          for await (const parte of req) partes.push(Buffer.from(parte));
          const resposta = await fetch(`${apiUrl}${url.pathname.slice(4)}${url.search}`, {
            method: req.method ?? 'GET',
            redirect: 'manual',
            headers: {
              ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
              ...(req.headers['content-type']
                ? { 'content-type': req.headers['content-type'] }
                : {}),
              ...(req.headers['x-gia-csrf']
                ? { 'x-gia-csrf': String(req.headers['x-gia-csrf']) }
                : {}),
            },
            ...(partes.length ? { body: Buffer.concat(partes) } : {}),
          });
          const headers = Object.fromEntries(resposta.headers);
          // fetch descomprime o body; esses cabeçalhos não podem ser reutilizados.
          delete headers['content-length'];
          delete headers['content-encoding'];
          res.writeHead(resposta.status, headers);
          res.end(Buffer.from(await resposta.arrayBuffer()));
          return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405);
          res.end();
          return;
        }
        const caminho = resolve(raiz, `.${decodeURIComponent(url.pathname)}`);
        if (caminho !== raiz && !caminho.startsWith(raiz + sep)) {
          res.writeHead(404);
          res.end();
          return;
        }
        const extensao = extname(caminho);
        const arquivo = extensao ? caminho : resolve(raiz, 'index.html');
        const mime: Record<string, string> = {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.woff2': 'font/woff2',
          '.svg': 'image/svg+xml',
        };
        try {
          const conteudo = await readFile(arquivo);
          res.writeHead(200, {
            'content-type': mime[extname(arquivo)] ?? 'application/octet-stream',
          });
          res.end(conteudo);
        } catch {
          res.writeHead(404);
          res.end();
        }
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    try {
      web.listen(0, '127.0.0.1');
      await once(web, 'listening');
      const endereco = web.address();
      if (typeof endereco !== 'object' || endereco === null)
        throw new Error('Servidor de teste sem porta');
      await use({
        gia,
        url: `http://127.0.0.1:${endereco.port}`,
        async executarWorker(preparar) {
          if (catalogo === undefined) {
            const itens = await gia.persistencia.executar(async (tx) =>
              (
                await Promise.all((await tx.pedidos.todos()).map((p) => tx.itens.doPedido(p.id)))
              ).flat(),
            );
            catalogo = simuladoresPara(itens);
          }
          preparar?.(catalogo);
          await subirWorker(banco, catalogo.conectores).processarLote();
        },
      });
    } finally {
      web.closeAllConnections();
      await new Promise<void>((r) => web.close(() => r()));
      await gia.fechar();
      await banco.descartar();
    }
  },
});

export { expect };
export async function entrar(page: Page, url: string, nome = 'Administrador do GIA') {
  await page.goto(`${url}/login`);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`^${nome}`) }).click();
  await expect(page.getByRole('heading', { name: 'Painel de chamados' })).toBeVisible();
}

export async function importar(page: Page) {
  await page.getByRole('button', { name: 'Importar do Jira', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

export async function aprovar(page: Page) {
  await page.getByRole('button', { name: 'Aprovar', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Aprovar', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

export async function executar(page: Page) {
  await page.getByRole('button', { name: 'Provisionar todos os itens', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Solicitar execução', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
