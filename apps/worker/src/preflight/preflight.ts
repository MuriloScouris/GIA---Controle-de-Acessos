import { randomUUID } from 'node:crypto';
import {
  ErroConfiguracao,
  carregarGatesDeEscrita,
  chamadoJiraSchema,
  prontidaoRespostaSchema,
  resolverSegredosDeArquivo,
  segredosNoAmbiente,
  type VariaveisAmbiente,
} from '@gia/contratos';
import {
  carregarConfiguracaoAd,
  carregarConfiguracaoM365,
  carregarConfiguracaoDocusign,
  carregarConfiguracaoSoftexpert,
  criarIntegracoesDoAmbiente,
  ErroFornecedor,
  NUVENS_M365,
  transporteSomenteLeitura,
  respostaLimitada,
} from '@gia/conectores';
import { ehCpfValido, POLITICA_EXECUCAO_PADRAO, SISTEMAS, type Sistema } from '@gia/dominio';
import { lerArquivoControlado, verificarArquivo } from './arquivos.js';
import { verificarRede, type AlvoTls } from './rede.js';
import type { Check, Codigo, EvidenciaPreflight, NomeCheck, ResultadoSistema } from './tipos.js';

export interface DependenciasPreflight {
  readonly fetch?: typeof fetch;
  readonly rede?: typeof verificarRede;
  readonly offline?: boolean;
}
const ok = (nome: NomeCheck): Check => ({ nome, estado: 'ok', codigo: 'OK' });
const bloco = (nome: NomeCheck, codigo: Codigo): Check => ({ nome, estado: 'bloqueado', codigo });
const naoExecutado = (nome: NomeCheck, codigo: Codigo = 'DEPENDENCIA_BLOQUEADA'): Check => ({
  nome,
  estado: 'naoExecutado',
  codigo,
});
const manual = (nome: NomeCheck, codigo: Codigo = 'REVISAO_ADMINISTRATIVA_NECESSARIA'): Check => ({
  nome,
  estado: 'pendente',
  codigo,
});

