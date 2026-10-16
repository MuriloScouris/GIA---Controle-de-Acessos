import { expect, it } from 'vitest';
import { montarApi } from './teste/apoio.js';

it('auditor consulta histórico persistido paginado; demais papéis não recebem snapshots ou acesso', async () => {
  const api = montarApi();
  try {
    const revisor = await api.entrar('revisor');
    const importacao = (await api.importar(revisor)).json();
    const pedidoId: string = importacao.criados[0].pedidoId;
    const auditor = await api.entrar('auditor');
    const primeira = await api.get(auditor, `/pedidos/${pedidoId}/historico?limite=1`);
    expect(primeira.statusCode).toBe(200);
    const pagina = primeira.json();
    expect(pagina.eventos).toHaveLength(1);
    expect(pagina.proximoCursor).toBeTypeOf('string');
    expect(pagina.eventos[0]).toMatchObject({ pedidoId });
    expect(pagina.eventos[0]).not.toHaveProperty('antes');
    expect(pagina.eventos[0]).not.toHaveProperty('depois');
    expect(pagina.eventos[0]).not.toHaveProperty('dados');
    const segunda = (
      await api.get(
        auditor,
        `/pedidos/${pedidoId}/historico?limite=1&cursor=${encodeURIComponent(pagina.proximoCursor)}`,
      )
    ).json();
    expect(segunda.eventos).toHaveLength(1);
    expect(segunda.eventos[0].id).not.toBe(pagina.eventos[0].id);
    const outroId: string = importacao.criados[1].pedidoId;
    const outro = (await api.get(auditor, `/pedidos/${outroId}/historico?limite=1`)).json();
    const cruzado = await api.get(
      auditor,
      `/pedidos/${pedidoId}/historico?cursor=${outro.eventos[0].id}`,
    );
    expect(cruzado.statusCode).toBe(200);
    expect(cruzado.json().eventos).toEqual([]);
    const admin = await api.entrar('administradorGia');
    expect((await api.get(admin, `/pedidos/${pedidoId}/historico`)).statusCode).toBe(200);
    expect((await api.get(null, `/pedidos/${pedidoId}/historico`)).statusCode).toBe(401);
    for (const papel of ['revisor', 'executor', 'solicitante', 'administradorTecnico'] as const) {
      const cookie = await api.entrar(papel);
      expect((await api.get(cookie, `/pedidos/${pedidoId}/historico`)).statusCode).toBe(403);
    }
    expect((await api.get(auditor, `/pedidos/${pedidoId}/historico?limite=1000`)).statusCode).toBe(
      400,
    );
    expect(
      (await api.get(auditor, `/pedidos/${pedidoId}/historico?cursor=invalido`)).statusCode,
    ).toBe(400);
  } finally {
    await api.app.close();
  }
});
