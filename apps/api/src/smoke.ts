import { pathToFileURL } from 'node:url';
import {
  prontidaoPublicaRespostaSchema,
  prontidaoRespostaSchema,
  type VariaveisAmbiente,
} from '@gia/contratos';

/**
 * Smoke test pós-deploy, somente leitura: não cria pedido, não abre sessão e
 * não toca sistema de destino. Roda contra uma API em execução
 * (`pnpm --filter @gia/api smoke` com `GIA_SMOKE_URL`) e sai com código 1 se
 * qualquer verificação falhar — é o critério para seguir ou fazer rollback.
 */
export interface VerificacaoSmoke {
  readonly nome: string;
  readonly ok: boolean;
  readonly detalhe: string;
}

export interface OpcoesSmoke {
  readonly url: string;
  /**
   * URL das métricas (porta interna), se o ambiente as expõe. A prontidão
   * detalhada é lida na mesma porta, em `/saude/pronta`.
   */
  readonly urlMetricas?: string;
  /**
   * Modo de escrita esperado; divergência é falha (ex.: escrita ligada sem
   * querer). Só a porta interna informa o modo, então exige `urlMetricas`.
   */
  readonly modoEsperado?: 'real' | 'simulado';
  /** Em produção o login simulado não pode existir. */
  readonly producao?: boolean;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export async function executarSmoke(opcoes: OpcoesSmoke): Promise<readonly VerificacaoSmoke[]> {
  const enviar = opcoes.fetch ?? fetch;
  const base = opcoes.url.replace(/\/+$/, '');
  const prazo = opcoes.timeoutMs ?? 5_000;
  const verificacoes: VerificacaoSmoke[] = [];
  const verificar = async (nome: string, teste: () => Promise<string>) => {
    try {
      verificacoes.push({ nome, ok: true, detalhe: await teste() });
    } catch (erro) {
      verificacoes.push({
        nome,
        ok: false,
        detalhe: erro instanceof Error ? erro.message : 'falhou',
      });
    }
  };
  const pedir = (caminho: string, init: RequestInit = {}) =>
    enviar(`${base}${caminho}`, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(prazo),
    });
  const exigir = (condicao: boolean, mensagem: string) => {
    if (!condicao) throw new Error(mensagem);
  };

  await verificar('vivacidade', async () => {
    const res = await pedir('/saude');
    exigir(res.status === 200, `/saude respondeu ${res.status}`);
    exigir(((await res.json()) as { status?: unknown }).status === 'ok', '/saude sem status ok');
    return '/saude 200';
  });

  await verificar('prontidao', async () => {
    const res = await pedir('/saude/pronta');
    // Porta pública (M7): só o status. Qualquer detalhe a mais é vazamento.
    const lido = prontidaoPublicaRespostaSchema.safeParse(await res.json());
    exigir(lido.success, '/saude/pronta pública expõe mais que o status');
    exigir(
      res.status === 200 && lido.data?.status === 'pronta',
      `/saude/pronta respondeu ${res.status}`,
    );
    return '/saude/pronta 200, só o status';
  });

  if (opcoes.urlMetricas !== undefined || opcoes.modoEsperado !== undefined) {
    await verificar('prontidao_interna', async () => {
      exigir(
        opcoes.urlMetricas !== undefined,
        'modo de escrita só é conferido na porta interna: informe GIA_SMOKE_METRICAS_URL',
      );
      const res = await enviar(new URL('/saude/pronta', opcoes.urlMetricas), {
        redirect: 'manual',
        signal: AbortSignal.timeout(prazo),
      });
      const corpo = prontidaoRespostaSchema.parse(await res.json());
      const falhas = Object.entries(corpo.verificacoes).filter(([, v]) => v === 'falha');
      exigir(
        res.status === 200 && corpo.status === 'pronta',
        `indisponível: ${falhas.map(([n]) => n).join(', ')}`,
      );
      if (opcoes.modoEsperado !== undefined) {
        exigir(
          corpo.escrita.modo === opcoes.modoEsperado,
          `escrita em modo ${corpo.escrita.modo}, esperado ${opcoes.modoEsperado}`,
        );
      }
      return `versão ${corpo.versao}, escrita ${corpo.escrita.modo} [${corpo.escrita.liberadas.join(', ')}]`;
    });
  }

  await verificar('cabecalhos', async () => {
    const res = await pedir('/saude');
    exigir(/^[0-9a-f-]{36}$/.test(res.headers.get('x-correlacao-id') ?? ''), 'sem x-correlacao-id');
    exigir(res.headers.get('cache-control') === 'no-store', 'sem cache-control no-store');
    exigir(res.headers.get('x-content-type-options') === 'nosniff', 'sem nosniff');
    return 'correlação, no-store e nosniff presentes';
  });

  await verificar('autenticacao', async () => {
    const res = await pedir('/pedidos');
    exigir(res.status === 401, `/pedidos sem sessão respondeu ${res.status}`);
    return 'dados exigem sessão';
  });

  if (opcoes.producao === true) {
    await verificar('login_simulado_ausente', async () => {
      const res = await pedir('/sessao/simulada', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-gia-csrf': '1' },
        body: JSON.stringify({ papel: 'auditor' }),
      });
      exigir(res.status === 404, `/sessao/simulada respondeu ${res.status}`);
      return 'sem login simulado';
    });
  }

  if (opcoes.urlMetricas !== undefined) {
    await verificar('metricas', async () => {
      const res = await enviar(opcoes.urlMetricas!, { signal: AbortSignal.timeout(prazo) });
      const texto = await res.text();
      exigir(
        res.status === 200 && texto.includes('gia_api_requisicoes_total'),
        'métricas indisponíveis',
      );
      return 'métricas expostas';
    });
  }
  return verificacoes;
}

export function opcoesDoAmbiente(env: VariaveisAmbiente): OpcoesSmoke {
  const url = env['GIA_SMOKE_URL']?.trim();
  if (!url) throw new Error('GIA_SMOKE_URL não configurada');
  const modo = env['GIA_SMOKE_MODO_ESPERADO']?.trim();
  const metricas = env['GIA_SMOKE_METRICAS_URL']?.trim();
  return {
    url,
    producao: env['GIA_AMBIENTE']?.trim() === 'producao',
    ...(modo === 'real' || modo === 'simulado' ? { modoEsperado: modo } : {}),
    ...(metricas ? { urlMetricas: metricas } : {}),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const resultado = await executarSmoke(opcoesDoAmbiente(process.env));
    for (const v of resultado) console.log(`${v.ok ? 'OK   ' : 'FALHA'} ${v.nome}: ${v.detalhe}`);
    process.exitCode = resultado.every((v) => v.ok) ? 0 : 1;
  } catch (erro) {
    console.error(erro instanceof Error ? erro.message : 'smoke falhou');
    process.exitCode = 1;
  }
}
