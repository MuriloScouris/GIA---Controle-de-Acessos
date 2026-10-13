import { pathToFileURL } from 'node:url';
import { criarApp } from './app.js';

const porta = Number(process.env['PORT'] ?? 3000);

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await criarApp().listen({ port: porta, host: '127.0.0.1' });
}

export { criarApp };
