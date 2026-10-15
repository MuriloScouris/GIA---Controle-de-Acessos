import { randomInt } from 'node:crypto';
import { normalizarAcesso } from '@gia/dominio';
import type { ClienteAd, ContaAd, NovaContaAd } from '../adaptadores/ad.js';
import { ErroFornecedor } from '../erros.js';
import { escaparValorFiltroLdap } from '../escape.js';
import {
  RESULTADO_LDAP,
  codigoLdap,
  traduzirErroLdap,
  type AbrirSessaoLdap,
  type EntradaLdap,
  type MudancaLdap,
  type SessaoLdap,
} from './ldap.js';

/** userAccountControl (MS-ADTS 2.2.16). */
const UAC_DESABILITADA = 0x2;
const UAC_CONTA_NORMAL = 0x200;

const ATRIBUTOS_CONTA = [
  'objectGUID',
  'sAMAccountName',
  'mail',
  'userAccountControl',
  'memberOf',
] as const;

/** Registro de cada chamada ao AD, para observabilidade. Sem login, DN, e-mail, CPF ou senha. */
export interface RegistroChamadaAd {
  readonly operacao: keyof ClienteAd;
  readonly desfecho: 'ok' | ErroFornecedor['tipo'];
  readonly codigo: string;
  readonly duracaoMs: number;
  readonly tentativas: number;
}

export interface OpcoesClienteAdLdap {
  readonly abrirSessao: AbrirSessaoLdap;
  readonly baseDn: string;
  /** Atributo do AD onde o CPF é gravado e conferido. */
  readonly atributoCpf: string;
  /** Tentativas de leitura quando nenhum DC aceita a conexão (nada foi enviado). */
  readonly tentativasLeitura?: number;
  /** Espera entre tentativas de leitura. */
  readonly esperaEntreTentativasMs?: number;
  /**
   * Senha inicial da conta nova. Padrão: aleatória e forte, nunca devolvida,
   * guardada ou registrada — vale só como bloqueio até a troca no primeiro
   * acesso (`pwdLastSet = 0`).
   */
  readonly gerarSenhaInicial?: () => string;
  readonly aoRegistrar?: (registro: RegistroChamadaAd) => void;
  readonly relogio?: () => number;
}

/**
 * Transporte LDAPS do Active Directory. Cada chamada abre uma sessão
 * autenticada, executa e encerra; escritas nunca são repetidas aqui (regra 3:
 * escrita incerta vai para conferência). Toda entrada humana é escapada
 * (filtros RFC 4515, DN RFC 4514) e toda falha sai como `ErroFornecedor`.
 */
export class ClienteAdLdap implements ClienteAd {
  private readonly tentativasLeitura: number;
  private readonly esperaMs: number;
  private readonly gerarSenha: () => string;
  private readonly relogio: () => number;
  private readonly atributoCpf: string;

  constructor(private readonly opcoes: OpcoesClienteAdLdap) {
    this.tentativasLeitura = opcoes.tentativasLeitura ?? 2;
    this.esperaMs = opcoes.esperaEntreTentativasMs ?? 250;
    this.gerarSenha = opcoes.gerarSenhaInicial ?? gerarSenhaForte;
    this.relogio = opcoes.relogio ?? Date.now;
    this.atributoCpf = opcoes.atributoCpf.toLowerCase();
  }

  testar(): Promise<void> {
    return this.ler('testar', async (s) => {
      await s.buscar({
        base: this.opcoes.baseDn,
        escopo: 'base',
        filtro: '(objectClass=*)',
        atributos: ['distinguishedName'],
      });
    });
  }

  buscarConta(login: string): Promise<ContaAd | null> {
    return this.ler('buscarConta', (s) => this.contaPorLogin(s, login));
  }

  buscarContaPorEmail(email: string): Promise<ContaAd | null> {
    return this.ler('buscarContaPorEmail', async (s) => {
      const valor = escaparValorFiltroLdap(email);
      const filtro = `(&(objectCategory=person)(objectClass=user)(|(mail=${valor})(proxyAddresses=smtp:${valor})))`;
      return this.contaUnica(s, filtro);
    });
  }

