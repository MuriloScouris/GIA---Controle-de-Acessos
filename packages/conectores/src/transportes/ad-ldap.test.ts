import {
  AlreadyExistsError,
  BusyError,
  ConstraintViolationError,
  InsufficientAccessError,
  TypeOrValueExistsError,
} from 'ldapts';
import { describe, expect, it } from 'vitest';
import { criarConectorAd } from '../adaptadores/ad.js';
import { ErroFornecedor } from '../erros.js';
import { DiretorioLdapFalso } from '../teste/diretorio-ldap.js';
import {
  CPF_MARIA,
  contexto,
  contextoRevogacao,
  cpfFicticio,
  paramsAd,
} from '../teste/fabricas.js';
import { ClienteAdLdap, gerarSenhaForte, guidDe, type RegistroChamadaAd } from './ad-ldap.js';
import { traduzirErroLdap } from './ldap.js';

const BASE = 'DC=exemplo,DC=com,DC=br';
const OU = `OU=Tecnologia,${BASE}`;
const OU_INATIVOS = `OU=Inativos,${BASE}`;
const SENHA_FIXA = 'Senha-De-Teste-9xZ';

function montar(opcoes: { tentativasLeitura?: number } = {}) {
  const diretorio = new DiretorioLdapFalso(BASE);
  diretorio.criar(OU, { objectClass: ['organizationalUnit'] });
  diretorio.criar(OU_INATIVOS, { objectClass: ['organizationalUnit'] });
  for (const grupo of ['GG-Tecnologia', 'GG-VPN']) {
    diretorio.criar(`CN=${grupo},OU=Grupos,${BASE}`, {
      objectClass: ['group'],
      cn: [grupo],
      sAMAccountName: [grupo],
    });
  }
  diretorio.criar(`CN=Gestora Ficticia,${OU}`, {
    objectClass: ['top', 'person', 'organizationalPerson', 'user'],
    sAMAccountName: ['gestora.ficticia'],
    userAccountControl: ['512'],
    employeeID: [cpfFicticio('200000002')],
  });
  const registros: RegistroChamadaAd[] = [];
  const cliente = new ClienteAdLdap({
    abrirSessao: diretorio.abridor(),
    baseDn: BASE,
    atributoCpf: 'employeeID',
    tentativasLeitura: opcoes.tentativasLeitura ?? 2,
    esperaEntreTentativasMs: 0,
    gerarSenhaInicial: () => SENHA_FIXA,
    aoRegistrar: (r) => registros.push(r),
  });
  const conector = criarConectorAd(cliente, { modo: 'real', ouInativos: OU_INATIVOS });
  return { diretorio, cliente, conector, registros };
}

function nova(extra: Partial<ReturnType<typeof paramsAd>> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { sistema: _sistema, ...p } = paramsAd({ ou: OU, ...extra });
  return { ...p, dn: `CN=${p.nomeExibicao},${p.ou}` };
}

