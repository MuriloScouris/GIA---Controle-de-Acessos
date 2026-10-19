import { pathToFileURL } from 'node:url';
import {
  ErroConfiguracao,
  carregarGatesDeEscrita,
  resolverSegredosDeArquivo,
  type VariaveisAmbiente,
} from '@gia/contratos';
import { SISTEMAS } from '@gia/dominio';
import { exigirTlsVerificado } from '@gia/contratos';
import { carregarConfiguracaoWorker } from './configuracao.js';
import { conectoresReaisDoAmbiente } from './reais.js';

/**
 * Somente configuração ou leituras autenticadas; nunca consome fila nem
 * provisiona/revoga. Com a verificação TLS desligada: em produção não roda;
 * fora dela, roda, avisa em `avisos` e nunca dá `validado`.
 */
export async function smokeIntegracoes(
  envOriginal: VariaveisAmbiente,
  somenteConfiguracao = false,
) {
  // Leitura autenticada com TLS desligado não comprova nada e expõe a credencial.
  const tlsDesligado = exigirTlsVerificado(envOriginal);
  const env = await resolverSegredosDeArquivo(envOriginal);
  const config = carregarConfiguracaoWorker(env);
  const gates = carregarGatesDeEscrita(env);
  const reais = await conectoresReaisDoAmbiente(env, config.politica);
  const sistemas = [];
  for (const sistema of SISTEMAS) {
    const conector = reais[sistema];
    if (!conector) {
      sistemas.push({ sistema, status: 'naoConfigurado', codigo: 'SEM_CONECTOR_REAL' });
      continue;
    }
    if (somenteConfiguracao) {
      sistemas.push({ sistema, status: 'configurado', codigo: 'NAO_ENSAIADO' });
      continue;
    }
    const r = await conector.testarConexao();
    sistemas.push({
      sistema,
      status: r.disponivel ? 'disponivel' : 'indisponivel',
      codigo: r.codigo,
    });
  }
  return {
    escopo: somenteConfiguracao ? 'configuracao' : 'leitura',
    ambiente: config.ambiente,
    escritaExterna: gates.escritaExterna,
    liberadas: gates.liberadas,
    sistemas,
    avisos: tlsDesligado ? ['tls_verificacao_desligada'] : [],
    validado:
      !tlsDesligado && !somenteConfiguracao && sistemas.every((s) => s.status === 'disponivel'),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  smokeIntegracoes(process.env, process.argv.includes('--configuracao'))
    .then((r) => {
      console.log(JSON.stringify(r));
      if (!process.argv.includes('--configuracao') && !r.validado) process.exitCode = 1;
    })
    .catch((e: unknown) => {
      console.error(e instanceof ErroConfiguracao ? e.message : 'Falha no smoke de integrações');
      process.exitCode = 1;
    });
}
