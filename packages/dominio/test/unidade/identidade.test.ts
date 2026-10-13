import { describe, expect, it } from 'vitest';
import {
  ajustarIdentidade,
  aprovarPedido,
  derivarIdentidadeDoEmail,
  editarProposta,
  verificarIdentidade,
  verificarUsoDaIdentidade,
  configuracaoPadrao,
  LIMITE_LOGIN,
  type UsoIdentidade,
} from '../../src/index.js';
import {
  AGORA,
  cenarioRecebido,
  chamado,
  codigoErro,
  CPF_ANA,
  CPF_BRUNO,
  ctxRevisor,
  valor,
} from '../apoio/fabricas.js';

describe('Identidade a partir do e-mail corporativo do RH', () => {
  it('login, UPN, e-mail e proxyAddresses saem do e-mail sugerido', () => {
    const identidade = valor(
      derivarIdentidadeDoEmail({
        emailCorporativo: '  Ana.Souza@Empresa.com.br ',
        nomeCompleto: ' Ana   Maria Souza ',
      }),
    );
    expect(identidade).toEqual({
      login: 'ana.souza',
      upn: 'ana.souza@empresa.com.br',
      email: 'ana.souza@empresa.com.br',
      proxyAddresses: ['SMTP:ana.souza@empresa.com.br'],
      nomeExibicao: 'Ana Maria Souza',
      origem: 'emailCorporativoRh',
    });
  });

  it('e-mail ausente ou inválido vira pendência, sem login alternativo', () => {
    for (const email of [
      null,
      '',
      'sem-arroba',
      'a@b',
      'ana souza@empresa.com',
      '.ana@empresa.com',
      'ana..s@empresa.com',
      'ana+x@empresa.com',
    ]) {
      expect(
        codigoErro(derivarIdentidadeDoEmail({ emailCorporativo: email, nomeCompleto: 'Ana' })),
        String(email),
      ).toBe('EMAIL_CORPORATIVO_INVALIDO');
    }
  });

  it('login acima de 20 caracteres não é encurtado nem trocado automaticamente', () => {
    const resultado = derivarIdentidadeDoEmail({
      emailCorporativo: 'ana.maria.souza.pereira@empresa.com.br',
      nomeCompleto: 'Ana Maria Souza Pereira',
    });
    expect(codigoErro(resultado)).toBe('LOGIN_EXCEDE_LIMITE');
    expect(LIMITE_LOGIN).toBe(20);
  });

  it('pedido com e-mail inválido é criado com pendência de identidade e não pode ser aprovado', () => {
    const { pedido, revisao, colaborador } = cenarioRecebido({
      chamado: chamado({ email: 'invalido' }),
    });
    expect(revisao.identidade).toBeNull();
    expect(revisao.pendenciaIdentidade?.codigo).toBe('EMAIL_CORPORATIVO_INVALIDO');
    expect(
      codigoErro(verificarIdentidade({ pedido, revisao, usos: [] }, pedido.versao, ctxRevisor())),
    ).toBe('IDENTIDADE_AUSENTE');
    expect(
      codigoErro(
        aprovarPedido(
          { pedido, revisao, colaborador, itensAnteriores: [] },
          pedido.versao,
          ctxRevisor(),
        ),
      ),
    ).toBe('IDENTIDADE_AUSENTE');
  });

  it('ajuste manual valida login e e-mail e marca a origem', () => {
    const ajustada = valor(
      ajustarIdentidade({
        login: 'Ana.Souza2',
        email: 'ana.souza2@empresa.com.br',
        nomeExibicao: 'Ana Souza',
      }),
    );
    expect(ajustada).toMatchObject({
      login: 'ana.souza2',
      upn: 'ana.souza2@empresa.com.br',
      origem: 'ajusteManual',
    });
    expect(
      codigoErro(
        ajustarIdentidade({ login: 'ana souza', email: 'a@empresa.com', nomeExibicao: 'Ana' }),
      ),
    ).toBe('DADO_INVALIDO');
    expect(
      codigoErro(
        ajustarIdentidade({ login: 'ana', email: 'a@empresa.com', nomeExibicao: 'Ana', upn: 'x' }),
      ),
    ).toBe('DADO_INVALIDO');
  });
});

