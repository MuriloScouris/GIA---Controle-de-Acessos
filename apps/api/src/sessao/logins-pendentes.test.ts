import { describe, expect, it } from 'vitest';
import type { LoginPendente } from './oidc.js';
import {
  LIMITES_PADRAO,
  LoginsPendentes,
  origemDe,
  type LimitesLoginsPendentes,
} from './logins-pendentes.js';

const LIMITES: LimitesLoginsPendentes = {
  validadeMs: 300_000,
  maximoPendentes: 6,
  maximoPorOrigem: 3,
  iniciosPorJanela: 4,
  janelaMs: 60_000,
  maximoOrigensRastreadas: 3,
};

let contador = 0;
const pendente = (): LoginPendente => ({
  estado: `estado-${(contador += 1)}`,
  nonce: 'nonce',
  verificador: 'verificador',
  retorno: '/',
});

function montar(limites: Partial<LimitesLoginsPendentes> = {}) {
  const relogio = { t: 1_000_000 };
  const logins = new LoginsPendentes(() => relogio.t, { ...LIMITES, ...limites });
  return { relogio, logins };
}

describe('LoginsPendentes: limites por origem e no total (M8)', () => {
  it('limita os inícios por origem na janela e libera quando ela passa', () => {
    const { relogio, logins } = montar({ maximoPorOrigem: 100 });
    for (let i = 0; i < 4; i += 1) {
      expect(logins.reservar('10.0.0.1')).toEqual({ ok: true });
      relogio.t += 1_000;
    }
    expect(logins.reservar('10.0.0.1')).toEqual({ ok: false, motivo: 'origem' });
    // Outra origem não é afetada.
    expect(logins.reservar('10.0.0.2')).toEqual({ ok: true });
    // Quem insiste continua barrado: a tentativa recusada também conta.
    relogio.t += 50_000;
    expect(logins.reservar('10.0.0.1')).toEqual({ ok: false, motivo: 'origem' });
    // Só depois de uma janela inteira sem tentar volta a ser aceito.
    relogio.t += 60_000;
    expect(logins.reservar('10.0.0.1')).toEqual({ ok: true });
  });

  it('limita os estados guardados por origem; consumir ou vencer libera a vaga', () => {
    const { relogio, logins } = montar({ iniciosPorJanela: 100 });
    const guardados: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      expect(logins.reservar('10.0.0.1')).toEqual({ ok: true });
      const p = pendente();
      logins.guardar('10.0.0.1', p);
      guardados.push(p.estado);
    }
    expect(logins.reservar('10.0.0.1')).toEqual({ ok: false, motivo: 'origem' });
    expect(logins.reservar('10.0.0.2')).toEqual({ ok: true });

    expect(logins.consumir(guardados[0]!)).toBeDefined();
    expect(logins.reservar('10.0.0.1')).toEqual({ ok: true });

    relogio.t += LIMITES.validadeMs + 1;
    expect(logins.reservar('10.0.0.1')).toEqual({ ok: true });
    expect(logins.tamanho).toBe(0);
  });

  it('limita o total guardado, de todas as origens', () => {
    const { logins } = montar({
      iniciosPorJanela: 100,
      maximoPorOrigem: 100,
      maximoOrigensRastreadas: 100,
    });
    for (let i = 0; i < 6; i += 1) {
      const origem = `10.0.0.${i}`;
      expect(logins.reservar(origem)).toEqual({ ok: true });
      logins.guardar(origem, pendente());
    }
    expect(logins.tamanho).toBe(6);
    expect(logins.reservar('10.0.1.1')).toEqual({ ok: false, motivo: 'capacidade' });
    expect(logins.tamanho).toBe(6);
  });

  it('a tabela de origens rastreadas também tem teto, e a limpeza abre espaço', () => {
    const { relogio, logins } = montar({ iniciosPorJanela: 100 });
    for (const origem of ['a', 'b', 'c']) expect(logins.reservar(origem)).toEqual({ ok: true });
    expect(logins.origensRastreadas).toBe(3);
    // Cheia e todas recentes: uma origem nova é recusada, sem crescer a tabela.
    expect(logins.reservar('d')).toEqual({ ok: false, motivo: 'capacidade' });
    expect(logins.origensRastreadas).toBe(3);
    // Uma origem já conhecida continua sendo contada normalmente.
    expect(logins.reservar('a')).toEqual({ ok: true });
    // Depois de uma janela, as antigas são esquecidas e a nova entra.
    relogio.t += LIMITES.janelaMs;
    expect(logins.reservar('d')).toEqual({ ok: true });
    expect(logins.origensRastreadas).toBe(1);
  });
});

