import { pathToFileURL } from 'node:url';
import { verificarConexaoDocusign } from './cliente.js';

/** `pnpm --filter @gia/conectores docusign:verificar`: homologação somente leitura. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verificarConexaoDocusign(process.env)
    .then((resultado) => {
      console.log(
        `DocuSign: ${resultado.disponivel ? 'disponível' : 'indisponível'} (${resultado.codigo})`,
      );
      if (!resultado.disponivel) process.exitCode = 1;
    })
    .catch((erro: unknown) => {
      console.error(erro instanceof Error ? erro.message : 'falha ao verificar o DocuSign');
      process.exitCode = 1;
    });
}
