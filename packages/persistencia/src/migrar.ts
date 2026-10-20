import { pathToFileURL } from 'node:url';
import { ErroConfiguracao } from '@gia/contratos';
import { resolverSegredosDeArquivo } from '@gia/contratos/segredos';
import { criarBanco, urlDoBanco } from './postgres/conexao.js';
import { migrarParaUltima } from './postgres/migrador.js';

/**
 * `pnpm --filter @gia/persistencia migrar`: aplica as migrações pendentes em
 * `GIA_DATABASE_URL`. Como API e worker, aceita a URL por arquivo do cofre
 * (`GIA_DATABASE_URL_ARQUIVO`) e, em produção, recusa URL com senha por valor.
 */
export async function migrar(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<readonly string[]> {
  const resolvido = await resolverSegredosDeArquivo(env);
  const db = criarBanco({ url: urlDoBanco(resolvido) });
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
      // ErroConfiguracao e urlDoBanco só citam nomes de variáveis; erros do driver
      // podem trazer a URL, então não são impressos.
      console.error(
        erro instanceof ErroConfiguracao ||
          (erro instanceof Error && erro.message.startsWith('Configuração inválida'))
          ? erro.message
          : 'falha ao migrar',
      );
      process.exitCode = 1;
    },
  );
}
