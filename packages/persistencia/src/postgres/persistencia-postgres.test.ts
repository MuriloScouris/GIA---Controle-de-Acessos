import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErroDeConcorrencia, ErroDeIntegridade } from '../erros.js';
import type { RepositoriosComFila } from '../portas.js';
import {
  criarBancoDeTeste,
  TEM_BANCO,
  TEMPO_BANCO_MS,
  type BancoDeTeste,
} from '../teste/banco-de-teste.js';
import { cenario, ctxServico, evento, operacao, type Cenario } from '../teste/fabricas.js';
import type { UnidadeDeTrabalho } from '../unidade-de-trabalho.js';
import { criarPersistenciaPostgres, traduzirErro } from './persistencia-postgres.js';

let banco: BancoDeTeste;
let persistencia: UnidadeDeTrabalho<RepositoriosComFila>;

beforeAll(async () => {
  banco = await criarBancoDeTeste();
  persistencia = criarPersistenciaPostgres(banco.db);
}, TEMPO_BANCO_MS);
afterAll(async () => {
  await banco?.descartar();
}, TEMPO_BANCO_MS);

async function gravarCenario(c: Cenario = cenario()): Promise<Cenario> {
  await persistencia.executar(async (tx) => {
    await tx.colaboradores.salvar(c.colaborador);
    await tx.pedidos.salvar(c.pedido);
    await tx.revisoes.salvar(c.revisao);
    await tx.itens.salvar(Object.values(c.itens));
  });
  return c;
}

async function contar(tabela: 'pedidos' | 'eventos' | 'operacoes', pedidoId: string) {
  const r = await sql<{ n: string }>`
    select count(*) as n from ${sql.table(tabela)}
    where ${sql.ref(tabela === 'pedidos' ? 'id' : 'pedido_id')} = ${pedidoId}
  `.execute(banco.db);
  return Number(r.rows[0]?.n);
}

describe.skipIf(!TEM_BANCO)(
  'persistência PostgreSQL: repositórios',
  { timeout: TEMPO_BANCO_MS },
  () => {
    it('grava e relê cada entidade inteira, com consultas por chave', async () => {
      const c = await gravarCenario();
      const op = operacao(c.itens.ad);
      const ev = evento(ctxServico(), c.pedido.id);
      await persistencia.executar(async (tx) => {
        await tx.operacoes.salvar([op]);
        await tx.eventos.anexar([ev]);
      });

      await persistencia.executar(async (tx) => {
        expect(await tx.colaboradores.porId(c.colaborador.id)).toEqual(c.colaborador);
        expect(await tx.colaboradores.porCpf(c.colaborador.cpf)).toEqual(c.colaborador);
        expect(await tx.pedidos.porId(c.pedido.id)).toEqual(c.pedido);
        expect(
          await tx.pedidos.porOrigem(`jira:${c.pedido.origem.idExterno.toUpperCase()}`),
        ).toEqual(c.pedido);
        expect(await tx.revisoes.porId(c.revisao.id)).toEqual(c.revisao);
        expect(await tx.itens.doPedido(c.pedido.id)).toEqual(Object.values(c.itens));
        expect(await tx.operacoes.doPedido(c.pedido.id)).toEqual([op]);
        const lidos = await tx.eventos.porTipo('execucaoSolicitada');
        expect(lidos.at(-1)).toEqual(ev);
        expect(Object.isFrozen(lidos.at(-1))).toBe(true);
        expect(await tx.pedidos.porId('00000000-0000-4000-8000-000000000000')).toBeNull();
      });
    });

    it('listagens seguem a ordem de inserção', async () => {
      const primeiro = await gravarCenario();
      const segundo = await gravarCenario();
      const ids = await persistencia.executar(async (tx) =>
        (await tx.pedidos.todos()).map((p) => p.id),
      );
      expect(ids.indexOf(primeiro.pedido.id)).toBeLessThan(ids.indexOf(segundo.pedido.id));
    });
  },
);