describe('transporte LDAPS do AD (ClienteAdLdap)', () => {
  it('provisiona de ponta a ponta em modo real: conta desabilitada → senha → habilita → grupos', async () => {
    const { diretorio, conector } = montar();
    const resultado = await conector.provisionar(
      contexto(paramsAd({ ou: OU, gerente: 'gestora.ficticia' })),
    );
    expect(resultado).toMatchObject({
      efeito: 'confirmado',
      modo: 'real',
      etapa: 'adicionarGrupos',
      codigo: 'OK',
    });
    expect(resultado.referenciaExterna).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const conta = diretorio.procurarPorLogin('maria.souza')!;
    expect(conta.dn).toBe(`CN=Maria Ficticia Souza,${OU}`);
    expect(conta.atributos['useraccountcontrol']).toEqual(['512']);
    expect(conta.atributos['employeeid']).toEqual([CPF_MARIA]);
    expect(conta.atributos['manager']).toEqual([`CN=Gestora Ficticia,${OU}`]);
    expect(conta.atributos['pwdlastset']).toEqual(['0']);
    expect(conta.atributos['memberof']).toHaveLength(2);

    const existencia = await conector.conferirExistencia(contexto(paramsAd({ ou: OU })));
    expect(existencia).toMatchObject({
      contaExiste: true,
      etapaComprovada: 'adicionarGrupos',
      modo: 'real',
    });
    expect(existencia.acessosEncontrados).toEqual(['grupo:GG-Tecnologia', 'grupo:GG-VPN']);
  });

  it('cria a conta sempre desabilitada, mesmo se o controle pedido for de conta habilitada', async () => {
    const { diretorio, cliente } = montar();
    await cliente.criarContaDesabilitada(nova({ controleConta: 512 }));
    expect(diretorio.procurarPorLogin('maria.souza')!.atributos['useraccountcontrol']).toEqual([
      '514',
    ]);
  });

  it('senha inicial vai em UTF-16LE entre aspas com troca obrigatória e nunca aparece no registro', async () => {
    const { diretorio, cliente, registros } = montar();
    await cliente.criarContaDesabilitada(nova());
    await cliente.definirSenhaInicial('maria.souza');
    const escrita = diretorio.escritas.find((e) => e.tipo === 'alterar')!;
    const senha = escrita.mudancas!.find((m) => m.atributo === 'unicodePwd')!.valores[0] as Buffer;
    expect(senha.equals(Buffer.from(`"${SENHA_FIXA}"`, 'utf16le'))).toBe(true);
    expect(escrita.mudancas!.find((m) => m.atributo === 'pwdLastSet')!.valores).toEqual(['0']);
    const texto = JSON.stringify(registros);
    expect(texto).not.toContain(SENHA_FIXA);
    expect(texto).not.toContain('maria');
    expect(texto).not.toContain(CPF_MARIA);
    expect(registros.map((r) => r.operacao)).toEqual([
      'criarContaDesabilitada',
      'definirSenhaInicial',
    ]);
  });

  it('a senha gerada por padrão é forte e muda a cada conta', () => {
    const senhas = new Set(Array.from({ length: 50 }, gerarSenhaForte));
    expect(senhas.size).toBe(50);
    for (const senha of senhas) {
      expect(senha).toHaveLength(24);
      expect(senha).toMatch(/[A-Z]/);
      expect(senha).toMatch(/[a-z]/);
      expect(senha).toMatch(/[0-9]/);
      expect(senha).toMatch(/[!#$%*+\-=?@_]/);
    }
  });

  it('escapa a entrada humana no filtro: login com metacaracteres não vira curinga', async () => {
    const { diretorio, cliente } = montar();
    await cliente.criarContaDesabilitada(nova());
    expect(await cliente.buscarConta('*')).toBeNull();
    expect(await cliente.buscarConta('maria*)(sAMAccountName=*')).toBeNull();
    expect(diretorio.buscas.at(-1)!.filtro).toContain('maria\\2a\\29\\28sAMAccountName=\\2a');
  });

  describe('idempotência', () => {
    it('recriar a conta que a tentativa anterior criou (resposta perdida) devolve o mesmo objectGUID', async () => {
      const { cliente } = montar();
      const primeiro = await cliente.criarContaDesabilitada(nova());
      expect(await cliente.criarContaDesabilitada(nova())).toBe(primeiro);
    });

    it('login de outra pessoa é recusado', async () => {
      const { cliente } = montar();
      await cliente.criarContaDesabilitada(nova());
      await expect(
        cliente.criarContaDesabilitada(nova({ cpf: cpfFicticio('300000003') })),
      ).rejects.toMatchObject({ tipo: 'recusado', codigo: 'LOGIN_EM_USO' });
    });

    it('homônimo na mesma OU (CN em uso por outro login) é recusado com código próprio', async () => {
      const { cliente } = montar();
      await cliente.criarContaDesabilitada(nova());
      await expect(
        cliente.criarContaDesabilitada(
          nova({ login: 'maria.souza2', cpf: cpfFicticio('300000003') }),
        ),
      ).rejects.toMatchObject({ tipo: 'recusado', codigo: 'AD_NOME_EM_USO' });
    });

    it('habilitar, adicionar a grupo, desabilitar e mover não escrevem de novo o que já está feito', async () => {
      const { diretorio, cliente } = montar();
      await cliente.criarContaDesabilitada(nova());
      await cliente.definirSenhaInicial('maria.souza');
      await cliente.habilitarConta('maria.souza');
      await cliente.adicionarAoGrupo('maria.souza', 'GG-VPN');
      const antes = diretorio.escritas.length;
      await cliente.habilitarConta('maria.souza');
      await cliente.adicionarAoGrupo('maria.souza', 'gg-vpn');
      expect(diretorio.escritas).toHaveLength(antes);

      await cliente.desabilitarConta('maria.souza');
      await cliente.moverParaOu('maria.souza', OU_INATIVOS);
      const depois = diretorio.escritas.length;
      await cliente.desabilitarConta('maria.souza');
      await cliente.moverParaOu('maria.souza', OU_INATIVOS);
      expect(diretorio.escritas).toHaveLength(depois);
    });

    it('membro já existente segundo o AD (código 68/20) é sucesso', async () => {
      const { diretorio, cliente } = montar();
      await cliente.criarContaDesabilitada(nova());
      // `memberOf` pode estar defasado em relação ao `member` do grupo (replicação entre DCs).
      diretorio.falhas.set('alterar', new AlreadyExistsError());
      await cliente.adicionarAoGrupo('maria.souza', 'GG-VPN');
      diretorio.falhas.set('alterar', new TypeOrValueExistsError());
      await cliente.adicionarAoGrupo('maria.souza', 'GG-Tecnologia');
      // Outra restrição violada não é engolida.
      diretorio.falhas.set('alterar', new ConstraintViolationError());
      await expect(cliente.adicionarAoGrupo('maria.souza', 'GG-VPN')).rejects.toMatchObject({
        codigo: 'AD_RESTRICAO_VIOLADA',
      });
    });
  });

  it('revoga: desabilita e move para a OU de inativos; repetir é JA_REVOGADO', async () => {
    const { diretorio, conector } = montar();
    await conector.provisionar(contexto(paramsAd({ ou: OU })));
    const revogado = await conector.revogar(contextoRevogacao(paramsAd({ ou: OU })));
    expect(revogado).toMatchObject({
      efeito: 'confirmado',
      etapa: 'moverParaOuInativos',
      modo: 'real',
    });
    const conta = diretorio.procurarPorLogin('maria.souza')!;
    expect(conta.dn).toBe(`CN=Maria Ficticia Souza,${OU_INATIVOS}`);
    expect(conta.atributos['useraccountcontrol']).toEqual(['514']);
    expect(conta.atributos['memberof']).toHaveLength(2);

    const denovo = await conector.revogar(contextoRevogacao(paramsAd({ ou: OU })));
    expect(denovo).toMatchObject({ efeito: 'confirmado', codigo: 'JA_REVOGADO' });
  });

  it('valida no AD: OU fora da base gerenciada e grupo inexistente impedem', async () => {
    const { conector } = montar();
    const validacao = await conector.validar(
      contexto(paramsAd({ ou: 'OU=Outra,DC=fora,DC=br', grupos: ['GG-Inexistente'] })),
    );
    expect(validacao.impedimentos.map((i) => i.codigo).sort()).toEqual([
      'GRUPO_INEXISTENTE',
      'OU_INEXISTENTE',
    ]);
  });

  it('não cria nem move fora da base gerenciada', async () => {
    const { diretorio, cliente } = montar();
    await expect(
      cliente.criarContaDesabilitada(nova({ ou: 'OU=X,DC=fora,DC=br' })),
    ).rejects.toMatchObject({
      codigo: 'AD_OU_FORA_DA_BASE',
    });
    await cliente.criarContaDesabilitada(nova());
    await expect(cliente.moverParaOu('maria.souza', 'OU=X,DC=fora,DC=br')).rejects.toMatchObject({
      codigo: 'AD_OU_FORA_DA_BASE',
    });
    expect(diretorio.escritas.filter((e) => e.tipo === 'renomear')).toHaveLength(0);
  });

  describe('falhas, timeout e retentativa', () => {
    it('leitura tenta de novo quando nenhum DC aceitou a conexão; escrita não', async () => {
      const { diretorio, cliente, registros } = montar({ tentativasLeitura: 2 });
      diretorio.falhasAoAbrir.push(new Error('ECONNREFUSED'));
      expect(await cliente.buscarConta('ninguem')).toBeNull();
      expect(diretorio.aberturas).toBe(2);
      expect(registros.at(-1)).toMatchObject({
        operacao: 'buscarConta',
        desfecho: 'ok',
        tentativas: 2,
      });

      diretorio.falhasAoAbrir.push(new Error('ECONNREFUSED'));
      await expect(cliente.criarContaDesabilitada(nova())).rejects.toMatchObject({
        tipo: 'conexaoRecusada',
        codigo: 'AD_CONEXAO_RECUSADA',
      });
      expect(diretorio.aberturas).toBe(3);
    });

    it('credencial recusada não é repetida e não é transitória', async () => {
      const { diretorio, conector } = montar();
      diretorio.falhasAoAbrir.push(diretorio.credencialInvalida());
      const conexao = await conector.testarConexao();
      expect(conexao).toMatchObject({
        disponivel: false,
        codigo: 'AD_CREDENCIAL_INVALIDA',
        modo: 'real',
      });
      expect(diretorio.aberturas).toBe(1);
    });

    it('timeout na escrita é desconhecido; conexão recusada é semEfeito transitório', async () => {
      const { diretorio, conector } = montar();
      diretorio.falhas.set('incluir', new Error('AddRequest: Operation timed out'));
      expect(await conector.provisionar(contexto(paramsAd({ ou: OU })))).toMatchObject({
        efeito: 'desconhecido',
        codigo: 'AD_TEMPO_ESGOTADO',
        etapa: null,
      });

      diretorio.falhasAoAbrir.push(new Error('ECONNREFUSED'));
      expect(
        await conector.provisionar(contexto(paramsAd({ ou: OU, login: 'outra.pessoa' }))),
      ).toMatchObject({
        efeito: 'semEfeito',
        transitorio: true,
        codigo: 'AD_CONEXAO_RECUSADA',
      });
    });

    it('conexão que cai com a escrita em voo é resposta perdida (desconhecido), com retomada na etapa seguinte', async () => {
      const { diretorio, conector } = montar();
      diretorio.falhas.set(
        'alterar',
        new Error(
          'Connection closed before message response was received. Message type: ModifyRequest',
        ),
      );
      const parcial = await conector.provisionar(contexto(paramsAd({ ou: OU })));
      expect(parcial).toMatchObject({
        efeito: 'desconhecido',
        etapa: 'criarContaDesabilitada',
        codigo: 'AD_RESPOSTA_PERDIDA',
      });

      const retomada = await conector.provisionar(
        contexto(paramsAd({ ou: OU }), { etapaInicial: 'definirSenha' }),
      );
      expect(retomada).toMatchObject({ efeito: 'confirmado', etapa: 'adicionarGrupos' });
    });

    it('servidor ocupado é transitório; permissão insuficiente não', () => {
      expect(traduzirErroLdap(new BusyError(), 'operacao')).toMatchObject({
        tipo: 'conexaoRecusada',
        codigo: 'AD_INDISPONIVEL',
      });
      expect(traduzirErroLdap(new InsufficientAccessError(), 'operacao')).toMatchObject({
        tipo: 'recusado',
        codigo: 'AD_PERMISSAO_INSUFICIENTE',
      });
    });

    it('nunca repassa a mensagem da biblioteca, que pode conter filtro ou DN com dados da pessoa', () => {
      const erro = traduzirErroLdap(
        new Error('Invalid expression: (sAMAccountName=maria.souza'),
        'operacao',
      );
      expect(erro).toBeInstanceOf(ErroFornecedor);
      expect(erro.message).not.toContain('maria');
      const tls = Object.assign(new Error('Hostname/IP does not match certificate'), {
        code: 'ERR_TLS_CERT_ALTNAME_INVALID',
      });
      expect(traduzirErroLdap(tls, 'conexao')).toMatchObject({
        tipo: 'recusado',
        codigo: 'AD_TLS_INVALIDO',
      });
    });

    it('conta incompleta ou ambígua no AD não é tratada como encontrada', async () => {
      const { diretorio, cliente } = montar();
      for (const sufixo of ['1', '2']) {
        diretorio.criar(`CN=Duplicada ${sufixo},${OU}`, {
          objectClass: ['person', 'user'],
          sAMAccountName: ['duplicada'],
          userAccountControl: ['512'],
        });
      }
      await expect(cliente.buscarConta('duplicada')).rejects.toMatchObject({
        codigo: 'AD_CONTA_AMBIGUA',
      });
    });
  });

  it('converte o objectGUID binário para o formato textual do AD', () => {
    const bytes = Buffer.from('2bd2d3a1f9ab4c4d9b6e0123456789ab', 'hex');
    expect(guidDe(bytes)).toBe('a1d3d22b-abf9-4d4c-9b6e-0123456789ab');
    expect(guidDe(Buffer.alloc(3))).toBeNull();
    expect(guidDe('texto')).toBeNull();
  });
});
