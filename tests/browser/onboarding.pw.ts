import { test, expect, entrar, importar, aprovar, executar } from './fixture.js';
import { pedidoDetalheSchema, historicoPedidoSchema } from '@gia/contratos';

test('revisor edita proposta, rejeita com motivo e reabre sem criar acessos', async ({
  page,
  ambiente,
}) => {
  await entrar(page, ambiente.url, 'Revisor/aprovador');
  await importar(page);
  await page.getByRole('link', { name: 'RH-1001', exact: true }).click();
  await page.getByRole('button', { name: 'Editar identidade', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Nome de exibição', { exact: true })
    .fill('Maria Ficticia Revisada');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Salvar identidade', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page
      .getByRole('region', { name: 'Identidade proposta' })
      .getByText('Maria Ficticia Revisada', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Rejeitar', exact: true }).click();
  const rejeitar = page.getByRole('dialog').getByRole('button', { name: 'Rejeitar', exact: true });
  await expect(rejeitar).toBeDisabled();
  await page
    .getByRole('dialog')
    .getByLabel('Motivo da rejeição')
    .fill('Rever informações do pedido fictício');
  await rejeitar.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(/Motivo da rejeição: Rever informações/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Provisionar/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Reabrir para revisão' }).click();
  await page.getByRole('dialog').getByLabel('Motivo', { exact: true }).fill('Dados revisados');
  await page.getByRole('dialog').getByRole('button', { name: 'Reabrir', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Aprovar', exact: true })).toBeVisible();
  const id = page.url().split('/').at(-1)!;
  const auditor = await ambiente.gia.entrar('auditor');
  const historico = (await ambiente.gia.get(auditor, `/pedidos/${id}/historico`)).json();
  expect(historico.eventos.map((e: { tipo: string }) => e.tipo)).toEqual(
    expect.arrayContaining(['propostaEditada', 'pedidoRejeitado', 'pedidoReaberto']),
  );
  const detalhe = pedidoDetalheSchema.parse(
    (await ambiente.gia.get(auditor, `/pedidos/${id}`)).json(),
  );
  expect(detalhe.itens).toEqual([]);
});

test('conflito entre sessões obriga rever a versão atual antes de confirmar outra ação', async ({
  page,
  ambiente,
}) => {
  await entrar(page, ambiente.url);
  await importar(page);
  await page.getByRole('link', { name: 'RH-1001', exact: true }).click();
  await page.getByRole('button', { name: 'Aprovar', exact: true }).click();
  const id = page.url().split('/').at(-1)!;
  const outroRevisor = await ambiente.gia.entrar('revisor');
  const detalhe = pedidoDetalheSchema.parse(
    (await ambiente.gia.get(outroRevisor, `/pedidos/${id}`)).json(),
  );
  expect(
    (
      await ambiente.gia.post(outroRevisor, `/pedidos/${id}/comandos`, {
        pedidoId: id,
        versaoEsperada: detalhe.versao,
        acao: 'aprovar',
        dados: {},
      })
    ).statusCode,
  ).toBe(200);
  await page.getByRole('dialog').getByRole('button', { name: 'Aprovar', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Revise o pedido atualizado');
  await expect(page.getByRole('button', { name: 'Aprovar', exact: true })).toHaveCount(0);
});

test('aba apresenta carregamento, erro recuperável e expiração sem manter os dados na tela', async ({
  page,
  ambiente,
  context,
}) => {
  let liberar!: () => void;
  const liberarResposta = new Promise<void>((r) => {
    liberar = r;
  });
  let primeira = true;
  await page.route('**/api/pedidos', async (route) => {
    if (!primeira) return route.continue();
    primeira = false;
    await liberarResposta;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, codigo: 'ERRO_INTERNO', mensagem: 'Indisponível' }),
    });
  });
  await entrar(page, ambiente.url);
  await expect(page.getByRole('status').filter({ hasText: 'Carregando pedidos' })).toBeVisible();
  liberar();
  await expect(page.getByRole('alert')).toContainText('Não foi possível carregar os dados');
  await page.getByRole('button', { name: 'Tentar de novo', exact: true }).click();
  await expect(page.getByText(/Nenhum pedido de onboarding ainda/)).toBeVisible();
  await importar(page);
  await page.getByRole('link', { name: 'RH-1001', exact: true }).click();
  await expect(page.getByRole('heading', { name: /RH-1001/ })).toBeVisible();
  await context.clearCookies();
  await page.getByRole('button', { name: 'Atualizar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Sua sessão expirou');
  await expect(page.getByRole('heading', { name: /RH-1001/ })).toHaveCount(0);
});

test('auditor tem leitura e histórico; forjar perfil local não concede escrita na API', async ({
  page,
  ambiente,
}) => {
  const revisor = await ambiente.gia.entrar('revisor');
  const importacao = (await ambiente.gia.post(revisor, '/importacoes/jira', {})).json();
  const id: string = importacao.criados[0].pedidoId;
  await entrar(page, ambiente.url, 'Auditor');
  await expect(page.getByRole('button', { name: 'Importar do Jira' })).toHaveCount(0);
  await page.goto(`${ambiente.url}/pedidos/${id}`);
  await expect(page.getByRole('list', { name: 'Histórico persistido do pedido' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Editar identidade' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Aprovar', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Provisionar/ })).toHaveCount(0);
  await page.evaluate(() =>
    globalThis.localStorage.setItem('gia.sessaoSimulada', 'administradorGia'),
  );
  await page.goto(ambiente.url);
  await page.getByRole('button', { name: 'Importar do Jira', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Importar', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  const negado = await page.request.post(`${ambiente.url}/api/pedidos/${id}/comandos`, {
    headers: { 'x-gia-csrf': '1' },
    data: { pedidoId: id, versaoEsperada: 2, acao: 'aprovar', dados: {} },
  });
  expect(negado.status()).toBe(403);
});

test('falha parcial e timeout de um sistema não escondem os demais; reenvio explícito só do item escolhido', async ({
  page,
  ambiente,
}) => {
  await entrar(page, ambiente.url);
  await importar(page);
  await page.getByRole('link', { name: 'RH-1001', exact: true }).click();
  await aprovar(page);
  await executar(page);
  await ambiente.executarWorker((catalogo) => {
    catalogo.simuladores.jira.roteiro.programar('adicionarAoGrupo', 'timeout', {
      efeitoAplicado: true,
    });
    catalogo.simuladores.ad.roteiro.aplicar('parcial');
  });
  await expect(page.getByText(/concluída \(Desconhecido\).*simulado/i)).toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(page.getByText(/concluída \(Parcial\).*simulado/i)).toHaveCount(1);
  await expect(page.getByText(/concluída \(Confirmado\).*simulado/i)).toHaveCount(3);
  await page.getByRole('button', { name: 'Provisionar Jira', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Solicitar execução', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(/Execução aceita: 1 operação/)).toBeVisible();
  await ambiente.executarWorker();
  await expect(page.getByText(/concluída.*simulado, não confirma acesso real/i)).toHaveCount(6, {
    timeout: 15_000,
  });
});

test('resposta perdida após aprovação exige releitura e não repete a decisão', async ({
  page,
  ambiente,
}) => {
  await entrar(page, ambiente.url);
  await importar(page);
  await page.getByRole('link', { name: 'RH-1001', exact: true }).click();
  let envios = 0;
  await page.route('**/api/pedidos/*/comandos', async (route) => {
    envios += 1;
    await route.fetch(); // a transação é confirmada na API real
    await route.abort('failed'); // a resposta não chega à aba
  });
  await page.getByRole('button', { name: 'Aprovar', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Aprovar', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Não foi possível confirmar');
  await expect(page.getByRole('button', { name: 'Aprovar', exact: true })).toHaveCount(0);
  expect(envios).toBe(1);
});

test('aba → HTTP → PostgreSQL → worker → cinco conectores → resultado e auditoria', async ({
  page,
  ambiente,
}, testInfo) => {
  await entrar(page, ambiente.url);
  await importar(page);
  await expect(page.getByRole('link', { name: 'RH-1001', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'RH-1001', exact: true }).click();
  await aprovar(page);
  await executar(page);
  await expect(page.getByText(/Execução aceita: 5 operação/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Provisionar todos os itens', exact: true }),
  ).toHaveCount(0);
  await ambiente.executarWorker();
  await expect(page.getByText(/concluída.*simulado, não confirma acesso real/i)).toHaveCount(5, {
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Atualizar histórico', exact: true }).click();
  await expect(page.getByText('Resultado da operação registrado', { exact: true })).toHaveCount(5);
  await expect(page.getByText('Pedido aprovado', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: /RH-1001/ })).toBeVisible();
  const id = page.url().split('/').at(-1)!;
  const eventos = [];
  let cursor: string | null = null;
  for (let pagina = 0; pagina < 50; pagina += 1) {
    const resposta = await page.request.get(
      `${ambiente.url}/api/pedidos/${id}/historico?limite=2${cursor ? `&cursor=${cursor}` : ''}`,
    );
    expect(resposta.status()).toBe(200);
    const historico = historicoPedidoSchema.parse(await resposta.json());
    eventos.push(...historico.eventos);
    cursor = historico.proximoCursor;
    if (cursor === null) break;
  }
  expect(cursor).toBeNull();
  expect(new Set(eventos.map((e) => e.id)).size).toBe(eventos.length);
  expect(eventos.filter((e) => e.tipo === 'operacaoResultadoRegistrado')).toHaveLength(5);
  expect(eventos.filter((e) => e.tipo === 'pedidoRecebido')).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('onboarding-validado.png') });
});