describe.skipIf(!TEM_BANCO)(
  'persistência PostgreSQL: atomicidade (estado + evento + fila)',
  { timeout: TEMPO_BANCO_MS },
  () => {
    it('falha no meio do trabalho desfaz estado, eventos e operações', async () => {
      const c = cenario();
      await expect(
        persistencia.executar(async (tx) => {
          await tx.colaboradores.salvar(c.colaborador);
          await tx.pedidos.salvar(c.pedido);
          await tx.revisoes.salvar(c.revisao);
          await tx.itens.salvar([c.itens.ad]);
          await tx.operacoes.salvar([operacao(c.itens.ad)]);
          await tx.eventos.anexar([evento(ctxServico(), c.pedido.id)]);
          throw new Error('falha depois de gravar tudo');
        }),
      ).rejects.toThrow('falha depois de gravar tudo');
      expect(await contar('pedidos', c.pedido.id)).toBe(0);
      expect(await contar('operacoes', c.pedido.id)).toBe(0);
      expect(await contar('eventos', c.pedido.id)).toBe(0);
    });

    it('confirma estado, eventos e operações juntos', async () => {
      const c = await gravarCenario();
      await persistencia.executar(async (tx) => {
        await tx.pedidos.salvar({ ...c.pedido, status: 'emExecucao', versao: 2 });
        await tx.operacoes.salvar([operacao(c.itens.ad), operacao(c.itens.jira)]);
        await tx.eventos.anexar([evento(ctxServico(), c.pedido.id)]);
      });
      expect(await contar('operacoes', c.pedido.id)).toBe(2);
      expect(await contar('eventos', c.pedido.id)).toBe(1);
    });

    it('chave estrangeira é conferida no commit: a ordem de gravação não importa, a ausência sim', async () => {
      const c = cenario();
      await persistencia.executar(async (tx) => {
        await tx.itens.salvar([c.itens.ad]);
        await tx.pedidos.salvar(c.pedido);
        await tx.revisoes.salvar(c.revisao);
        await tx.colaboradores.salvar(c.colaborador);
      });
      const orfao = cenario();
      await expect(
        persistencia.executar((tx) => tx.pedidos.salvar(orfao.pedido)),
      ).rejects.toBeInstanceOf(ErroDeIntegridade);
      expect(await contar('pedidos', orfao.pedido.id)).toBe(0);
    });
  },
);