/** Nunca publica código dinâmico do fornecedor (inclusive SOAP), erro, URL ou mensagem. */
function codigoLeitura(codigo: string): Codigo {
  if (codigo === 'M365_SEGREDO_EXPIRADO') return 'CREDENCIAL_EXPIRADA';
  if (/^(JIRA|M365|DOCUSIGN|SOFTEXPERT)_LIMITE_DE_TAXA$/.test(codigo)) return 'LIMITE_DE_TAXA';
  if (codigo === 'DOCUSIGN_CONSENTIMENTO_NECESSARIO') return 'CONSENTIMENTO_PENDENTE';
  if (['DOCUSIGN_CONTA_NAO_AUTORIZADA', 'M365_APP_OU_TENANT_INEXISTENTE'].includes(codigo))
    return 'CONTA_SEM_ACESSO';
  if (
    /^(AD_CREDENCIAL_INVALIDA|M365_(AUTENTICACAO|SEGREDO_INVALIDO|TOKEN_RECUSADO)|JIRA_AUTENTICACAO|SOFTEXPERT_AUTENTICACAO|DOCUSIGN_(AUTENTICACAO|JWT_RECUSADO|OAUTH_RECUSADO))$/.test(
      codigo,
    )
  )
    return 'AUTENTICACAO_RECUSADA';
  if (
    /^(AD_PERMISSAO_INSUFICIENTE|M365_PERMISSAO_INSUFICIENTE|SOFTEXPERT_ACESSO_NEGADO|JIRA_PERMISSAO|DOCUSIGN_PERMISSAO_INSUFICIENTE)$/.test(
      codigo,
    )
  )
    return 'PERMISSAO_LEITURA_NEGADA';
  if (
    /^(TIMEOUT|INTEGRACAO_TIMEOUT|AD_TEMPO_ESGOTADO|M365_TEMPO_ESGOTADO|JIRA_TIMEOUT|DOCUSIGN_TIMEOUT|SOFTEXPERT_TEMPO_ESGOTADO)$/.test(
      codigo,
    )
  )
    return 'TEMPO_ESGOTADO';
  if (/^(AD|M365|SOFTEXPERT)_TLS_INVALIDO$/.test(codigo)) return 'TLS_INVALIDO';
  if (
    /^(AD_CONEXAO_RECUSADA|M365_(CONEXAO_RECUSADA|TOKEN_INDISPONIVEL)|SOFTEXPERT_CONEXAO_RECUSADA|JIRA_INDISPONIVEL)$/.test(
      codigo,
    )
  )
    return 'SERVICO_INDISPONIVEL';
  if (/^(JIRA|M365|DOCUSIGN|SOFTEXPERT)_RESPOSTA_INVALIDA$/.test(codigo))
    return 'RESPOSTA_INVALIDA';
  return 'LEITURA_NAO_VALIDADA';
}
function variaveis(erro: unknown): readonly string[] {
  return erro instanceof ErroConfiguracao
    ? erro.variaveis.filter((v) => /^(GIA_[A-Z0-9_]{1,80}|NODE_DEBUG)$/.test(v)).slice(0, 30)
    : [];
}
function envDoSistema(env: VariaveisAmbiente, sistema: Sistema): VariaveisAmbiente {
  return {
    ...env,
    ...Object.fromEntries(
      SISTEMAS.map((s) => [`GIA_${s.toUpperCase()}_MODO`, s === sistema ? 'real' : 'simulado']),
    ),
    // Banco é verificado separadamente, nunca conectado diretamente por este comando.
    GIA_DATABASE_URL: undefined,
    GIA_DATABASE_URL_ARQUIVO: undefined,
    ...(sistema === 'jira' ? {} : { GIA_JIRA_API_TOKEN_ARQUIVO: undefined }),
  };
}
async function preparar(
  env: VariaveisAmbiente,
  sistema: Sistema,
  timeoutMs: number,
  enviar: typeof fetch,
) {
  const arquivos: { caminho: string | undefined; recurso: NonNullable<Check['recurso']> }[] = [];
  const alvos: AlvoTls[] = [];
  if (sistema === 'ad') {
    const c = carregarConfiguracaoAd(env);
    arquivos.push({ caminho: c.arquivoSenha, recurso: 'credencial' });
    if (c.arquivoCa) arquivos.push({ caminho: c.arquivoCa, recurso: 'ca' });
    for (const u of c.urls) {
      const url = new URL(u);
      alvos.push({
        host: url.hostname,
        porta: Number(url.port || 636),
        ...(c.nomeServidorTls ? { nomeTls: c.nomeServidorTls } : {}),
      });
    }
  }
  if (sistema === 'm365') {
    const c = carregarConfiguracaoM365(env);
    arquivos.push({ caminho: c.arquivoSegredo, recurso: 'credencial' });
    for (const host of Object.values(NUVENS_M365[c.nuvem]))
      alvos.push({ host: new URL(host).hostname, porta: 443 });
  }
  if (sistema === 'docusign') {
    const c = carregarConfiguracaoDocusign(env);
    arquivos.push({ caminho: c.chavePrivadaArquivo, recurso: 'chavePrivada' });
    alvos.push({
      host: c.ambiente === 'producao' ? 'account.docusign.com' : 'account-d.docusign.com',
      porta: 443,
    });
  }
  if (sistema === 'softexpert') {
    const c = carregarConfiguracaoSoftexpert(env);
    arquivos.push({
      caminho:
        c.autenticacao.modo === 'token' ? c.autenticacao.arquivoToken : c.autenticacao.arquivoSenha,
      recurso: 'credencial',
    });
    const u = new URL(c.endpoint);
    alvos.push({ host: u.hostname, porta: Number(u.port || 443) });
  }
  if (sistema === 'jira') {
    arquivos.push({ caminho: env['GIA_JIRA_API_TOKEN_ARQUIVO'], recurso: 'credencial' });
    const u = new URL(env['GIA_JIRA_BASE_URL'] ?? '');
    alvos.push({ host: u.hostname, porta: Number(u.port || 443) });
  }
  const checks: Check[] = [];
  let ca: Buffer | undefined;
  if (sistema !== 'ad' && env['NODE_EXTRA_CA_CERTS'])
    arquivos.push({ caminho: env['NODE_EXTRA_CA_CERTS'], recurso: 'ca' });
  for (const a of arquivos) {
    const r = await verificarArquivo(a.caminho, a.recurso);
    checks.push(r.check);
    if (r.ca) ca = r.ca;
  }
  if (checks.some((c) => c.estado !== 'ok'))
    return { checks, alvos: [] as AlvoTls[], integracao: null };
  const resolvido = await resolverSegredosDeArquivo(env);
  const integracao = await criarIntegracoesDoAmbiente(
    resolvido,
    { ...POLITICA_EXECUCAO_PADRAO, timeoutConexaoMs: timeoutMs, timeoutChamadaMs: timeoutMs + 200 },
    undefined,
    { fetch: transporteSomenteLeitura(sistema, env, enviar) },
  );
  return { checks, alvos: alvos.map((a) => ({ ...a, ...(ca ? { ca } : {}) })), integracao };
}