  ouExiste(ou: string): Promise<boolean> {
    return this.ler('ouExiste', async (s) => {
      // Fora da base gerenciada o GIA não cria nada, mesmo que a OU exista.
      if (!dentroDe(ou, this.opcoes.baseDn)) return false;
      try {
        const achadas = await s.buscar({
          base: ou,
          escopo: 'base',
          filtro: '(objectClass=organizationalUnit)',
          atributos: ['distinguishedName'],
        });
        return achadas.length === 1;
      } catch (erro) {
        if (codigoLdap(erro) === RESULTADO_LDAP.objetoInexistente) return false;
        throw erro;
      }
    });
  }

  grupoExiste(grupo: string): Promise<boolean> {
    return this.ler('grupoExiste', async (s) => (await this.dnDoGrupo(s, grupo)) !== null);
  }

  criarContaDesabilitada(nova: NovaContaAd): Promise<string> {
    return this.escrever('criarContaDesabilitada', async (s) => {
      if (!dentroDe(nova.ou, this.opcoes.baseDn)) {
        throw new ErroFornecedor(
          'recusado',
          'AD_OU_FORA_DA_BASE',
          'A OU de destino está fora da base gerenciada pelo GIA.',
        );
      }
      const atributos: Record<string, readonly string[]> = {
        objectClass: ['top', 'person', 'organizationalPerson', 'user'],
        sAMAccountName: [nova.login],
        userPrincipalName: [nova.upn],
        mail: [nova.email],
        givenName: [nova.nome],
        sn: [nova.sobrenome],
        displayName: [nova.nomeExibicao],
        title: [nova.cargo],
        department: [nova.departamento],
        company: [nova.empresa],
        [this.opcoes.atributoCpf]: [nova.cpf],
        // Nasce desabilitada, qualquer que seja o controle pedido; habilitar é outra etapa.
        userAccountControl: [String((nova.controleConta ?? UAC_CONTA_NORMAL) | UAC_DESABILITADA)],
      };
      if (nova.proxyAddresses.length > 0) atributos['proxyAddresses'] = [...nova.proxyAddresses];
      if (nova.escritorio !== null) atributos['physicalDeliveryOfficeName'] = [nova.escritorio];
      if (nova.scriptLogon !== null) atributos['scriptPath'] = [nova.scriptLogon];
      if (nova.gerente !== null) {
        const gerente = await this.dnDoGerente(s, nova.gerente);
        if (gerente !== null) atributos['manager'] = [gerente];
      }
      try {
        await s.incluir(nova.dn, atributos);
      } catch (erro) {
        const codigo = codigoLdap(erro);
        if (codigo !== RESULTADO_LDAP.jaExiste && codigo !== RESULTADO_LDAP.restricaoViolada) {
          throw erro;
        }
        // Idempotência: a tentativa anterior pode ter criado a conta e perdido a resposta.
        const existente = await this.contaPorLogin(s, nova.login);
        if (existente !== null && existente.cpf === nova.cpf && !existente.habilitada) {
          return existente.guid;
        }
        throw existente === null
          ? new ErroFornecedor(
              'recusado',
              'AD_NOME_EM_USO',
              'Já existe outro objeto com este nome na OU; ajuste o nome de exibição.',
            )
          : new ErroFornecedor('recusado', 'LOGIN_EM_USO', 'O login já existe no AD.');
      }
      const criada = await this.contaPorLogin(s, nova.login);
      if (criada === null) {
        throw new ErroFornecedor('respostaPerdida', 'AD_CONTA_NAO_RELIDA');
      }
      return criada.guid;
    });
  }

  definirSenhaInicial(login: string): Promise<void> {
    return this.escrever('definirSenhaInicial', async (s) => {
      const conta = await this.exigirConta(s, login);
      const senha = this.gerarSenha();
      await s.alterar(conta.dn, [
        // MS-ADTS 3.1.1.3.1.5: o valor vai entre aspas, em UTF-16LE, só sobre LDAPS.
        {
          operacao: 'replace',
          atributo: 'unicodePwd',
          valores: [Buffer.from(`"${senha}"`, 'utf16le')],
        },
        // Troca obrigatória no primeiro acesso.
        { operacao: 'replace', atributo: 'pwdLastSet', valores: ['0'] },
      ]);
    });
  }

