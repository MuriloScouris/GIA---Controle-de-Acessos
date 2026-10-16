import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { checkServerIdentity } from 'node:tls';
import { Client } from 'ldapts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpfFicticio, contexto, contextoRevogacao, paramsAd } from '../teste/fabricas.js';
import { criarClienteAdLdap, criarConectorAdReal } from './ad-real.js';
import { carregarConfiguracaoAd, type ConfiguracaoAd } from './configuracao-ad.js';

/**
 * Integração com um Active Directory de verdade (Samba AD DC), por LDAPS com
 * o certificado verificado. Roda quando `GIA_AD_TESTE_*` está definido — no CI
 * sempre (ver `.github/workflows/ci.yml`); localmente, ver o README do pacote.
 * Cada execução trabalha numa OU própria e a apaga no fim.
 */
const ENV = {
  url: process.env['GIA_AD_TESTE_URL'],
  bindDn: process.env['GIA_AD_TESTE_BIND_DN'],
  arquivoSenha: process.env['GIA_AD_TESTE_SENHA_ARQUIVO'],
  baseDn: process.env['GIA_AD_TESTE_BASE_DN'],
  arquivoCa: process.env['GIA_AD_TESTE_CA_ARQUIVO'],
  nomeTls: process.env['GIA_AD_TESTE_TLS_NOME_SERVIDOR'],
};
const TEM_AD = Object.values(ENV).every((v) => v !== undefined && v !== '');
const TEMPO_MS = 60_000;

describe('AD: integração no CI', () => {
  it('no CI os testes contra o AD rodam de verdade (GIA_AD_TESTE_* definidas)', () => {
    if (process.env['CI']) expect(TEM_AD).toBe(true);
  });
});

