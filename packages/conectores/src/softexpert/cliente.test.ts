import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { avaliarExistencia } from '@gia/dominio';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { contexto, contextoRevogacao, paramsSoftexpert } from '../teste/fabricas.js';
import { SoftexpertFalso, erroDeRede, fault, resposta } from '../teste/softexpert-falso.js';
import {
  ClienteSoftexpertSoap,
  gerarSenhaSoftexpert,
  type RegistroChamadaSoftexpert,
} from './cliente.js';
import type { ConfiguracaoSoftexpert } from './configuracao.js';
import { criarConectorSoftexpertReal } from './real.js';

const TOKEN = 'eyJ-token-ficticio';
const SENHA_FIXA = 'Senha-Inicial-Fixa-9';
let pasta = '';
let arquivoToken = '';

beforeAll(async () => {
  pasta = await mkdtemp(join(tmpdir(), 'gia-se-'));
  arquivoToken = join(pasta, 'token');
  await writeFile(arquivoToken, `${TOKEN}\n`);
});
afterAll(async () => {
  await rm(pasta, { recursive: true, force: true });
});

function configuracao(extra: Partial<ConfiguracaoSoftexpert> = {}): ConfiguracaoSoftexpert {
  return {
    endpoint: 'https://empresa.softexpert.exemplo/apigateway/se/ws/adm_ws.php',
    autenticacao: { modo: 'token', arquivoToken },
    idioma: null,
    timeoutMs: 2_000,
    tentativasLeitura: 3,
    revogacaoConferida: true,
    ...extra,
  };
}

let se: SoftexpertFalso;
let registros: RegistroChamadaSoftexpert[];
beforeEach(() => {
  se = new SoftexpertFalso();
  registros = [];
});

function cliente(extra: Partial<ConfiguracaoSoftexpert> = {}) {
  return new ClienteSoftexpertSoap(configuracao(extra), {
    fetch: se.fetch,
    gerarSenhaInicial: () => SENHA_FIXA,
    aoRegistrar: (r) => registros.push(r),
    esperaBaseMs: 1,
  });
}

function conector(extra: Partial<ConfiguracaoSoftexpert> = {}) {
  return criarConectorSoftexpertReal(configuracao(extra), {
    fetch: se.fetch,
    gerarSenhaInicial: () => SENHA_FIXA,
    aoRegistrar: (r) => registros.push(r),
    esperaBaseMs: 1,
  });
}

const novo = (extra: Partial<ReturnType<typeof paramsSoftexpert>> = {}) => {
  const { sistema: _s, ...p } = paramsSoftexpert({
    area: 'INFRA',
    funcao: '0104',
    grupoAcesso: 'APOIO',
    ...extra,
  });
  void _s;
  return p;
};

