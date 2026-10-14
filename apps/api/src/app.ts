import { randomUUID } from 'node:crypto';
import type { ConfiguracaoAmbiente, SaudeResposta } from '@gia/contratos';
import type { Uuid } from '@gia/dominio';
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
import { enviarFalha } from './http/protocolo.js';
import { registrarRotas, registrarRotasDeSessaoSimulada } from './http/rotas.js';
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
}

const relogioDoSistema: Relogio = { agora: () => new Date().toISOString() };

/**
 * API do Gia: adaptador HTTP fino sobre os casos de uso (ADR-0001). Não fala
 * com nenhum sistema de destino: aprovar só grava a decisão e solicitar
 * execução só grava a operação na fila, para o worker consumir.
 */
export function criarApp(opcoes: OpcoesApp = {}): FastifyInstance {
  const ambiente = opcoes.ambiente ?? 'desenvolvimento';
  const relogio = opcoes.relogio ?? relogioDoSistema;
  const casosDeUso: DependenciasCasosDeUso = {
    persistencia: opcoes.persistencia ?? criarPersistenciaEmMemoria(),
    fonteJira: opcoes.fonteJira ?? criarJiraSimulado().fonte,
    diretorio: opcoes.diretorio ?? criarDiretorioSimulado(),
    regras: opcoes.regras ?? REGRAS_PROPOSTA_FICTICIAS,
    // A configuração só aceita escrita externa desligada: as operações nascem simuladas.
    modoExecucao: 'simulado',
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
  app.setErrorHandler(async (erro: { statusCode?: number }, _request, reply) => {
    // Outra transação gravou o mesmo registro antes: o operador recarrega e revisa.
    if (erro instanceof ErroDeConcorrencia) return enviarFalha(reply, 'CONFLITO_DE_VERSAO');
    const entradaInvalida =
      typeof erro.statusCode === 'number' && erro.statusCode >= 400 && erro.statusCode < 500;
    return entradaInvalida
      ? enviarFalha(reply, 'DADO_INVALIDO')
      : enviarFalha(reply, 'ERRO_INTERNO');
  });
  app.setNotFoundHandler(async (_request, reply) => enviarFalha(reply, 'NAO_ENCONTRADO'));

  app.get('/saude', async (): Promise<SaudeResposta> => ({ status: 'ok' }));
  if (ambiente !== 'producao') registrarRotasDeSessaoSimulada(app, deps);
  registrarRotas(app, deps);
  return app;
}
