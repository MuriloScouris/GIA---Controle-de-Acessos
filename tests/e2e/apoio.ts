import { criarAppDoAmbiente } from '@gia/api';
import { criarCatalogoSimulado, type CatalogoSimulado } from '@gia/conectores';
import {
  configuracaoPadrao,
  criarAtorDaSessao,
  etapasDe,
  POLITICA_EXECUCAO_PADRAO,
  SISTEMAS,
  solicitarExecucao,
  type Conector,
  type ContextoItem,
  type ItemAcesso,
  type ParametrosSistema,
  type Sistema,
} from '@gia/dominio';
import {
  criarPersistenciaPostgres,
  type RepositoriosComFila,
  type UnidadeDeTrabalho,
} from '@gia/persistencia';
import type { BancoDeTeste } from '@gia/persistencia/teste';
import { criarExecutor, type DependenciasExecutor, type Executor } from '@gia/worker';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

/**
 * Apoio dos testes ponta a ponta: a API sobe pelo mesmo caminho de produção
 * (`criarAppDoAmbiente` com `GIA_DATABASE_URL`), o worker é o executor real
 * sobre o mesmo PostgreSQL, e os fornecedores são os simuladores de
 * `@gia/conectores`. Nada abre rede.
 */

export const CSRF = { 'x-gia-csrf': '1' } as const;

export interface Gia {
  readonly app: FastifyInstance;
  readonly persistencia: UnidadeDeTrabalho<RepositoriosComFila>;
  entrar(papel: string): Promise<string>;
  get(cookie: string | null, url: string): Promise<LightMyRequestResponse>;
  post(cookie: string, url: string, corpo: unknown): Promise<LightMyRequestResponse>;
  fechar(): Promise<void>;
}

export function subirGia(banco: BancoDeTeste): Gia {
  // Teste automatizado: a sessão simulada só existe com opt-in explícito fora de desenvolvimento.
  const app = criarAppDoAmbiente({
    GIA_AMBIENTE: 'teste',
    GIA_AUTH_SIMULADA: 'true',
    GIA_DATABASE_URL: banco.url,
  });
  const post = (cookie: string | null, url: string, corpo: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...CSRF, ...(cookie === null ? {} : { cookie }) },
      payload: corpo as object,
    });
  return {
    app,
    persistencia: criarPersistenciaPostgres(banco.outraConexao()),
    async entrar(papel) {
      const res = await post(null, '/sessao/simulada', { papel });
      if (res.statusCode !== 201) throw new Error(`login simulado falhou: ${res.statusCode}`);
      const cookie = String(res.headers['set-cookie']).split(';')[0];
      if (cookie === undefined) throw new Error('login sem cookie');
      return cookie;
    },
    get: (cookie, url) =>
      app.inject({ method: 'GET', url, headers: cookie === null ? {} : { cookie } }),
    post,
    fechar: () => app.close(),
  };
}

/** Worker real (lease, retomada, consolidação) sobre o banco do teste. */
export function subirWorker(
  banco: BancoDeTeste,
  conectores: DependenciasExecutor['conectores'],
  mudancas: Partial<DependenciasExecutor> = {},
): Executor {
  return criarExecutor({
    persistencia: criarPersistenciaPostgres(banco.outraConexao()),
    conectores,
    politica: POLITICA_EXECUCAO_PADRAO,
    workerId: 'worker-e2e',
    agora: () => new Date().toISOString(),
    novoId: randomUUID,
    sortearJitter: () => 0,
    ...mudancas,
  });
}

/**
 * Simuladores com o estado que os parâmetros dos itens pedem (OUs, grupos,
 * perfis, cadastros SoftExpert e a identidade já sincronizada no Entra ID),
 * como num ambiente de homologação preparado.
 */