  habilitarConta(login: string): Promise<void> {
    return this.escrever('habilitarConta', async (s) => {
      const conta = await this.exigirConta(s, login);
      if ((conta.uac & UAC_DESABILITADA) === 0) return;
      await s.alterar(conta.dn, [uac(conta.uac & ~UAC_DESABILITADA)]);
    });
  }

  adicionarAoGrupo(login: string, grupo: string): Promise<void> {
    return this.escrever('adicionarAoGrupo', async (s) => {
      const conta = await this.exigirConta(s, login);
      const dnGrupo = await this.dnDoGrupo(s, grupo);
      if (dnGrupo === null) {
        throw new ErroFornecedor('recusado', 'GRUPO_INEXISTENTE', 'O grupo não existe no AD.');
      }
      if (conta.memberOf.some((dn) => mesmoDn(dn, dnGrupo))) return;
      try {
        await s.alterar(dnGrupo, [{ operacao: 'add', atributo: 'member', valores: [conta.dn] }]);
      } catch (erro) {
        // Já é membro: adicionar de novo é sucesso (idempotente).
        const codigo = codigoLdap(erro);
        if (codigo === RESULTADO_LDAP.jaExiste || codigo === RESULTADO_LDAP.valorJaExiste) return;
        throw erro;
      }
    });
  }

  desabilitarConta(login: string): Promise<void> {
    return this.escrever('desabilitarConta', async (s) => {
      const conta = await this.exigirConta(s, login);
      if ((conta.uac & UAC_DESABILITADA) !== 0) return;
      await s.alterar(conta.dn, [uac(conta.uac | UAC_DESABILITADA)]);
    });
  }

  moverParaOu(login: string, ou: string): Promise<void> {
    return this.escrever('moverParaOu', async (s) => {
      const conta = await this.exigirConta(s, login);
      if (mesmoDn(paiDe(conta.dn), ou)) return;
      if (!dentroDe(ou, this.opcoes.baseDn)) {
        throw new ErroFornecedor(
          'recusado',
          'AD_OU_FORA_DA_BASE',
          'A OU de destino está fora da base gerenciada pelo GIA.',
        );
      }
      await s.renomear(conta.dn, `${primeiroRdn(conta.dn)},${ou}`);
    });
  }

  // -------------------------------------------------------------------------

  private async contaPorLogin(s: SessaoLdap, login: string): Promise<ContaInterna | null> {
    const filtro = `(&(objectCategory=person)(objectClass=user)(sAMAccountName=${escaparValorFiltroLdap(login)}))`;
    return this.contaUnica(s, filtro);
  }

  private async contaUnica(s: SessaoLdap, filtro: string): Promise<ContaInterna | null> {
    const achadas = await s.buscar({
      base: this.opcoes.baseDn,
      escopo: 'sub',
      filtro,
      atributos: [...ATRIBUTOS_CONTA, this.opcoes.atributoCpf],
      binarios: ['objectGUID'],
      limite: 2,
    });
    if (achadas.length === 0) return null;
    if (achadas.length > 1) {
      throw new ErroFornecedor(
        'recusado',
        'AD_CONTA_AMBIGUA',
        'Mais de uma conta no AD corresponde à busca; confira no diretório.',
      );
    }
    return this.contaDe(achadas[0]!);
  }

  private async exigirConta(s: SessaoLdap, login: string): Promise<ContaInterna> {
    const conta = await this.contaPorLogin(s, login);
    if (conta === null) {
      throw new ErroFornecedor('recusado', 'CONTA_AUSENTE', 'A conta não existe no AD.');
    }
    return conta;
  }

  private async dnDoGrupo(s: SessaoLdap, grupo: string): Promise<string | null> {
    const valor = escaparValorFiltroLdap(grupo);
    const achados = await s.buscar({
      base: this.opcoes.baseDn,
      escopo: 'sub',
      filtro: `(&(objectClass=group)(|(cn=${valor})(sAMAccountName=${valor})))`,
      atributos: ['distinguishedName'],
      limite: 2,
    });
    if (achados.length > 1) {
      throw new ErroFornecedor(
        'recusado',
        'AD_GRUPO_AMBIGUO',
        'Mais de um grupo no AD tem este nome; confira no diretório.',
      );
    }
    return achados[0]?.dn ?? null;
  }

