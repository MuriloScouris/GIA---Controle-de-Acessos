import { pathToFileURL } from 'node:url';
import { criarBanco, urlDoBanco } from './postgres/conexao.js';
import { migrarParaUltima } from './postgres/migrador.js';

/** `pnpm --filter @gia/persistencia migrar`: aplica as migrações pendentes em `GIA_DATABASE_URL`. */
export async function migrar(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<readonly string[]> {
  const db = criarBanco({ url: urlDoBanco(env) });
  try {
    return await migrarParaUltima(db);
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrar().then(
    (aplicadas) => {
      console.log(
        aplicadas.length === 0
          ? 'banco já está na última migração'
          : `migrações aplicadas: ${aplicadas.join(', ')}`,
      );
    },
    (erro: unknown) => {
      console.error(erro instanceof Error ? erro.message : 'falha ao migrar');
      process.exitCode = 1;
    },
  );
}