describe('LoginsPendentes: expiração, uso único e limpeza', () => {
  it('consumir devolve o login uma vez só', () => {
    const { logins } = montar();
    const p = pendente();
    logins.guardar('10.0.0.1', p);
    expect(logins.consumir(p.estado)).toEqual(p);
    expect(logins.consumir(p.estado)).toBeUndefined();
    expect(logins.consumir('nunca-existiu')).toBeUndefined();
    expect(logins.tamanho).toBe(0);
  });

  it('login vencido não é devolvido e sai da lista (expira no instante exato)', () => {
    const { relogio, logins } = montar();
    const quase = pendente();
    const vencido = pendente();
    logins.guardar('10.0.0.1', quase);
    logins.guardar('10.0.0.1', vencido);
    relogio.t += LIMITES.validadeMs - 1;
    expect(logins.consumir(quase.estado)).toEqual(quase);
    relogio.t += 1;
    expect(logins.consumir(vencido.estado)).toBeUndefined();
    expect(logins.tamanho).toBe(0);
  });

  it('limpar varre só os vencidos e preserva os que ainda valem', () => {
    const { relogio, logins } = montar({ maximoPendentes: 100, maximoPorOrigem: 100 });
    const antigos = [pendente(), pendente()];
    for (const p of antigos) logins.guardar('10.0.0.1', p);
    relogio.t += 200_000;
    const novo = pendente();
    logins.guardar('10.0.0.2', novo);
    relogio.t += 150_000;
    logins.limpar();
    expect(logins.tamanho).toBe(1);
    expect(logins.consumir(novo.estado)).toEqual(novo);
    for (const p of antigos) expect(logins.consumir(p.estado)).toBeUndefined();
  });

  it('o abuso não deixa resíduo: depois da validade e da janela, tudo é esquecido', () => {
    const { relogio, logins } = montar({
      maximoPendentes: 1_000,
      maximoPorOrigem: 1_000,
      iniciosPorJanela: 1_000,
      maximoOrigensRastreadas: 1_000,
    });
    for (let i = 0; i < 500; i += 1) {
      const origem = `10.1.${Math.floor(i / 256)}.${i % 256}`;
      expect(logins.reservar(origem)).toEqual({ ok: true });
      logins.guardar(origem, pendente());
    }
    expect(logins.tamanho).toBe(500);
    relogio.t += LIMITES.validadeMs + LIMITES.janelaMs;
    logins.limpar();
    expect(logins.tamanho).toBe(0);
    expect(logins.origensRastreadas).toBe(0);
  });

  it('o padrão de produção: validade curta e tetos coerentes', () => {
    expect(LIMITES_PADRAO.validadeMs).toBe(5 * 60 * 1000);
    expect(LIMITES_PADRAO.maximoPorOrigem).toBeLessThanOrEqual(LIMITES_PADRAO.maximoPendentes);
    expect(LIMITES_PADRAO.iniciosPorJanela).toBeGreaterThan(0);
  });
});

describe('origemDe: chave do rate limit', () => {
  it('IPv4 vale inteiro e IPv4 mapeado em IPv6 vira o IPv4', () => {
    expect(origemDe('203.0.113.7')).toBe('203.0.113.7');
    expect(origemDe('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('IPv6 vale pelo prefixo /64, em qualquer grafia', () => {
    const a = origemDe('2001:db8:aaaa:bbbb:1:2:3:4');
    expect(a).toBe('2001:db8:aaaa:bbbb::/64');
    expect(origemDe('2001:0DB8:aaaa:bbbb::9')).toBe(a);
    expect(origemDe('2001:db8:aaaa:bbbb:ffff:ffff:ffff:ffff')).toBe(a);
    expect(origemDe('2001:db8:aaaa:cccc::1')).not.toBe(a);
    expect(origemDe('::1')).toBe('0:0:0:0::/64');
    expect(origemDe('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('sem IP legível todos dividem uma origem só (lado seguro)', () => {
    for (const ruim of [undefined, '', '   ', '1:2:3', '::1::2', 'zzzz::1', '1:2:3:4:5:6:7:8:9']) {
      expect(origemDe(ruim)).toBe('desconhecida');
    }
  });
});