  /** Gerente informado por login ou por DN; se não for encontrado, a conta é criada sem ele. */
  private async dnDoGerente(s: SessaoLdap, gerente: string): Promise<string | null> {
    if (!/^CN=/i.test(gerente)) return (await this.contaPorLogin(s, gerente))?.dn ?? null;
    if (!dentroDe(gerente, this.opcoes.baseDn)) return null;
    try {
      const achados = await s.buscar({
        base: gerente,
        escopo: 'base',
        filtro: '(objectClass=user)',
        atributos: ['distinguishedName'],
      });
      return achados[0]?.dn ?? null;
    } catch (erro) {
      if (codigoLdap(erro) === RESULTADO_LDAP.objetoInexistente) return null;
      throw erro;
    }
  }

  private contaDe(entrada: EntradaLdap): ContaInterna {
    const a = entrada.atributos;
    const guid = guidDe(a['objectguid']?.[0]);
    const uacBruto = Number(primeiroTexto(a['useraccountcontrol']) ?? NaN);
    if (guid === null || !Number.isInteger(uacBruto)) {
      throw new ErroFornecedor(
        'recusado',
        'RESPOSTA_INVALIDA',
        'O AD devolveu uma conta incompleta.',
      );
    }
    const memberOf = textos(a['memberof']);
    return {
      dn: entrada.dn,
      uac: uacBruto,
      memberOf,
      guid,
      login: primeiroTexto(a['samaccountname']) ?? '',
      cpf: primeiroTexto(a[this.atributoCpf]) ?? '',
      email: primeiroTexto(a['mail']) ?? '',
      habilitada: (uacBruto & UAC_DESABILITADA) === 0,
      ou: paiDe(entrada.dn),
      grupos: memberOf.map(valorDoPrimeiroRdn),
    };
  }

  private ler<T>(operacao: keyof ClienteAd, fazer: (s: SessaoLdap) => Promise<T>): Promise<T> {
    return this.chamar(operacao, fazer, this.tentativasLeitura);
  }

  private escrever<T>(operacao: keyof ClienteAd, fazer: (s: SessaoLdap) => Promise<T>): Promise<T> {
    // Só a conexão pode falhar sem efeito; a partir dela, repetir uma escrita é decisão do worker.
    return this.chamar(operacao, fazer, 1);
  }

  private async chamar<T>(
    operacao: keyof ClienteAd,
    fazer: (s: SessaoLdap) => Promise<T>,
    tentativas: number,
  ): Promise<T> {
    const inicio = this.relogio();
    let tentativa = 0;
    for (;;) {
      tentativa += 1;
      let sessao: SessaoLdap;
      try {
        sessao = await this.opcoes.abrirSessao();
      } catch (erro) {
        const falha = traduzirErroLdap(erro, 'conexao');
        if (falha.tipo === 'conexaoRecusada' && tentativa < tentativas) {
          await esperar(this.esperaMs * tentativa);
          continue;
        }
        this.registrar(operacao, falha, inicio, tentativa);
        throw falha;
      }
      try {
        const valor = await fazer(sessao);
        this.registrar(operacao, null, inicio, tentativa);
        return valor;
      } catch (erro) {
        const falha = traduzirErroLdap(erro, 'operacao');
        this.registrar(operacao, falha, inicio, tentativa);
        throw falha;
      } finally {
        await sessao.encerrar();
      }
    }
  }

  private registrar(
    operacao: keyof ClienteAd,
    falha: ErroFornecedor | null,
    inicio: number,
    tentativas: number,
  ): void {
    try {
      this.opcoes.aoRegistrar?.({
        operacao,
        desfecho: falha?.tipo ?? 'ok',
        codigo: falha?.codigo ?? 'OK',
        duracaoMs: Math.max(0, this.relogio() - inicio),
        tentativas,
      });
    } catch {
      // Observabilidade nunca derruba a operação.
    }
  }
}

