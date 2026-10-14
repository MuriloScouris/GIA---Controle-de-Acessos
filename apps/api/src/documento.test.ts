import { pedidoDetalheSchema, respostaErroSchema, resultadoImportacaoSchema } from '@gia/contratos';
import { describe, expect, it } from 'vitest';
import { montarApi } from './teste/apoio.js';

/**
 * Rota do documento de acessos sobre a persistência em memória. A emissão
 * com pedido concluído (que exige execução real) está nos testes ponta a
 * ponta, em `tests/e2e`.
 */
describe('GET /pedidos/:pedidoId/documento', () => {
  it('sem sessão 401; sem permissão 403; pedido que não concluiu 422, sem registrar emissão', async () => {
    const api = montarApi();
    const revisor = await api.entrar('revisor');
    const relatorio = resultadoImportacaoSchema.parse((await api.importar(revisor)).json());
    const pedidoId = relatorio.criados.find((c) => c.chave === 'RH-1001')!.pedidoId;
    const versao = pedidoDetalheSchema.parse(
      (await api.get(revisor, `/pedidos/${pedidoId}`)).json(),
    ).versao;
    expect(
      (
        await api.comando(revisor, pedidoId, {
          pedidoId,
          versaoEsperada: versao,
          acao: 'aprovar',
          dados: {},
        })
      ).statusCode,
    ).toBe(200);
    const url = `/pedidos/${pedidoId}/documento`;

    expect((await api.get(null, url)).statusCode).toBe(401);
    const auditor = await api.get(await api.entrar('auditor'), url);
    expect(auditor.statusCode).toBe(403);
    expect(respostaErroSchema.parse(auditor.json()).codigo).toBe('PERMISSAO_NEGADA');

    const aprovado = await api.get(await api.entrar('executor'), url);
    expect(aprovado.statusCode).toBe(422);
    expect(aprovado.headers['content-type']).toContain('application/json');
    expect(respostaErroSchema.parse(aprovado.json()).codigo).toBe('DOCUMENTO_INDISPONIVEL');

    expect(
      (await api.get(revisor, '/pedidos/00000000-0000-4000-8000-000000000000/documento'))
        .statusCode,
    ).toBe(404);
    expect(api.persistencia.espiar.eventos().filter((e) => e.tipo === 'documentoEmitido')).toEqual(
      [],
    );
  });
});