export function simuladoresPara(itens: readonly ItemAcesso[]): CatalogoSimulado {
  const de = <S extends Sistema>(sistema: S) =>
    itens
      .map((item) => item.parametros)
      .filter((p): p is Extract<ParametrosSistema, { sistema: S }> => p.sistema === sistema);
  const ad = de('ad');
  const m365 = de('m365');
  const docusign = de('docusign');
  const softexpert = de('softexpert');
  const jira = de('jira');
  return criarCatalogoSimulado({
    ad: { ous: ad.map((p) => p.ou), grupos: ad.flatMap((p) => p.grupos) },
    m365: {
      usuarios: m365.map((p) => ({
        upn: p.upn,
        id: `entra-${randomUUID()}`,
        paisUso: null,
        licencas: [],
        grupos: [],
      })),
      planos: m365.flatMap((p) => p.planosLicenca),
      grupos: m365.flatMap((p) => (p.grupo === null ? [] : [p.grupo])),
    },
    docusign: { perfis: docusign.map((p) => p.perfil), grupos: docusign.map((p) => p.grupo) },
    softexpert: {
      areas: softexpert.map((p) => p.area),
      funcoes: softexpert.map((p) => p.funcao),
      grupos: softexpert.map((p) => p.grupoAcesso),
    },
    jira: { grupos: jira.flatMap((p) => p.grupos) },
  });
}

/**
 * Fornecedor "real" de teste: responde em modo `real` e confirma todas as
 * etapas. Só existe para alcançar um pedido concluído, porque a configuração
 * do Gia ainda não aceita ligar a escrita externa (regras 8 e 9).
 */
export function fornecedoresReaisDeTeste(): {
  readonly conectores: Readonly<Record<Sistema, Conector>>;
  readonly chamadas: ContextoItem[];
} {
  const chamadas: ContextoItem[] = [];
  const conector = (sistema: Sistema): Conector => ({
    testarConexao: async () => ({ modo: 'real', disponivel: true, codigo: 'OK', mensagem: 'ok' }),
    validar: async () => ({ modo: 'real', impedimentos: [], avisos: [] }),
    conferirExistencia: () => Promise.reject(new Error('não usado')),
    provisionar: async (ctx) => {
      chamadas.push(ctx);
      return {
        efeito: 'confirmado',
        modo: 'real',
        etapa: etapasDe(sistema, 'provisionar').at(-1) ?? null,
        codigo: 'OK',
        // Como o adaptador real: o SoftExpert identifica a pessoa por matrícula ou CPF.
        referenciaExterna:
          ctx.parametros.sistema === 'softexpert'
            ? ctx.parametros.identificador
            : `${sistema}-${ctx.itemId.slice(0, 8)}`,
        mensagem: 'Concluído no destino.',
        transitorio: false,
        tentarAposMs: null,
      };
    },
    revogar: () => Promise.reject(new Error('não usado')),
  });
  return {
    conectores: Object.fromEntries(SISTEMAS.map((s) => [s, conector(s)])) as Record<
      Sistema,
      Conector
    >,
    chamadas,
  };
}

/**
 * Pede a execução em modo real, como faria a API com a escrita liberada pelo
 * administrador técnico (hoje a configuração do Gia recusa isso). Usa o caso
 * de uso do domínio, na mesma transação de estado, fila e eventos.
 */
export async function solicitarExecucaoReal(
  persistencia: UnidadeDeTrabalho<RepositoriosComFila>,
  pedidoId: string,
): Promise<void> {
  const liberada = {
    ...configuracaoPadrao(),
    liberacaoEscrita: Object.fromEntries(
      SISTEMAS.map((s) => [s, { criar: true, revogar: false }]),
    ) as ReturnType<typeof configuracaoPadrao>['liberacaoEscrita'],
  };
  await persistencia.executar(async (tx) => {
    const pedido = await tx.pedidos.porId(pedidoId);
    if (pedido === null) throw new Error('pedido não encontrado');
    const revisao = await tx.revisoes.porId(pedido.revisaoCorrenteId);
    if (revisao === null) throw new Error('revisão não encontrada');
    const solicitada = solicitarExecucao(
      {
        pedido,
        revisao,
        itens: await tx.itens.doPedido(pedido.id),
        operacoesExistentes: await tx.operacoes.doPedido(pedido.id),
        configuracao: liberada,
        modo: 'real',
      },
      pedido.versao,
      {
        ator: criarAtorDaSessao({
          usuarioId: 'usuario-executor-e2e',
          nome: 'Executor (e2e)',
          papeis: ['executor'],
        }),
        agora: new Date().toISOString(),
        correlacaoId: 'e2e-escrita-liberada',
        novoId: randomUUID,
      },
    );
    if (!solicitada.ok) throw new Error(solicitada.erro.codigo);
    await tx.pedidos.salvar(solicitada.valor.pedido);
    await tx.itens.salvar(solicitada.valor.itens);
    await tx.operacoes.salvar(solicitada.valor.operacoes);
    await tx.eventos.anexar(solicitada.valor.eventos);
  });
}