describe.skipIf(!TEM_BANCO)(
  'persistência PostgreSQL: unicidades e imutabilidade',
  { timeout: TEMPO_BANCO_MS },
  () => {
    it('CPF, origem, (revisão, sistema), chave de idempotência e operação ativa por item são únicos', async () => {
      const c = await gravarCenario();
      const outro = cenario();
      const casos: [string, (tx: RepositoriosComFila) => Promise<void>][] = [
        [
          'CPF do colaborador',
          (tx) => tx.colaboradores.salvar({ ...outro.colaborador, cpf: c.colaborador.cpf }),
        ],
        [
          'origem do pedido',
          async (tx) => {
            await tx.colaboradores.salvar(outro.colaborador);
            // Mesma chave canônica com caixa e espaços diferentes.
            await tx.pedidos.salvar({
              ...outro.pedido,
              origem: {
                sistema: 'jira',
                idExterno: ` ${c.pedido.origem.idExterno.toLowerCase()} `,
              },
            });
          },
        ],
        [
          '(revisão, sistema) do item',
          (tx) =>
            tx.itens.salvar([
              { ...outro.itens.ad, pedidoId: c.pedido.id, revisaoId: c.revisao.id },
            ]),
        ],
        [
          'chave de idempotência da operação',
          async (tx) => {
            const primeira = operacao(c.itens.ad);
            await tx.operacoes.salvar([primeira]);
            await tx.operacoes.salvar([
              operacao(c.itens.jira, { chaveIdempotencia: primeira.chaveIdempotencia }),
            ]);
          },
        ],
        [
          'o item já tem operação ativa',
          (tx) => tx.operacoes.salvar([operacao(c.itens.m365), operacao(c.itens.m365)]),
        ],
      ];
      for (const [motivo, trabalho] of casos) {
        const erro = await persistencia.executar(trabalho).catch((e: unknown) => e);
        expect(erro, motivo).toBeInstanceOf(ErroDeIntegridade);
        expect((erro as Error).message).toBe(`Integridade violada: ${motivo}`);
        // A mensagem nunca repete o valor que colidiu.
        expect((erro as Error).message).not.toContain(c.colaborador.cpf);
      }
    });

    it('evento é somente inserção: regravar, alterar ou apagar é recusado', async () => {
      const c = await gravarCenario();
      const ev = evento(ctxServico(), c.pedido.id);
      await persistencia.executar((tx) => tx.eventos.anexar([ev]));
      await expect(persistencia.executar((tx) => tx.eventos.anexar([ev]))).rejects.toThrow(
        'Integridade violada: evento já registrado',
      );
      for (const comando of [
        sql`update eventos set tipo = 'pedidoAprovado' where id = ${ev.id}`,
        sql`delete from eventos where id = ${ev.id}`,
        sql`truncate eventos`,
      ]) {
        const erro = await comando.execute(banco.db).catch((e: unknown) => traduzirErro(e));
        expect(erro).toEqual(new ErroDeIntegridade('eventos são somente inserção'));
      }
      expect(await contar('eventos', c.pedido.id)).toBe(1);
    });

    it('revisão aprovada é imutável; rascunho pode mudar', async () => {
      const c = await gravarCenario();
      const aprovada = {
        ...c.revisao,
        situacao: 'aprovada' as const,
        aprovadaEm: c.pedido.criadoEm,
      };
      await persistencia.executar((tx) => tx.revisoes.salvar(aprovada));
      await expect(
        persistencia.executar((tx) => tx.revisoes.salvar({ ...aprovada, versaoRegras: 'outra' })),
      ).rejects.toThrow('Integridade violada: revisão aprovada é imutável');
      await expect(
        sql`delete from revisoes where id = ${c.revisao.id}`.execute(banco.db),
      ).rejects.toThrow('revisão aprovada é imutável');
    });
  },
);