async function verificarApi(
  env: VariaveisAmbiente,
  enviar: typeof fetch,
  timeoutMs: number,
  rede: typeof verificarRede,
): Promise<Check[]> {
  const bruto = env['GIA_PREFLIGHT_API_URL'];
  let base: URL;
  try {
    base = new URL(bruto ?? '');
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== '/' ||
      !(
        base.protocol === 'https:' ||
        (env['GIA_AMBIENTE'] === 'teste' &&
          base.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
      )
    )
      throw new Error();
  } catch {
    return [bloco('prontidaoApi', bruto ? 'CONFIGURACAO_INVALIDA' : 'API_NAO_CONFIGURADA')];
  }
  const checks: Check[] = [];
  if (base.protocol === 'https:') {
    let ca: Buffer | undefined;
    if (env['NODE_EXTRA_CA_CERTS']) {
      const arquivo = await verificarArquivo(env['NODE_EXTRA_CA_CERTS'], 'ca');
      if (arquivo.check.estado !== 'ok') return [arquivo.check, naoExecutado('prontidaoApi')];
      ca = arquivo.ca;
    }
    const resultados = await rede(
      {
        host: base.hostname.replace(/^\[|\]$/g, ''),
        porta: Number(base.port || 443),
        ...(ca ? { ca } : {}),
      },
      timeoutMs,
    );
    checks.push(...resultados.map((c) => ({ ...c, destino: 0 })));
    if (resultados.some((c) => c.estado !== 'ok')) return [...checks, naoExecutado('prontidaoApi')];
  }
  for (const [nome, caminho] of [
    ['vivacidadeApi', '/saude'],
    ['prontidaoApi', '/saude/pronta'],
    ['autorizacaoApi', '/pedidos'],
  ] as const) {
    try {
      // GET somente, sem sessão nem Authorization, redirect recusado.
      const sinal = AbortSignal.timeout(timeoutMs);
      const r = await respostaLimitada(
        await enviar(new URL(caminho, base), { method: 'GET', redirect: 'error', signal: sinal }),
        sinal,
      );
      if (nome === 'autorizacaoApi') {
        await r.body?.cancel();
        checks.push(r.status === 401 ? ok(nome) : bloco(nome, 'API_PROTECAO_INVALIDA'));
        continue;
      }
      if (nome === 'vivacidadeApi') {
        const body: unknown = await r.json();
        checks.push(
          r.status === 200 &&
            body &&
            typeof body === 'object' &&
            'status' in body &&
            body.status === 'ok' &&
            r.headers.get('cache-control') === 'no-store' &&
            r.headers.get('x-content-type-options') === 'nosniff' &&
            /^[0-9a-f-]{36}$/.test(r.headers.get('x-correlacao-id') ?? '')
            ? ok(nome)
            : bloco(nome, 'API_PROTECAO_INVALIDA'),
        );
        continue;
      }
      const lido = prontidaoRespostaSchema.safeParse(await r.json());
      if (
        !lido.success ||
        r.status !== 200 ||
        lido.data.status !== 'pronta' ||
        lido.data.ambiente !== env['GIA_AMBIENTE'] ||
        lido.data.verificacoes['persistencia'] !== 'ok' ||
        Object.values(lido.data.verificacoes).some((v) => v !== 'ok')
      )
        checks.push(bloco(nome, 'API_NAO_PRONTA'));
      else
        checks.push(
          lido.data.escrita.modo === 'simulado' && lido.data.escrita.liberadas.length === 0
            ? ok(nome)
            : bloco(nome, 'API_ESCRITA_HABILITADA'),
        );
    } catch {
      checks.push(bloco(nome, 'API_NAO_PRONTA'));
    }
  }
  return checks;
}