describe('Verificação de colisão e uso', () => {
  const identidade = valor(
    derivarIdentidadeDoEmail({
      emailCorporativo: 'ana.souza@empresa.com.br',
      nomeCompleto: 'Ana Souza',
    }),
  );

  it('sem usos, a identidade está livre', () => {
    const verificacao = verificarUsoDaIdentidade(identidade, [], CPF_ANA, AGORA);
    expect(verificacao.situacao).toBe('livre');
  });

  it('login ou endereço usado por outra pessoa é conflito; sem CPF conhecido também', () => {
    const usos: UsoIdentidade[] = [
      { fonte: 'ad', campo: 'login', valor: 'ANA.SOUZA', cpfTitular: CPF_BRUNO },
      {
        fonte: 'm365',
        campo: 'proxyAddress',
        valor: 'smtp:ana.souza@empresa.com.br',
        cpfTitular: null,
      },
      { fonte: 'ad', campo: 'login', valor: 'outro.login', cpfTitular: null },
    ];
    const verificacao = verificarUsoDaIdentidade(identidade, usos, CPF_ANA, AGORA);
    expect(verificacao.situacao).toBe('emUsoPorOutraPessoa');
    expect(verificacao.conflitos).toHaveLength(2);
  });

  it('uso pela mesma pessoa (mesmo CPF, ex.: readmissão) não bloqueia', () => {
    const verificacao = verificarUsoDaIdentidade(
      identidade,
      [{ fonte: 'ad', campo: 'email', valor: 'ana.souza@empresa.com.br', cpfTitular: CPF_ANA }],
      CPF_ANA,
      AGORA,
    );
    expect(verificacao.situacao).toBe('emUsoPelaMesmaPessoa');
    expect(verificacao.conflitos).toHaveLength(0);
  });

  it('aprovação exige verificação feita, atual e sem conflito; a correção é humana', () => {
    const recebido = cenarioRecebido();
    expect(
      codigoErro(
        aprovarPedido(
          {
            pedido: recebido.pedido,
            revisao: recebido.revisao,
            colaborador: recebido.colaborador,
            itensAnteriores: [],
          },
          recebido.pedido.versao,
          ctxRevisor(),
        ),
      ),
    ).toBe('IDENTIDADE_NAO_VERIFICADA');

    const emUso = valor(
      verificarIdentidade(
        {
          pedido: recebido.pedido,
          revisao: recebido.revisao,
          usos: [{ fonte: 'ad', campo: 'login', valor: 'ana.souza', cpfTitular: CPF_BRUNO }],
        },
        recebido.pedido.versao,
        ctxRevisor(),
      ),
    );
    expect(emUso.revisao.identidade?.login).toBe('ana.souza');
    expect(
      codigoErro(
        aprovarPedido(
          {
            pedido: emUso.pedido,
            revisao: emUso.revisao,
            colaborador: recebido.colaborador,
            itensAnteriores: [],
          },
          emUso.pedido.versao,
          ctxRevisor(),
        ),
      ),
    ).toBe('IDENTIDADE_EM_USO');

    const ajustado = valor(
      editarProposta(
        {
          pedido: emUso.pedido,
          revisao: emUso.revisao,
          configuracao: configuracaoPadrao(),
          identidade: {
            login: 'ana.msouza',
            email: 'ana.msouza@empresa.com.br',
            nomeExibicao: 'Ana Souza',
          },
        },
        emUso.pedido.versao,
        ctxRevisor(),
      ),
    );
    expect(ajustado.revisao.verificacaoIdentidade).toBeNull();
    expect(ajustado.revisao.itens.find((item) => item.sistema === 'ad')?.parametros).toMatchObject({
      login: 'ana.msouza',
      email: 'ana.msouza@empresa.com.br',
    });

    const verificado = valor(
      verificarIdentidade(
        { pedido: ajustado.pedido, revisao: ajustado.revisao, usos: [] },
        ajustado.pedido.versao,
        ctxRevisor(),
      ),
    );
    const aprovado = valor(
      aprovarPedido(
        {
          pedido: verificado.pedido,
          revisao: verificado.revisao,
          colaborador: recebido.colaborador,
          itensAnteriores: [],
        },
        verificado.pedido.versao,
        ctxRevisor(),
      ),
    );
    expect(aprovado.colaborador).toMatchObject({
      login: 'ana.msouza',
      email: 'ana.msouza@empresa.com.br',
    });
  });
});
