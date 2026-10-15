import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  criarClienteDocusignReal,
  criarConectorDocusign,
  criarCatalogoSimulado,
} from '@gia/conectores';
import { POLITICA_EXECUCAO_PADRAO } from '@gia/dominio';
import { criarPersistenciaPostgres } from '@gia/persistencia';
import {
  criarBancoDeTeste,
  TEM_BANCO,
  TEMPO_BANCO_MS,
  type BancoDeTeste,
} from '@gia/persistencia/teste';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { criarExecutor } from './executor.js';
import { cenario, gravar, INICIO, operacao } from './teste/fabricas.js';

let banco: BancoDeTeste;
beforeAll(async () => {
  if (TEM_BANCO) banco = await criarBancoDeTeste();
}, TEMPO_BANCO_MS);
afterAll(async () => {
  await banco?.descartar();
}, TEMPO_BANCO_MS);

describe.skipIf(!TEM_BANCO)(
  'DocuSign: transporte real, worker e auditoria PostgreSQL',
  { timeout: TEMPO_BANCO_MS },
  () => {
    it.each([200, 403, 503])(
      'persiste evidência de HTTP %s e não repete operação processada',
      async (status) => {
        const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const id = '00000000-0000-4000-8000-000000000001';
        let escritas = 0;
        const cliente = criarClienteDocusignReal(
          {
            ambiente: 'demo',
            integracaoId: id,
            usuarioId: id,
            contaId: id,
            chavePrivadaArquivo: 'secret-montado',
            timeoutMs: 2000,
            tentativasLeitura: 1,
            escritaHabilitada: true,
          },
          privateKey,
          {
            fetch: async (url, init) => {
              const caminho = new URL(String(url)).pathname;
              const json = (dados: unknown, httpStatus = 200) =>
                new Response(JSON.stringify(dados), { status: httpStatus });
              if (caminho === '/oauth/token')
                return json({
                  access_token: 'token-ficticio-nao-auditar',
                  token_type: 'Bearer',
                  expires_in: 3600,
                });
              if (caminho === '/oauth/userinfo')
                return json({
                  accounts: [{ account_id: id, base_uri: 'https://demo.docusign.net' }],
                });
              if (caminho.endsWith('/permission_profiles'))
                return json({
                  permissionProfiles: [
                    { permissionProfileId: 'p1', permissionProfileName: 'Remetente' },
                  ],
                });
              if (caminho.endsWith('/groups'))
                return json({ groups: [{ groupId: 'g1', groupName: 'Tecnologia' }] });
              if (init?.method === 'POST') {
                escritas++;
                return json(
                  status === 200
                    ? { newUsers: [{ userId: 'externo-docusign', userStatus: 'Pending' }] }
                    : { message: 'segredo-do-fornecedor' },
                  status,
                );
              }
              return json({ users: [] });
            },
          },
        );
        const persistencia = criarPersistenciaPostgres(banco.db);
        const c = cenario(['docusign']);
        const op = operacao(c, 'docusign');
        await gravar(persistencia, c, [op]);
        const executor = criarExecutor({
          persistencia,
          conectores: {
            ...criarCatalogoSimulado().conectores,
            docusign: criarConectorDocusign(cliente, { modo: 'real' }),
          },
          politica: POLITICA_EXECUCAO_PADRAO,
          workerId: `teste-${randomUUID()}`,
          agora: () => INICIO,
          novoId: randomUUID,
        });
        await executor.processarLote();
        await executor.processarLote();
        expect(escritas).toBe(1);
        const registrada = await persistencia.executar((tx) => tx.fila.operacaoPorId(op.id));
        expect(registrada).toMatchObject({
          modo: 'real',
          efeito: status === 200 ? 'confirmado' : status === 403 ? 'semEfeito' : 'desconhecido',
          tentativas: 1,
        });
        const eventos = await persistencia.executar((tx) =>
          tx.eventos.porTipo('operacaoResultadoRegistrado'),
        );
        const evidencias = eventos.filter((e) => e.operacaoId === op.id);
        expect(evidencias).toHaveLength(1);
        expect(evidencias[0]).toMatchObject({
          sistema: 'docusign',
          pedidoId: c.pedido.id,
          operacaoId: op.id,
        });
        expect(evidencias[0]?.correlacaoId).toBeTruthy();
        expect(JSON.stringify(evidencias)).not.toMatch(
          /token-ficticio|segredo-do-fornecedor|BEGIN.*PRIVATE/,
        );
        if (status === 200) expect(registrada?.referenciaExterna).toBe('externo-docusign');
        if (status === 503) {
          const reconciliacoes = await persistencia.executar((tx) =>
            tx.eventos.porTipo('operacaoEncaminhadaParaReconciliacao'),
          );
          expect(reconciliacoes.filter((e) => e.operacaoId === op.id)).toHaveLength(1);
        }
      },
    );
  },
);
