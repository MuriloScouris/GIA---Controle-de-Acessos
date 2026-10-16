import { randomUUID } from 'node:crypto';
import {
  RegistroMetricas,
  criarRegistrador,
  liberacaoDosGates,
  modoDosGates,
  type ConfiguracaoAmbiente,
  type GatesDeEscrita,
  type Registrador,
  type SaudeResposta,
} from '@gia/contratos';
import { configuracaoPadrao, type Uuid } from '@gia/dominio';
import { ErroDeConcorrencia } from '@gia/persistencia';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DependenciasCasosDeUso } from './aplicacao/dependencias.js';
import type {
  ConsultaDiretorio,
  FonteChamadosJira,
  Persistencia,
  Relogio,
} from './aplicacao/portas.js';
import { REGRAS_PROPOSTA_FICTICIAS, type RegrasProposta } from './aplicacao/regras-proposta.js';
import { registrarObservabilidade, type VerificacoesProntidao } from './http/observabilidade.js';
import { enviarFalha } from './http/protocolo.js';
import { registrarRotasOidc, type EventoLogin } from './http/rotas-oidc.js';
import { registrarRotas, registrarRotasDeSessaoSimulada } from './http/rotas.js';
import type { ClienteOidc } from './sessao/oidc.js';
import { criarPersistenciaEmMemoria } from './persistencia/memoria.js';
import { criarSessoesSimuladas, type SessoesSimuladas } from './sessao/sessoes-simuladas.js';
import { criarDiretorioSimulado } from './simuladores/diretorio-simulado.js';
import { criarJiraSimulado } from './simuladores/jira-simulado.js';

/** Tudo é substituível nos testes; os padrões são simulados e em memória. */
export interface OpcoesApp {
  readonly ambiente?: ConfiguracaoAmbiente['ambiente'];
  readonly persistencia?: Persistencia;
  readonly fonteJira?: FonteChamadosJira;
  readonly diretorio?: ConsultaDiretorio;
  readonly regras?: RegrasProposta;
  readonly relogio?: Relogio;
  readonly gerarId?: () => Uuid;
  readonly sessoes?: SessoesSimuladas;
  /** Gates de escrita externa (regra 8); padrão: tudo desligado e operações simuladas. */
  readonly gates?: GatesDeEscrita;
  readonly registrador?: Registrador;
  readonly metricas?: RegistroMetricas;
  readonly versao?: string;
  /** Verificações extras de prontidão (ex.: o banco). A persistência sempre é verificada. */
  readonly verificacoes?: VerificacoesProntidao;
  /**
   * Como as pessoas entram. Padrão: sessão simulada só em `desenvolvimento`;
   * nos demais ambientes, nenhum login até ser configurado. Produção recusa a
   * sessão simulada.
   */
  readonly autenticacao?: Autenticacao;
}

export type Autenticacao =
  | { readonly modo: 'simulada' }
  | {
      readonly modo: 'oidc';
      readonly cliente: ClienteOidc;
      readonly auditarLogin?: (evento: EventoLogin) => void;
    }
  | { readonly modo: 'indisponivel' };

/** Resposta de `GET /sessao/modo`: qual login a interface deve oferecer. */
export interface ModoSessaoResposta {
  readonly modo: Autenticacao['modo'];
}

const relogioDoSistema: Relogio = { agora: () => new Date().toISOString() };

/**
 * API do Gia: adaptador HTTP fino sobre os casos de uso (ADR-0001). Não fala
 * com nenhum sistema de destino: aprovar só grava a decisão e solicitar
 * execução só grava a operação na fila, para o worker consumir.
 */
export function criarApp(opcoes: OpcoesApp = {}): FastifyInstance {
  const ambiente = opcoes.ambiente ?? 'desenvolvimento';
  const gates: GatesDeEscrita = opcoes.gates ?? { ambiente, escritaExterna: false, liberadas: [] };
  const relogio = opcoes.relogio ?? relogioDoSistema;
  const registrador =
    opcoes.registrador ?? criarRegistrador({ servico: 'api', ambiente, saida: () => undefined });
  const persistencia =
    opcoes.persistencia ??
    criarPersistenciaEmMemoria({
      ...configuracaoPadrao(),
      liberacaoEscrita: liberacaoDosGates(gates),
    });
  const casosDeUso: DependenciasCasosDeUso = {
    persistencia,
    fonteJira: opcoes.fonteJira ?? criarJiraSimulado().fonte,
    diretorio: opcoes.diretorio ?? criarDiretorioSimulado(),
    regras: opcoes.regras ?? REGRAS_PROPOSTA_FICTICIAS,
    // Operações só nascem `real` com a chave mestra ligada; o domínio ainda exige a
    // liberação do sistema e da operação (regra 8), que vem dos mesmos gates.
    modoExecucao: modoDosGates(gates),
  };
  const deps = {
    sessoes: opcoes.sessoes ?? criarSessoesSimuladas(relogio),
    relogio,
    gerarId: opcoes.gerarId ?? randomUUID,
    casosDeUso,
  };

  // O ID de correlação é sempre gerado aqui; cabeçalho do cliente não é aceito.
  const app = Fastify({ logger: false, requestIdHeader: false, genReqId: () => randomUUID() });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    return payload;
  });
  // Mensagens internas e do framework nunca vão para a resposta.
  app.setErrorHandler(async (erro: { statusCode?: number; name?: string }, request, reply) => {
    // Outra transação gravou o mesmo registro antes: o operador recarrega e revisa.
    if (erro instanceof ErroDeConcorrencia) return enviarFalha(reply, 'CONFLITO_DE_VERSAO');
    const entradaInvalida =
      typeof erro.statusCode === 'number' && erro.statusCode >= 400 && erro.statusCode < 500;
    if (entradaInvalida) return enviarFalha(reply, 'DADO_INVALIDO');
    // Só o tipo do erro vai para o log: a mensagem pode carregar dado da requisição.
    registrador.erro('erro_interno', { correlacaoId: request.id, erro: erro.name ?? 'Error' });
    return enviarFalha(reply, 'ERRO_INTERNO');
  });
  app.setNotFoundHandler(async (_request, reply) => enviarFalha(reply, 'NAO_ENCONTRADO'));

  registrarObservabilidade(app, {
    registrador,
    metricas: opcoes.metricas ?? new RegistroMetricas(),
    gates,
    versao: opcoes.versao ?? 'desconhecida',
    verificacoes: {
      // Abre e fecha uma transação: no PostgreSQL, prova a conexão com o banco.
      persistencia: async () => {
        await persistencia.executar(async (tx) => tx.configuracao.atual());
      },
      ...opcoes.verificacoes,
    },
  });
  app.get('/saude', async (): Promise<SaudeResposta> => ({ status: 'ok' }));
  const autenticacao: Autenticacao =
    opcoes.autenticacao ??
    (ambiente === 'desenvolvimento' ? { modo: 'simulada' } : { modo: 'indisponivel' });
  if (autenticacao.modo === 'simulada') {
    // Defesa em profundidade: a configuração já recusa, e o app também.
    if (ambiente === 'producao') throw new Error('Sessão simulada não é permitida em produção.');
    registrarRotasDeSessaoSimulada(app, deps);
  }
  if (autenticacao.modo === 'oidc') {
    registrarRotasOidc(app, {
      ...deps,
      oidc: autenticacao.cliente,
      auditarLogin: autenticacao.auditarLogin ?? (() => undefined),
    });
  }
  app.get('/sessao/modo', async (): Promise<ModoSessaoResposta> => ({ modo: autenticacao.modo }));
  registrarRotas(app, deps);
  return app;
}