interface ContaInterna extends ContaAd {
  readonly dn: string;
  readonly uac: number;
  readonly memberOf: readonly string[];
}

function uac(valor: number): MudancaLdap {
  return { operacao: 'replace', atributo: 'userAccountControl', valores: [String(valor)] };
}

function primeiroTexto(valores: readonly string[] | readonly Buffer[] | undefined): string | null {
  const valor = valores?.[0];
  if (valor === undefined) return null;
  return typeof valor === 'string' ? valor : valor.toString('utf8');
}

function textos(valores: readonly string[] | readonly Buffer[] | undefined): string[] {
  return (valores ?? []).map((v) => (typeof v === 'string' ? v : v.toString('utf8')));
}

/** objectGUID binário (16 bytes) no formato textual do AD: as três primeiras partes são little-endian. */
export function guidDe(valor: string | Buffer | undefined): string | null {
  if (!Buffer.isBuffer(valor) || valor.length !== 16) return null;
  const hex = (inicio: number, fim: number, inverter: boolean) => {
    const parte = valor.subarray(inicio, fim);
    return Buffer.from(inverter ? [...parte].reverse() : parte).toString('hex');
  };
  return [
    hex(0, 4, true),
    hex(4, 6, true),
    hex(6, 8, true),
    hex(8, 10, false),
    hex(10, 16, false),
  ].join('-');
}

/** Divide um DN nos RDNs, respeitando vírgulas escapadas (RFC 4514). */
function rdns(dn: string): string[] {
  const partes: string[] = [];
  let atual = '';
  for (let i = 0; i < dn.length; i += 1) {
    const c = dn[i]!;
    if (c === '\\' && i + 1 < dn.length) {
      atual += c + dn[i + 1]!;
      i += 1;
    } else if (c === ',') {
      partes.push(atual.trim());
      atual = '';
    } else {
      atual += c;
    }
  }
  if (atual.trim() !== '') partes.push(atual.trim());
  return partes;
}

function primeiroRdn(dn: string): string {
  return rdns(dn)[0] ?? dn;
}

function paiDe(dn: string): string {
  return rdns(dn).slice(1).join(',');
}

/** Valor do primeiro RDN sem escapes (ex.: o `cn` do grupo a partir do DN em `memberOf`). */
function valorDoPrimeiroRdn(dn: string): string {
  const rdn = primeiroRdn(dn);
  const valor = rdn.slice(rdn.indexOf('=') + 1);
  return valor.replace(/\\([0-9a-fA-F]{2}|.)/g, (_, c: string) =>
    c.length === 2 ? String.fromCharCode(parseInt(c, 16)) : c,
  );
}

function normalizarDn(dn: string): string {
  return rdns(dn)
    .map((rdn) => {
      const igual = rdn.indexOf('=');
      return `${rdn.slice(0, igual).trim().toLowerCase()}=${normalizarAcesso(rdn.slice(igual + 1))}`;
    })
    .join(',');
}

function mesmoDn(a: string, b: string): boolean {
  return normalizarDn(a) === normalizarDn(b);
}

function dentroDe(dn: string, base: string): boolean {
  const filho = normalizarDn(dn);
  const pai = normalizarDn(base);
  return filho === pai || filho.endsWith(`,${pai}`);
}

const MAIUSCULAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MINUSCULAS = 'abcdefghijkmnopqrstuvwxyz';
const DIGITOS = '23456789';
const SIMBOLOS = '!#$%*+-=?@_';

/** 24 caracteres de quatro classes, com `crypto.randomInt` (atende a complexidade padrão do AD). */
export function gerarSenhaForte(): string {
  const classes = [MAIUSCULAS, MINUSCULAS, DIGITOS, SIMBOLOS];
  const todos = classes.join('');
  const caracteres = classes.map((classe) => classe[randomInt(classe.length)]!);
  while (caracteres.length < 24) caracteres.push(todos[randomInt(todos.length)]!);
  for (let i = caracteres.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [caracteres[i], caracteres[j]] = [caracteres[j]!, caracteres[i]!];
  }
  return caracteres.join('');
}

function esperar(ms: number): Promise<void> {
  return new Promise((resolver) => setTimeout(resolver, ms));
}
