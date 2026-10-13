import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  contemSegredo,
  criarEvento,
  falha,
  registrarResultadoOperacao,
  sanitizar,
  sanitizarTexto,
  validarItensPropostos,
  POLITICA_EXECUCAO_PADRAO,
  SISTEMAS_POR_VINCULO_PADRAO,
  VALOR_OCULTO,
  type ParametrosSistema,
} from '../../src/index.js';
import {
  AGORA,
  cenarioEmExecucao,
  codigoErro,
  ctxServico,
  itemDo,
  itemProposto,
  operacaoDo,
  parametrosAd,
  reservar,
  resultadoConector,
  valor,
} from '../apoio/fabricas.js';

const SEGREDO = 'S3nh@-Sup3r-Secreta';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLWRlLXRlc3Rl';

describe('Regra 12 — Segredos fora de tudo', () => {
  it('campos com nome de segredo são ocultados em qualquer profundidade', () => {
    const limpo = sanitizar({
      senha: SEGREDO,
      conta: { password: SEGREDO, clientSecret: SEGREDO, apiKey: SEGREDO },
      cabecalhos: [{ Authorization: `Bearer ${SEGREDO}` }],
      token: SEGREDO,
      chavePrivada: SEGREDO,
      chaveIdempotencia: 'gia:real:p:r:i:provisionar:g1',
      login: 'ana.souza',
    });
    expect(JSON.stringify(limpo)).not.toContain(SEGREDO);
    expect(limpo).toMatchObject({
      senha: VALOR_OCULTO,
      conta: { password: VALOR_OCULTO, clientSecret: VALOR_OCULTO, apiKey: VALOR_OCULTO },
      cabecalhos: [{ Authorization: VALOR_OCULTO }],
      token: VALOR_OCULTO,
      chavePrivada: VALOR_OCULTO,
      chaveIdempotencia: 'gia:real:p:r:i:provisionar:g1',
      login: 'ana.souza',
    });
  });

  it('segredos embutidos em texto são mascarados', () => {
    expect(sanitizarTexto(`falhou com Authorization: Bearer ${SEGREDO}`)).not.toContain(SEGREDO);
    expect(sanitizarTexto(`token ${JWT} recusado`)).not.toContain(JWT);
    expect(sanitizarTexto(`password=${SEGREDO}&user=ana`)).toBe(
      `password=${VALOR_OCULTO}&user=ana`,
    );
    expect(sanitizarTexto(`senha: "${SEGREDO}"`)).toBe(`senha: ${VALOR_OCULTO}`);
    expect(sanitizarTexto('conta ana.souza criada')).toBe('conta ana.souza criada');
  });

  it('eventos nunca guardam segredos', () => {
    const evento = valor(
      criarEvento({
        id: 'e1',
        tipo: 'operacaoResultadoRegistrado',
        origem: 'gia',
        ator: { tipo: 'humano', id: 'u1', nome: 'Executora', papeis: ['executor'] },
        instante: AGORA,
        antes: { senhaInicial: SEGREDO },
        depois: { mensagem: `client_secret=${SEGREDO}` },
        dados: { credencial: { usuario: 'svc', segredo: SEGREDO } },
      }),
    );
    expect(JSON.stringify(evento)).not.toContain(SEGREDO);
  });

  it('mensagens e evidências do conector são sanitizadas antes de gravar operação e evento', () => {
    const cenario = cenarioEmExecucao({ sistemas: ['ad'] });
    const item = itemDo(cenario.itens, 'ad');
    const registrado = valor(
      registrarResultadoOperacao(
        {
          operacao: reservar(operacaoDo(cenario.operacoes, item)),
          item,
          resultado: resultadoConector({
            efeito: 'semEfeito',
            codigo: 'LDAP_49',
            mensagem: `bind falhou para svc-gia password=${SEGREDO}`,
            referenciaExterna: `Bearer ${SEGREDO}`,
          }),
        },
        POLITICA_EXECUCAO_PADRAO,
        ctxServico(),
      ),
    );
    const gravado = JSON.stringify({
      operacao: registrado.operacao,
      item: registrado.item,
      eventos: registrado.eventos,
    });
    expect(gravado).not.toContain(SEGREDO);
    expect(registrado.operacao.mensagem).toContain(VALOR_OCULTO);
  });

  it('parâmetros de item com segredo são recusados', () => {
    const comSenha = { ...parametrosAd(), senhaInicial: SEGREDO } as ParametrosSistema;
    expect(contemSegredo(comSenha)).toBe(true);
    expect(
      codigoErro(
        validarItensPropostos(
          [itemProposto('ad', comSenha)],
          'celetista',
          SISTEMAS_POR_VINCULO_PADRAO,
        ),
      ),
    ).toBe('SEGREDO_NAO_PERMITIDO');
  });

  it('nenhum tipo de parâmetro aceita senha', () => {
    type Chaves = ParametrosSistema extends infer P ? (P extends unknown ? keyof P : never) : never;
    expectTypeOf<Extract<Chaves, 'senha' | 'password' | 'senhaInicial'>>().toEqualTypeOf<never>();
  });

  it('detalhes de erro devolvidos ao cliente também são sanitizados', () => {
    const resultado = falha('DADO_INVALIDO', { token: SEGREDO, motivo: `api_key=${SEGREDO}` });
    expect(JSON.stringify(resultado)).not.toContain(SEGREDO);
  });
});