/** Somente leituras. Nenhuma opção remove pendência de homologação ou habilita escrita. */
export async function executarPreflight(
  env: VariaveisAmbiente,
  deps: DependenciasPreflight = {},
): Promise<EvidenciaPreflight> {
  const checks: Check[] = [];
  const sistemas: ResultadoSistema[] = [];
  const ambiente =
    env['GIA_AMBIENTE'] === 'producao' || env['GIA_AMBIENTE'] === 'teste'
      ? env['GIA_AMBIENTE']
      : 'invalido';
  checks.push(ambiente === 'invalido' ? bloco('ambiente', 'AMBIENTE_INVALIDO') : ok('ambiente'));
  try {
    const gates = carregarGatesDeEscrita(env);
    if (
      gates.escritaExterna ||
      gates.liberadas.length ||
      ['GIA_JIRA_ESCRITA_HABILITADA', 'GIA_DOCUSIGN_ESCRITA_HABILITADA'].some(
        (n) => env[n] !== undefined && env[n] !== 'false',
      )
    )
      throw new Error();
    checks.push(ok('gates'));
  } catch {
    checks.push(bloco('gates', 'ESCRITA_DEVE_ESTAR_DESLIGADA'));
  }
  const inline = segredosNoAmbiente(env);
  checks.push(
    inline.length
      ? {
          ...bloco('segredosInline', 'SEGREDO_INLINE_RECUSADO'),
          variaveis: inline.filter((n) => /^GIA_[A-Z0-9_]+$/.test(n)),
        }
      : ok('segredosInline'),
  );
  if (
    env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0' ||
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0'
  )
    checks.push(bloco('gates', 'TLS_INVALIDO'));
  const timeoutMs = Number(env['GIA_PREFLIGHT_TIMEOUT_MS'] ?? 5000);
  if (['NODE_DEBUG', 'DEBUG'].some((n) => env[n]?.trim() || process.env[n]?.trim()))
    checks.push({
      ...bloco('configuracao', 'CONFIGURACAO_INVALIDA'),
      variaveis: ['NODE_DEBUG', 'DEBUG'],
    });
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 25000)
    checks.push(bloco('configuracao', 'CONFIGURACAO_INVALIDA'));
  const seguro = checks.every((c) => c.estado === 'ok');
  if (seguro) {
    const db = await verificarArquivo(env['GIA_DATABASE_URL_ARQUIVO'], 'banco');
    checks.push({ ...db.check, nome: 'cofreBanco' });
  }
  const enviar = deps.fetch ?? globalThis.fetch;
  for (const sistema of SISTEMAS) {
    const cs: Check[] = [];
    if (!seguro) cs.push(naoExecutado('configuracao'));
    else if (env[`GIA_${sistema.toUpperCase()}_MODO`] !== 'real')
      cs.push(bloco('configuracao', 'REAL_NAO_SELECIONADO'));
    else {
      let etapa: NomeCheck = 'configuracao';
      try {
        const r = await preparar(envDoSistema(env, sistema), sistema, timeoutMs, enviar);
        cs.push(ok('configuracao'), ...r.checks);
        etapa = 'autenticacaoLeitura';
        if (!r.integracao) cs.push(naoExecutado('autenticacaoLeitura'));
        else if (deps.offline)
          cs.push(naoExecutado('autenticacaoLeitura', 'OFFLINE_NAO_VALIDA_REDE'));
        else {
          for (const [i, alvo] of r.alvos.entries()) {
            const rede = await (deps.rede ?? verificarRede)(alvo, timeoutMs);
            cs.push(...rede.map((c) => ({ ...c, destino: i + 1 })));
          }
          if (cs.some((c) => c.estado !== 'ok')) cs.push(naoExecutado('autenticacaoLeitura'));
          else {
            const conector = r.integracao.reais[sistema]!;
            const leitura = await conector.testarConexao();
            cs.push(
              leitura.disponivel && leitura.modo === 'real'
                ? ok('autenticacaoLeitura')
                : bloco('autenticacaoLeitura', codigoLeitura(leitura.codigo)),
            );
            if (sistema === 'jira' && leitura.disponivel) {
              etapa = 'camposOrigem';
              const chamados = await r.integracao.amostraJira!();
              const tipos = new Set<string>();
              let invalidos = false;
              for (const chamado of chamados) {
                const v = chamadoJiraSchema.safeParse(chamado);
                if (!v.success || !ehCpfValido(v.data.fields.cpf)) invalidos = true;
                else tipos.add(v.data.fields.tipoSolicitacao);
              }
              cs.push(
                invalidos
                  ? bloco('camposOrigem', 'CAMPOS_INVALIDOS')
                  : tipos.has('Admissão - Celetista') && tipos.has('Admissão - Terceiro')
                    ? ok('camposOrigem')
                    : manual('camposOrigem', 'SEM_AMOSTRA_DOS_DOIS_VINCULOS'),
              );
            }
          }
        }
      } catch (e) {
        cs.push({
          ...bloco(
            etapa,
            etapa === 'configuracao'
              ? 'CONFIGURACAO_INVALIDA'
              : e instanceof ErroFornecedor
                ? codigoLeitura(e.codigo)
                : 'SERVICO_INDISPONIVEL',
          ),
          ...(etapa === 'configuracao' ? { variaveis: variaveis(e) } : {}),
        });
      }
    }
    cs.push(
      manual('contaServico'),
      manual('permissoesEscrita'),
      manual('consentimentos'),
      manual('homologacao', 'ENSAIO_AUTORIZADO_PENDENTE'),
    );
    sistemas.push({ sistema, checks: cs });
  }
  if (seguro && !deps.offline) {
    checks.push(...(await verificarApi(env, enviar, timeoutMs, deps.rede ?? verificarRede)));
    try {
      const instante = Number(
        (await lerArquivoControlado(env['GIA_WORKER_ARQUIVO_SAUDE'] ?? '')).toString('utf8').trim(),
      );
      const idade = Date.now() - instante;
      checks.push(
        Number.isSafeInteger(instante) && idade >= 0 && idade <= 60000
          ? ok('batimentoWorker')
          : bloco('batimentoWorker', 'WORKER_SEM_BATIMENTO'),
      );
    } catch {
      checks.push(bloco('batimentoWorker', 'WORKER_SEM_BATIMENTO'));
    }
  } else
    checks.push(
      naoExecutado(
        'prontidaoApi',
        deps.offline ? 'OFFLINE_NAO_VALIDA_REDE' : 'DEPENDENCIA_BLOQUEADA',
      ),
    );
  checks.push(manual('rollback', 'ENSAIO_AUTORIZADO_PENDENTE'));
  const tecnicos = [...checks, ...sistemas.flatMap((s) => s.checks)].filter(
    (c) =>
      !['contaServico', 'permissoesEscrita', 'consentimentos', 'homologacao', 'rollback'].includes(
        c.nome,
      ),
  );
  const leiturasValidadas = tecnicos.every((c) => c.estado === 'ok');
  return {
    schema: 'gia.preflight.v1',
    execucaoId: randomUUID(),
    geradoEm: new Date().toISOString(),
    revisao: /^[a-f0-9]{40}$/.test(env['GIA_PREFLIGHT_REVISAO'] ?? '')
      ? env['GIA_PREFLIGHT_REVISAO']!
      : null,
    ambiente,
    somenteLeitura: true,
    escritaHabilitada: false,
    gatesObservados: {
      configuracao: checks.some((c) => c.nome === 'gates' && c.estado !== 'ok')
        ? 'insegura'
        : 'desligada',
      api: checks.some((c) => c.nome === 'prontidaoApi' && c.codigo === 'API_ESCRITA_HABILITADA')
        ? 'ligada'
        : checks.some((c) => c.nome === 'prontidaoApi' && c.estado === 'ok')
          ? 'desligada'
          : 'naoConfirmada',
    },
    producaoPronta: false,
    leiturasValidadas,
    codigoSaida: leiturasValidadas ? 2 : 1,
    checks,
    sistemas,
  };
}
