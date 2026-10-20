import type {
  GatesDeEscrita,
  ProntidaoPublicaResposta,
  ProntidaoResposta,
  Registrador,
  RegistroMetricas,
} from '@gia/contratos';
import { modoDosGates } from '@gia/contratos';
import type { FastifyInstance } from 'fastify';

/** Verificações de prontidão: cada uma responde se a dependência atende agora. */
export type VerificacoesProntidao = Readonly<Record<string, () => Promise<void>>>;

export interface ObservabilidadeHttp {
  readonly registrador: Registrador;
  readonly metricas: RegistroMetricas;
  readonly gates: GatesDeEscrita;
  readonly versao: string;
  readonly verificacoes: VerificacoesProntidao;
}

/** Cabeçalho com o ID de correlação de cada resposta (sempre gerado pela API). */
export const CABECALHO_CORRELACAO = 'x-correlacao-id';

const LIMITES_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000];
const PRAZO_VERIFICACAO_MS = 2_000;

/** Prontidão detalhada, com o código HTTP correspondente. */
export interface ProntidaoDetalhada {
  readonly codigo: 200 | 503;
  readonly corpo: ProntidaoResposta;
}

const detalhadas = new WeakMap<FastifyInstance, () => Promise<ProntidaoDetalhada>>();

/**
 * Avaliação detalhada da prontidão desta API, para a porta interna de métricas
 * (`servirMetricas({ prontidao })`). Nunca é exposta pela porta pública.
 */
export function prontidaoDetalhadaDe(
  app: FastifyInstance,
): (() => Promise<ProntidaoDetalhada>) | undefined {
  return detalhadas.get(app);
}

/**
 * Logs de acesso estruturados, correlação na resposta, métricas HTTP e a rota
 * de prontidão. Rótulos e logs usam a rota DECLARADA (`/pedidos/:pedidoId`),
 * nunca a URL crua: sem cardinalidade explosiva e sem dado na métrica.
 */
export function registrarObservabilidade(app: FastifyInstance, obs: ObservabilidadeHttp): void {
  const requisicoes = obs.metricas.contador(
    'gia_api_requisicoes_total',
    'Requisições HTTP atendidas pela API.',
    ['metodo', 'rota', 'status'],
  );
  const duracao = obs.metricas.histograma(
    'gia_api_duracao_ms',
    'Duração das requisições HTTP em milissegundos.',
    LIMITES_MS,
    ['metodo', 'rota'],
  );
  const falhas = obs.metricas.contador('gia_api_erros_internos_total', 'Respostas 5xx da API.', [
    'rota',
  ]);
  obs.metricas
    .medidor('gia_escrita_externa_ligada', 'Chave mestra de escrita externa (1 = ligada).')
    .definir(obs.gates.escritaExterna ? 1 : 0);
  const liberadas = obs.metricas.medidor(
    'gia_escrita_liberada',
    'Escrita real liberada por sistema e operação (1 = liberada).',
    ['liberacao'],
  );
  for (const liberacao of obs.gates.liberadas) liberadas.definir(1, { liberacao });

  const inicios = new WeakMap<object, bigint>();
  app.addHook('onRequest', async (request) => {
    inicios.set(request, process.hrtime.bigint());
  });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header(CABECALHO_CORRELACAO, request.id);
    return payload;
  });
  app.addHook('onResponse', async (request, reply) => {
    const inicio = inicios.get(request);
    const ms = inicio === undefined ? 0 : Number(process.hrtime.bigint() - inicio) / 1e6;
    const rota = request.routeOptions.url ?? 'nao_encontrada';
    const status = reply.statusCode;
    requisicoes.incrementar({ metodo: request.method, rota, status: String(status) });
    duracao.observar(ms, { metodo: request.method, rota });
    if (status >= 500) falhas.incrementar({ rota });
    const campos = {
      correlacaoId: request.id,
      metodo: request.method,
      rota,
      status,
      duracaoMs: Math.round(ms),
    };
    if (status >= 500) obs.registrador.erro('http_requisicao', campos);
    else if (rota !== '/saude' && rota !== '/saude/pronta')
      obs.registrador.info('http_requisicao', campos);
  });

  const avaliar = async (): Promise<ProntidaoDetalhada> => {
    const verificacoes: Record<string, 'ok' | 'falha'> = {};
    await Promise.all(
      Object.entries(obs.verificacoes).map(async ([nome, verificar]) => {
        verificacoes[nome] = (await comPrazo(verificar())) ? 'ok' : 'falha';
      }),
    );
    const pronta = Object.values(verificacoes).every((v) => v === 'ok');
    if (!pronta)
      obs.registrador.aviso('prontidao_falhou', { verificacoes: falhasDe(verificacoes) });
    return {
      codigo: pronta ? 200 : 503,
      corpo: {
        status: pronta ? 'pronta' : 'indisponivel',
        ambiente: obs.gates.ambiente,
        versao: obs.versao,
        verificacoes,
        escrita: { modo: modoDosGates(obs.gates), liberadas: [...obs.gates.liberadas] },
      },
    };
  };
  detalhadas.set(app, avaliar);

  // Porta pública (M7): só o status. Ambiente, versão, verificações e gates de
  // escrita ficam na porta interna; a falha continua no log `prontidao_falhou`.
  app.get('/saude/pronta', async (_request, reply) => {
    const { codigo, corpo } = await avaliar();
    const publica: ProntidaoPublicaResposta = { status: corpo.status };
    return reply.code(codigo).send(publica);
  });
}

function falhasDe(verificacoes: Readonly<Record<string, 'ok' | 'falha'>>): string[] {
  return Object.entries(verificacoes)
    .filter(([, v]) => v === 'falha')
    .map(([nome]) => nome);
}

async function comPrazo(verificacao: Promise<void>): Promise<boolean> {
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      verificacao.then(() => true),
      new Promise<boolean>((resolver) => {
        temporizador = setTimeout(() => resolver(false), PRAZO_VERIFICACAO_MS);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(temporizador);
  }
}