describe.skipIf(!TEM_AD)('AD real (Samba AD DC por LDAPS)', { timeout: TEMPO_MS }, () => {
  const sufixo = randomBytes(4).toString('hex');
  const ouTeste = `OU=GIA-Teste-${sufixo},${ENV.baseDn}`;
  const ouPessoas = `OU=Pessoas,${ouTeste}`;
  const ouInativos = `OU=Inativos,${ouTeste}`;
  const grupos = [`GG-Tecnologia-${sufixo}`, `GG-VPN-${sufixo}`];
  let config: ConfiguracaoAd;
  let admin: Client;

  const env = (extra: Record<string, string> = {}) => ({
    GIA_AD_URL: ENV.url,
    GIA_AD_BIND_DN: ENV.bindDn,
    GIA_AD_SENHA_ARQUIVO: ENV.arquivoSenha,
    GIA_AD_CA_ARQUIVO: ENV.arquivoCa,
    GIA_AD_TLS_NOME_SERVIDOR: ENV.nomeTls,
    // A base gerenciada é a OU da execução: o teste não toca o resto do diretório.
    GIA_AD_BASE_DN: ouTeste,
    GIA_AD_OU_INATIVOS: ouInativos,
    ...extra,
  });
  const pessoa = (login: string, cpf: string) =>
    paramsAd({
      login,
      upn: `${login}@gia.teste.local`,
      email: `${login}@gia.teste.local`,
      proxyAddresses: [`SMTP:${login}@gia.teste.local`],
      nomeExibicao: `Pessoa ${login}`,
      ou: ouPessoas,
      grupos,
      cpf,
    });

  beforeAll(async () => {
    config = carregarConfiguracaoAd(env());
    admin = new Client({
      url: ENV.url!,
      tlsOptions: {
        ca: [await readFile(ENV.arquivoCa!)],
        servername: ENV.nomeTls!,
        checkServerIdentity: (_host, certificado) => checkServerIdentity(ENV.nomeTls!, certificado),
      },
    });
    await admin.bind(ENV.bindDn!, (await readFile(ENV.arquivoSenha!, 'utf8')).trim());
    for (const ou of [ouTeste, ouPessoas, ouInativos]) {
      await admin.add(ou, { objectClass: ['top', 'organizationalUnit'] });
    }
    for (const grupo of grupos) {
      await admin.add(`CN=${grupo},${ouTeste}`, {
        objectClass: ['top', 'group'],
        sAMAccountName: grupo,
      });
    }
  });

  afterAll(async () => {
    if (admin === undefined) return;
    const { searchEntries } = await admin.search(ouTeste, { scope: 'sub', attributes: ['dn'] });
    // Folhas primeiro: o DN mais longo é sempre filho de um mais curto.
    for (const { dn } of searchEntries.sort((a, b) => b.dn.length - a.dn.length)) {
      await admin.del(dn).catch(() => undefined);
    }
    await admin.unbind();
  });

  async function lerConta(login: string) {
    const { searchEntries } = await admin.search(ouTeste, {
      scope: 'sub',
      filter: `(sAMAccountName=${login})`,
      attributes: ['userAccountControl', 'pwdLastSet', 'employeeID', 'memberOf', 'mail'],
    });
    return searchEntries[0];
  }

  it('autentica a conta de serviço por LDAPS com o certificado verificado', async () => {
    const conector = await criarConectorAdReal(config);
    expect(await conector.testarConexao()).toEqual({
      modo: 'real',
      disponivel: true,
      codigo: 'OK',
      mensagem: 'Conexão estabelecida.',
    });
  });

  it('valida, provisiona nas quatro etapas e confere a existência no AD', async () => {
    const conector = await criarConectorAdReal(config);
    const p = pessoa(`ana.${sufixo}`, cpfFicticio('400000004'));
    expect(await conector.validar(contexto(p))).toEqual({
      modo: 'real',
      impedimentos: [],
      avisos: [],
    });

    const resultado = await conector.provisionar(contexto(p));
    expect(resultado).toMatchObject({
      efeito: 'confirmado',
      modo: 'real',
      etapa: 'adicionarGrupos',
    });
    expect(resultado.referenciaExterna).toMatch(/^[0-9a-f-]{36}$/);

    const conta = await lerConta(p.login);
    expect(Number(conta!['userAccountControl']) & 0x2).toBe(0);
    expect(conta!['pwdLastSet']).toBe('0');
    expect(conta!['employeeID']).toBe(p.cpf);
    expect(conta!['memberOf']).toHaveLength(2);

    const existencia = await conector.conferirExistencia(contexto(p));
    expect(existencia).toMatchObject({
      contaExiste: true,
      etapaComprovada: 'adicionarGrupos',
      referenciaExterna: resultado.referenciaExterna,
    });
    expect([...existencia.acessosEncontrados].sort()).toEqual(
      grupos.map((g) => `grupo:${g}`).sort(),
    );

    // Login já em uso pela mesma pessoa é aviso; por outra, impedimento.
    expect((await conector.validar(contexto(p))).avisos.map((a) => a.codigo)).toEqual([
      'CONTA_JA_EXISTE_DO_MESMO_TITULAR',
    ]);
    const outra = { ...p, cpf: cpfFicticio('500000005') };
    expect((await conector.validar(contexto(outra))).impedimentos.map((i) => i.codigo)).toContain(
      'LOGIN_EM_USO',
    );
  });

  it('criar de novo a conta que já foi criada (resposta perdida) devolve o mesmo objectGUID', async () => {
    const cliente = await criarClienteAdLdap(config);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { sistema: _s, ...p } = pessoa(`bia.${sufixo}`, cpfFicticio('600000006'));
    const nova = { ...p, dn: `CN=${p.nomeExibicao},${p.ou}` };
    const primeiro = await cliente.criarContaDesabilitada(nova);
    expect(await cliente.criarContaDesabilitada(nova)).toBe(primeiro);
    await cliente.definirSenhaInicial(p.login);
    await cliente.habilitarConta(p.login);
    for (const grupo of grupos) {
      await cliente.adicionarAoGrupo(p.login, grupo);
      await cliente.adicionarAoGrupo(p.login, grupo);
    }
    expect((await lerConta(p.login))!['memberOf']).toHaveLength(2);
  });

  it('revoga desabilitando e movendo para a OU de inativos; repetir é JA_REVOGADO', async () => {
    const conector = await criarConectorAdReal(config);
    const p = pessoa(`caio.${sufixo}`, cpfFicticio('700000007'));
    await conector.provisionar(contexto(p));
    expect(await conector.revogar(contextoRevogacao(p))).toMatchObject({
      efeito: 'confirmado',
      etapa: 'moverParaOuInativos',
    });
    const { searchEntries } = await admin.search(ouInativos, {
      scope: 'one',
      filter: `(sAMAccountName=${p.login})`,
      attributes: ['userAccountControl'],
    });
    expect(Number(searchEntries[0]!['userAccountControl']) & 0x2).toBe(2);
    expect(await conector.revogar(contextoRevogacao(p))).toMatchObject({ codigo: 'JA_REVOGADO' });
  });

  it('busca com metacaracteres de filtro não encontra ninguém', async () => {
    const cliente = await criarClienteAdLdap(config);
    expect(await cliente.buscarConta('*')).toBeNull();
    expect(await cliente.buscarConta(`ana.${sufixo})(sAMAccountName=*`)).toBeNull();
  });

  it('passa ao DC seguinte quando o primeiro não conecta', async () => {
    const failover = carregarConfiguracaoAd(env({ GIA_AD_URL: `ldaps://127.0.0.1:1,${ENV.url}` }));
    expect(await (await criarConectorAdReal(failover)).testarConexao()).toMatchObject({
      disponivel: true,
    });
  });

  it('certificado de outro nome ou sem o CA é recusado, nunca aceito', async () => {
    for (const extra of [
      { GIA_AD_TLS_NOME_SERVIDOR: 'outro.gia.teste.local' },
      { GIA_AD_CA_ARQUIVO: '' },
    ]) {
      const conector = await criarConectorAdReal(carregarConfiguracaoAd(env(extra)));
      expect(await conector.testarConexao()).toMatchObject({
        disponivel: false,
        codigo: 'AD_TLS_INVALIDO',
      });
    }
  });

  it('senha errada da conta de serviço é recusada sem expor o valor', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const pasta = await mkdtemp(join(tmpdir(), 'gia-ad-'));
    try {
      const arquivo = join(pasta, 'senha');
      await writeFile(arquivo, 'senha-errada-de-teste');
      const conector = await criarConectorAdReal(
        carregarConfiguracaoAd(env({ GIA_AD_SENHA_ARQUIVO: arquivo })),
      );
      const conexao = await conector.testarConexao();
      expect(conexao).toMatchObject({ disponivel: false, codigo: 'AD_CREDENCIAL_INVALIDA' });
      expect(JSON.stringify(conexao)).not.toContain('senha-errada');
    } finally {
      await rm(pasta, { recursive: true, force: true });
    }
  });
});
