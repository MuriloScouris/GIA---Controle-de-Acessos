import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ErroConfiguracao, type VariaveisAmbiente } from '@gia/contratos';
import type { Conector, ResultadoConexao } from '@gia/dominio';
import { criarConectorAd } from '../adaptadores/ad.js';
import type { OpcoesConector } from '../motor.js';
import { ClienteAdLdap, type OpcoesClienteAdLdap } from './ad-ldap.js';
import {
  VARIAVEIS_AD,
  carregarConfiguracaoAd,
  lerSegredoDeArquivo,
  type ConfiguracaoAd,
} from './configuracao-ad.js';
import { criarAbridorLdapts } from './ldap.js';

export type OpcoesAdReal = Pick<OpcoesConector, 'agora' | 'timeoutConexaoMs' | 'timeoutChamadaMs'> &
  Pick<OpcoesClienteAdLdap, 'aoRegistrar' | 'gerarSenhaInicial'>;

/** Cliente LDAPS a partir da configuração validada; o CA é lido uma vez, a senha a cada conexão. */
export async function criarClienteAdLdap(
  config: ConfiguracaoAd,
  opcoes: Pick<OpcoesClienteAdLdap, 'aoRegistrar' | 'gerarSenhaInicial'> = {},
): Promise<ClienteAdLdap> {
  let ca: Buffer | null = null;
  if (config.arquivoCa !== null) {
    try {
      ca = await readFile(config.arquivoCa);
    } catch {
      throw new ErroConfiguracao([VARIAVEIS_AD.arquivoCa]);
    }
  }
  return new ClienteAdLdap({
    abrirSessao: criarAbridorLdapts({
      urls: config.urls,
      bindDn: config.bindDn,
      senha: () => lerSegredoDeArquivo(config.arquivoSenha, VARIAVEIS_AD.arquivoSenha),
      ca,
      nomeServidorTls: config.nomeServidorTls,
      timeoutConexaoMs: config.timeoutConexaoMs,
      timeoutOperacaoMs: config.timeoutOperacaoMs,
    }),
    baseDn: config.baseDn,
    atributoCpf: config.atributoCpf,
    tentativasLeitura: config.tentativasLeitura,
    ...opcoes,
  });
}

/**
 * Conector AD de produção (`modo: 'real'`). Montá-lo não libera escrita: a
 * liberação por sistema e por operação (regra 8) continua sendo do domínio,
 * decidida antes de qualquer chamada.
 */
export async function criarConectorAdReal(
  config: ConfiguracaoAd,
  opcoes: OpcoesAdReal = {},
): Promise<Conector> {
  const { aoRegistrar, gerarSenhaInicial, ...conector } = opcoes;
  const cliente = await criarClienteAdLdap(config, {
    ...(aoRegistrar === undefined ? {} : { aoRegistrar }),
    ...(gerarSenhaInicial === undefined ? {} : { gerarSenhaInicial }),
  });
  return criarConectorAd(cliente, { ...conector, modo: 'real', ouInativos: config.ouInativos });
}

/**
 * Homologação somente leitura: valida a configuração, autentica a conta de
 * serviço e lê a base. Não cria, altera nem lê dados de pessoas.
 */
export async function verificarConexaoAd(env: VariaveisAmbiente): Promise<ResultadoConexao> {
  const conector = await criarConectorAdReal(carregarConfiguracaoAd(env));
  return conector.testarConexao();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verificarConexaoAd(process.env)
    .then((resultado) => {
      console.log(
        `AD: ${resultado.disponivel ? 'disponível' : 'indisponível'} (${resultado.codigo})`,
      );
      if (!resultado.disponivel) process.exitCode = 1;
    })
    .catch((erro: unknown) => {
      console.error(erro instanceof Error ? erro.message : 'falha ao verificar o AD');
      process.exitCode = 1;
    });
}