describe('cliente SOAP do SoftExpert (adm_ws pelo API Gateway)', () => {
  it('envia SOAP 1.1 com SOAPAction urn:admin, token cru no Authorization e valores escapados', async () => {
    await cliente().criarUsuario(novo({ nome: 'Maria <Fictícia> & Souza' }));
    const [consulta, criacao] = se.requisicoes;
    expect(consulta).toMatchObject({
      operacao: 'getUserData',
      soapAction: 'urn:admin#getUserData',
      autorizacao: TOKEN,
      contentType: 'text/xml;charset=UTF-8',
      campos: { iduser: 'M1001' },
    });
    expect(criacao!.operacao).toBe('newUser');
    expect(Object.keys(criacao!.campos)).toEqual([
      'IDUSER',
      'NAME',
      'LOGIN',
      'PASS',
      'EMAIL',
      'IDAREA',
      'IDFUNC',
      'IDACCGROUP',
    ]);
    expect(criacao!.campos).toMatchObject({ NAME: 'Maria <Fictícia> & Souza', PASS: SENHA_FIXA });
    expect(criacao!.corpo).toContain('Maria &lt;Fictícia&gt; &amp; Souza');
  });

  it('LANGUAGE só vai quando configurado (valor desconhecido derruba o newUser com "Idioma inexistente")', async () => {
    await cliente().criarUsuario(novo());
    expect(se.requisicoes.at(-1)!.campos).not.toHaveProperty('LANGUAGE');
    await expect(
      cliente({ idioma: 'klingon' }).criarUsuario(novo({ identificador: 'M2' })),
    ).rejects.toMatchObject({
      tipo: 'recusado',
      codigo: 'SOFTEXPERT_IDIOMA_INEXISTENTE',
    });
  });

  it('lê o getUserData no formato real; "Usuário inexistente" é null, outra FAILURE é erro', async () => {
    se.usuarios.set('173', {
      iduser: '173',
      login: 'pessoa.ficticia',
      nome: 'Pessoa',
      email: 'p@exemplo.com.br',
      area: 'INFRA',
      funcao: '0104',
      grupo: 'APOIO',
      ativo: true,
    });
    expect(await cliente().buscarUsuario('173')).toEqual({
      identificador: '173',
      login: 'pessoa.ficticia',
      ativo: null,
      area: 'INFRA',
      funcao: '0104',
      grupoAcesso: null,
    });
    expect(await cliente().buscarUsuario('999')).toBeNull();

    se.programar(
      'getUserData',
      resposta(
        'getUserData',
        '<Status>FAILURE</Status><Detail>Sem permissão</Detail><Code>7</Code>',
      ),
    );
    // FAILURE que não é "inexistente" não pode virar "livre" — senão a validação mentiria.
    await expect(cliente({ tentativasLeitura: 1 }).buscarUsuario('173')).rejects.toMatchObject({
      tipo: 'recusado',
      codigo: 'SOFTEXPERT_RECUSADO_7',
    });
  });

  it('decodifica resposta em ISO-8859-1 sem perder o campo "Usuário"', async () => {
    const xml =
      '<?xml version="1.0" encoding="ISO-8859-1"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">' +
      '<SOAP-ENV:Body><getUserDataResponse><data><item><Usuário>55</Usuário><Login>joão</Login>' +
      '<department><item><iddepartment>TEC</iddepartment></item></department><position><item><idposition>1</idposition></item></position>' +
      '</item></data><Status>SUCCESS</Status></getUserDataResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>';
    se.programar(
      'getUserData',
      new Response(Buffer.from(xml, 'latin1'), {
        headers: { 'content-type': 'text/xml; charset=ISO-8859-1' },
      }),
    );
    expect(await cliente().buscarUsuario('55')).toMatchObject({
      identificador: '55',
      login: 'joão',
    });
  });

  describe('idempotência', () => {
    it('recriar o usuário que a tentativa anterior criou devolve a mesma chave sem novo newUser', async () => {
      const c = cliente();
      expect(await c.criarUsuario(novo())).toBe('M1001');
      expect(await c.criarUsuario(novo())).toBe('M1001');
      expect(se.requisicoes.filter((r) => r.operacao === 'newUser')).toHaveLength(1);
    });

    it('newUser recusado porque outra tentativa já criou: confere e devolve sucesso', async () => {
      se.programar(
        'getUserData',
        resposta('getUserData', '<Status>FAILURE</Status><Detail>Usuário inexistente</Detail>'),
      );
      se.usuarios.set('M1001', {
        iduser: 'M1001',
        login: 'maria.souza',
        nome: 'Maria',
        email: 'm@exemplo.com.br',
        area: 'INFRA',
        funcao: '0104',
        grupo: 'APOIO',
        ativo: true,
      });
      expect(await cliente().criarUsuario(novo())).toBe('M1001');
    });

    it('matrícula com outro login ou outro cadastro é recusada', async () => {
      await cliente().criarUsuario(novo());
      await expect(cliente().criarUsuario(novo({ login: 'outra.pessoa' }))).rejects.toMatchObject({
        codigo: 'IDENTIFICADOR_EM_USO',
      });
      await expect(cliente().criarUsuario(novo({ funcao: '0200' }))).rejects.toMatchObject({
        codigo: 'USUARIO_JA_EXISTE',
      });
    });
  });

  describe('respostas, timeout e retentativa', () => {
    it('401 é credencial recusada e não é repetido', async () => {
      se.programar('getUserData', new Response('Valid GatewayJWT not found', { status: 401 }));
      await expect(cliente().buscarUsuario('1')).rejects.toMatchObject({
        tipo: 'recusado',
        codigo: 'SOFTEXPERT_AUTENTICACAO',
      });
      expect(se.requisicoes).toHaveLength(1);
    });

    it('403 com limite esgotado é limite de taxa; 403 comum é acesso negado', async () => {
      se.programar(
        'getUserData',
        new Response('', {
          status: 403,
          headers: { 'x-rate-limit-remaining': '0', 'retry-after': '1' },
        }),
      );
      await expect(cliente({ tentativasLeitura: 1 }).buscarUsuario('1')).rejects.toMatchObject({
        tipo: 'limiteDeTaxa',
        tentarAposMs: 1000,
      });
      se.programar('getUserData', new Response('', { status: 403 }));
      await expect(cliente({ tentativasLeitura: 1 }).buscarUsuario('1')).rejects.toMatchObject({
        tipo: 'recusado',
        codigo: 'SOFTEXPERT_ACESSO_NEGADO',
      });
    });

    it('leitura repete em 429/503/rede e acaba respondendo', async () => {
      se.programar(
        'getUserData',
        new Response('', { status: 429, headers: { 'retry-after': '0' } }),
        erroDeRede('ECONNREFUSED'),
      );
      expect(await cliente({ tentativasLeitura: 3 }).buscarUsuario('1')).toBeNull();
      expect(se.requisicoes).toHaveLength(3);
      expect(registros.at(-1)).toMatchObject({ operacao: 'getUserData', tentativas: 3 });

      se.programar(
        'getUserData',
        new Response('', { status: 503 }),
        new Response('', { status: 503 }),
      );
      await expect(cliente({ tentativasLeitura: 2 }).buscarUsuario('1')).rejects.toMatchObject({
        codigo: 'SOFTEXPERT_HTTP_503',
      });
    });

    it('escrita nunca é repetida: 503 no newUser é resposta perdida (desconhecido)', async () => {
      se.programar('newUser', new Response('', { status: 503 }));
      await expect(cliente().criarUsuario(novo())).rejects.toMatchObject({
        tipo: 'respostaPerdida',
        codigo: 'SOFTEXPERT_HTTP_503',
      });
      expect(se.requisicoes.filter((r) => r.operacao === 'newUser')).toHaveLength(1);
    });

    it('SOAP Fault (em 500 ou 2xx) é recusa e não repassa o texto do fornecedor', async () => {
      for (const status of [500, 200]) {
        se.programar('newUser', fault(status));
        const erro = await cliente()
          .criarUsuario(novo({ identificador: `F${status}` }))
          .catch((e: unknown) => e);
        expect(erro).toMatchObject({ tipo: 'recusado', codigo: 'SOFTEXPERT_SOAP_FAULT' });
        expect((erro as Error).message).not.toContain('maria');
      }
    });

    it('página HTML no lugar do SOAP: leitura é recusa; escrita é resposta perdida', async () => {
      const html = () => new Response('<html><body>login</body></html>', { status: 200 });
      se.programar('getUserData', html());
      await expect(cliente({ tentativasLeitura: 1 }).buscarUsuario('1')).rejects.toMatchObject({
        tipo: 'recusado',
        codigo: 'SOFTEXPERT_RESPOSTA_INVALIDA',
      });
      se.programar('newUser', html());
      await expect(cliente().criarUsuario(novo())).rejects.toMatchObject({
        tipo: 'respostaPerdida',
        codigo: 'SOFTEXPERT_RESPOSTA_INVALIDA',
      });
    });

    it('newUser que não responde no prazo é timeout (desconhecido)', async () => {
      se.programar('newUser', 'pendurar');
      await expect(cliente({ timeoutMs: 150 }).criarUsuario(novo())).rejects.toMatchObject({
        tipo: 'timeout',
        codigo: 'SOFTEXPERT_TEMPO_ESGOTADO',
      });
    });

    it('falha na consulta ANTES do newUser não é incerteza: nada foi gravado', async () => {
      se.programar(
        'getUserData',
        erroDeRede('ECONNRESET'),
        erroDeRede('ECONNRESET'),
        erroDeRede('ECONNRESET'),
      );
      await expect(cliente().criarUsuario(novo())).rejects.toMatchObject({
        tipo: 'conexaoRecusada',
      });
      expect(se.requisicoes.some((r) => r.operacao === 'newUser')).toBe(false);
    });

    it('segredo ausente no cofre é erro de configuração, sem chamar o SE e sem virar incerteza', async () => {
      const semToken = cliente({
        autenticacao: { modo: 'token', arquivoToken: join(pasta, 'nao-existe') },
      });
      await expect(semToken.criarUsuario(novo())).rejects.toMatchObject({
        tipo: 'recusado',
        codigo: 'SOFTEXPERT_CONFIGURACAO',
        message: expect.stringContaining('GIA_SOFTEXPERT_TOKEN_ARQUIVO'),
      });
      expect(se.requisicoes).toHaveLength(0);
    });

    it('certificado inválido não é repetido e tem código próprio', async () => {
      se.programar('getUserData', erroDeRede('ERR_TLS_CERT_ALTNAME_INVALID'));
      await expect(cliente().buscarUsuario('1')).rejects.toMatchObject({
        codigo: 'SOFTEXPERT_TLS_INVALIDO',
      });
      expect(se.requisicoes).toHaveLength(1);
    });
  });

  describe('inativação', () => {
    it('enquanto o disableUser não for conferido no WSDL, recusa sem chamar o SE', async () => {
      await expect(
        cliente({ revogacaoConferida: false }).inativarUsuario('M1001'),
      ).rejects.toMatchObject({
        codigo: 'SOFTEXPERT_REVOGACAO_NAO_CONFERIDA',
      });
      expect(se.requisicoes).toHaveLength(0);
    });

    it('conferido: chama disableUser com IDUSER; ausente é CONTA_AUSENTE', async () => {
      await cliente().criarUsuario(novo());
      await cliente().inativarUsuario('M1001');
      expect(se.requisicoes.at(-1)).toMatchObject({
        operacao: 'disableUser',
        campos: { IDUSER: 'M1001' },
      });
      expect(se.usuarios.get('M1001')!.ativo).toBe(false);
      await expect(cliente().inativarUsuario('X9')).rejects.toMatchObject({
        codigo: 'CONTA_AUSENTE',
      });
    });
  });

  it('o registro de auditoria não leva identificador, login, senha nem token', async () => {
    await cliente().criarUsuario(novo());
    const texto = JSON.stringify(registros);
    for (const sensivel of [SENHA_FIXA, TOKEN, 'M1001', 'maria'])
      expect(texto).not.toContain(sensivel);
    expect(registros.map((r) => [r.operacao, r.desfecho])).toEqual([
      ['getUserData', 'falhaNoCadastro'],
      ['newUser', 'ok'],
    ]);
  });

  it('senha inicial gerada é forte e única', () => {
    const senhas = new Set(Array.from({ length: 50 }, gerarSenhaSoftexpert));
    expect(senhas.size).toBe(50);
    for (const s of senhas)
      expect(s).toMatch(/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[!#%*+\-=?@_]).{20}$/);
  });
});

describe('conector SoftExpert em modo real (motor + cliente SOAP)', () => {
  const p = () => paramsSoftexpert({ area: 'INFRA', funcao: '0104', grupoAcesso: 'APOIO' });

  it('testar conexão consulta um IDUSER inexistente', async () => {
    expect(await conector().testarConexao()).toMatchObject({
      modo: 'real',
      disponivel: true,
      codigo: 'OK',
    });
  });

  it('validar não afirma o que a API não confere: cadastros viram aviso, não impedimento', async () => {
    const validacao = await conector().validar(contexto(p()));
    expect(validacao.impedimentos).toEqual([]);
    expect(validacao.avisos.map((a) => a.codigo)).toEqual([
      'CADASTRO_NAO_VERIFICAVEL',
      'CADASTRO_NAO_VERIFICAVEL',
      'CADASTRO_NAO_VERIFICAVEL',
    ]);
  });

  it('provisiona em modo real; a existência não comprova o grupo (getUserData não o devolve)', async () => {
    const c = conector();
    expect(await c.provisionar(contexto(p()))).toMatchObject({
      efeito: 'confirmado',
      modo: 'real',
      etapa: 'criarUsuario',
      referenciaExterna: 'M1001',
    });
    const existencia = await c.conferirExistencia(contexto(p()));
    expect(existencia).toMatchObject({
      contaExiste: true,
      etapaComprovada: null,
      referenciaExterna: 'M1001',
    });
    expect(avaliarExistencia(existencia, p()).situacao).toBe('incompleto');
    expect((await c.validar(contexto(p()))).impedimentos.map((i) => i.codigo)).toEqual([
      'USUARIO_JA_EXISTE',
    ]);
  });

  it('newUser sem resposta vira resultado desconhecido (regra 3)', async () => {
    se.programar('newUser', 'pendurar');
    expect(await conector({ timeoutMs: 150 }).provisionar(contexto(p()))).toMatchObject({
      efeito: 'desconhecido',
      codigo: 'SOFTEXPERT_TEMPO_ESGOTADO',
    });
  });

  it('revogação não conferida não toca o SE e não é confirmada', async () => {
    await conector().provisionar(contexto(p()));
    const antes = se.requisicoes.length;
    expect(
      await conector({ revogacaoConferida: false }).revogar(contextoRevogacao(p())),
    ).toMatchObject({
      efeito: 'semEfeito',
      codigo: 'SOFTEXPERT_REVOGACAO_NAO_CONFERIDA',
    });
    expect(se.requisicoes.slice(antes).map((r) => r.operacao)).toEqual(['getUserData']);
  });
});
