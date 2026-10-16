import { randomUUID } from 'node:crypto';
import { criarCatalogoSimulado, criarDestinoJiraCloud, HttpJira } from '@gia/conectores';
import { POLITICA_EXECUCAO_PADRAO } from '@gia/dominio';
import { criarPersistenciaPostgres } from '@gia/persistencia';
import { criarBancoDeTeste, TEM_BANCO, TEMPO_BANCO_MS } from '@gia/persistencia/teste';
import { expect, it } from 'vitest';
import { criarExecutor } from './executor.js';
import { cenario, gravar, INICIO, operacao } from './teste/fabricas.js';

it.skipIf(!TEM_BANCO)(
  'Jira real → worker → PostgreSQL: resposta perdida exige reconciliação e audita uma vez',
  async () => {
    const banco = await criarBancoDeTeste();
    try {
      const persistencia = criarPersistenciaPostgres(banco.db);
      const c = cenario(['jira']);
      const op = operacao(c, 'jira');
      await gravar(persistencia, c, [op]);
      let escritas = 0;
      const http = new HttpJira({
        baseUrl: 'https://tenant.example.invalid',
        email: 'servico@example.invalid',
        apiToken: 'token-ficticio',
        fetch: async (_url, init) => {
          if (init?.method === 'GET') return Response.json([]);
          escritas += 1;
          // Representa criação aplicada cujo resultado não chegou; nunca se repete no worker.
          throw new Error('mensagem sensível do transporte');
        },
      });
      const conectores = {
        ...criarCatalogoSimulado().conectores,
        jira: criarDestinoJiraCloud(http, true),
      };
      const worker = criarExecutor({
        persistencia,
        conectores,
        politica: POLITICA_EXECUCAO_PADRAO,
        workerId: 'jira-teste',
        agora: () => INICIO,
        novoId: randomUUID,
        agendar: () => () => {},
      });
      expect((await worker.processarLote()).desfechos[0]?.tipo).toBe('registrada');
      const lida = await persistencia.executar((tx) => tx.fila.operacaoPorId(op.id));
      expect(lida).toMatchObject({
        efeito: 'desconhecido',
        status: 'aguardandoReconciliacao',
        codigo: 'JIRA_TRANSPORTE',
      });
      expect((await worker.processarLote()).reservadas).toBe(0);
      expect(escritas).toBe(1);
      const eventos = await persistencia.executar((tx) =>
        tx.eventos.porTipo('operacaoResultadoRegistrado'),
      );
      expect(eventos.filter((e) => e.operacaoId === op.id)).toHaveLength(1);
      expect(JSON.stringify(eventos)).not.toMatch(/token-ficticio|mensagem sensível/);
    } finally {
      await banco.descartar();
    }
  },
  TEMPO_BANCO_MS,
);