describe.skipIf(!TEM_BANCO)(
  'persistência PostgreSQL: controle otimista por versão',
  { timeout: TEMPO_BANCO_MS },
  () => {
    it('duas transações que partem da mesma versão: só a primeira grava', async () => {
      const c = await gravarCenario();
      const outra = criarPersistenciaPostgres(banco.outraConexao());
      let liberarPrimeira!: () => void;
      const segura = new Promise<void>((r) => {
        liberarPrimeira = r;
      });
      let primeiraGravou!: () => void;
      const gravou = new Promise<void>((r) => {
        primeiraGravou = r;
      });

      const primeira = persistencia.executar(async (tx) => {
        const pedido = await tx.pedidos.porId(c.pedido.id);
        await tx.pedidos.salvar({ ...pedido!, status: 'emExecucao', versao: 2 });
        primeiraGravou();
        await segura;
      });
      await gravou;
      let segundaLeu!: () => void;
      const leu = new Promise<void>((r) => {
        segundaLeu = r;
      });
      // A segunda lê a versão 1 (a primeira ainda não confirmou) e depois espera a trava da linha.
      const versaoLida: number[] = [];
      const segunda = outra.executar(async (tx) => {
        const pedido = await tx.pedidos.porId(c.pedido.id);
        versaoLida.push(pedido!.versao);
        segundaLeu();
        await tx.pedidos.salvar({ ...pedido!, status: 'rejeitado', versao: 2 });
      });
      await leu;
      expect(versaoLida).toEqual([1]);
      liberarPrimeira();
      await primeira;
      await expect(segunda).rejects.toEqual(new ErroDeConcorrencia('pedidos', c.pedido.id));
      const final = await persistencia.executar((tx) => tx.pedidos.porId(c.pedido.id));
      expect(final).toMatchObject({ status: 'emExecucao', versao: 2 });
    });

    it('gravação baseada em versão antiga é recusada; regravar sem mudança é aceito', async () => {
      const c = await gravarCenario();
      await persistencia.executar((tx) =>
        tx.pedidos.salvar({ ...c.pedido, status: 'emExecucao', versao: 2 }),
      );
      await expect(
        persistencia.executar((tx) =>
          tx.pedidos.salvar({ ...c.pedido, status: 'rejeitado', versao: 2 }),
        ),
      ).rejects.toBeInstanceOf(ErroDeConcorrencia);
      await expect(
        persistencia.executar((tx) => tx.pedidos.salvar({ ...c.pedido, versao: 1 })),
      ).rejects.toBeInstanceOf(ErroDeConcorrencia);
      // Mesma versão e mesmo conteúdo: no-op aceito (casos de uso regravam o agregado inteiro).
      await persistencia.executar((tx) =>
        tx.pedidos.salvar({ ...c.pedido, status: 'emExecucao', versao: 2 }),
      );
    });

    it('o domínio pode avançar várias versões na transação: vale a versão lida', async () => {
      const c = await gravarCenario();
      await persistencia.executar(async (tx) => {
        const pedido = await tx.pedidos.porId(c.pedido.id);
        // Ex.: editar a proposta (v+1) e revalidar a identidade (v+2) antes de gravar.
        await tx.pedidos.salvar({
          ...pedido!,
          status: 'pendenteAprovacao',
          versao: pedido!.versao + 2,
        });
      });
      const gravado = await persistencia.executar((tx) => tx.pedidos.porId(c.pedido.id));
      expect(gravado).toMatchObject({ status: 'pendenteAprovacao', versao: 3 });
    });

    it('mesma mudança aplicada em paralelo à mesma versão: a segunda é conflito, não no-op', async () => {
      const c = await gravarCenario();
      const outra = criarPersistenciaPostgres(banco.outraConexao());
      const mudanca = { ...c.pedido, status: 'emExecucao' as const, versao: 2 };
      let ambasLeram!: () => void;
      const leituras = new Promise<void>((r) => {
        ambasLeram = r;
      });
      let lidas = 0;
      const aplicar = (p: UnidadeDeTrabalho<RepositoriosComFila>) =>
        p.executar(async (tx) => {
          await tx.pedidos.porId(c.pedido.id);
          lidas += 1;
          if (lidas === 2) ambasLeram();
          await leituras;
          await tx.pedidos.salvar(mudanca);
        });
      const resultados = await Promise.allSettled([aplicar(persistencia), aplicar(outra)]);
      expect(resultados.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const recusa = resultados.find((r) => r.status === 'rejected');
      expect(recusa?.status === 'rejected' && recusa.reason).toBeInstanceOf(ErroDeConcorrencia);
    });

    it('a mesma transação pode gravar o registro mais de uma vez', async () => {
      const c = await gravarCenario();
      await persistencia.executar(async (tx) => {
        await tx.itens.salvar([{ ...c.itens.ad, status: 'emExecucao', versao: 2 }]);
        await tx.itens.salvar([
          { ...c.itens.ad, status: 'emExecucao', mensagem: 'ajuste', versao: 2 },
        ]);
        await tx.itens.salvar([{ ...c.itens.ad, status: 'confirmado', versao: 3 }]);
      });
      const [item] = await persistencia.executar((tx) => tx.itens.doPedido(c.pedido.id));
      expect(item).toMatchObject({ status: 'confirmado', versao: 3 });
    });
  },
);
