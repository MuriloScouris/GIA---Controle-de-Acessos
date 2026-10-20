import { randomUUID } from 'node:crypto';
import { penduradoAteAbortar } from './pendurado.js';

export interface UsuarioGraphFalso {
  id: string;
  userPrincipalName: string;
  mail: string | null;
  proxyAddresses: string[];
  usageLocation: string | null;
  assignedLicenses: { skuId: string }[];
}

export interface GrupoGraphFalso {
  id: string;
  displayName: string;
  mailNickname: string;
  mail: string | null;
  onPremisesSyncEnabled: boolean | null;
  membros: string[];
}

export interface SkuGraphFalso {
  skuId: string;
  skuPartNumber: string;
  prepaidUnits: { enabled: number; warning: number; suspended: number };
  consumedUnits: number;
}

export interface RequisicaoGraph {
  readonly metodo: string;
  readonly caminho: string;
  readonly cabecalhos: Headers;
  readonly corpo: string;
}

type Resposta = Response | (() => Response) | 'pendurar' | Error;

const json = (valor: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(valor), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export const erroGraph = (
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response => json({ error: { code, message } }, status, headers);

/**
 * Microsoft Graph + Entra ID falsos atrás de `fetch`, com as regras que o GIA
 * anterior conferiu no tenant real: 400 sem `removeLicenses`, 400 sem
 * `usageLocation`, 400 "already exist" para membro repetido, assentos que
 * acabam, filtro por `proxyAddresses`/members exigindo `ConsistencyLevel`.
 * Dados fictícios. Respostas podem ser programadas por rota.
 */
export class GraphFalso {
  readonly requisicoes: RequisicaoGraph[] = [];
  readonly usuarios: UsuarioGraphFalso[] = [];
  readonly grupos: GrupoGraphFalso[] = [];
  readonly skus: SkuGraphFalso[] = [];
  readonly programadas = new Map<string, Resposta[]>();
  tokensEmitidos = 0;
  /** Tamanho da página do memberOf (paginação com @odata.nextLink). */
  tamanhoPagina = 100;

  /** Programa respostas para a rota (`METODO /caminho-sem-query`, ex.: `POST /token`). */
  programar(rota: string, ...respostas: Resposta[]): void {
    this.programadas.set(rota, [...(this.programadas.get(rota) ?? []), ...respostas]);
  }

  sincronizar(upn: string, extra: Partial<UsuarioGraphFalso> = {}): UsuarioGraphFalso {
    const usuario: UsuarioGraphFalso = {
      id: randomUUID(),
      userPrincipalName: upn,
      mail: null,
      proxyAddresses: [],
      usageLocation: null,
      assignedLicenses: [],
      ...extra,
    };
    this.usuarios.push(usuario);
    return usuario;
  }

  grupo(displayName: string, extra: Partial<GrupoGraphFalso> = {}): GrupoGraphFalso {
    const grupo: GrupoGraphFalso = {
      id: randomUUID(),
      displayName,
      mailNickname: displayName.toLowerCase().replace(/\W+/g, ''),
      mail: null,
      onPremisesSyncEnabled: null,
      membros: [],
      ...extra,
    };
    this.grupos.push(grupo);
    return grupo;
  }

  sku(skuPartNumber: string, enabled: number, consumedUnits = 0): SkuGraphFalso {
    const sku = {
      skuId: randomUUID(),
      skuPartNumber,
      prepaidUnits: { enabled, warning: 0, suspended: 0 },
      consumedUnits,
    };
    this.skus.push(sku);
    return sku;
  }

  readonly fetch: typeof fetch = async (entrada, init) => {
    const url = new URL(String(entrada));
    const metodo = init?.method ?? 'GET';
    const cabecalhos = new Headers(init?.headers);
    const corpo = typeof init?.body === 'string' ? init.body : '';
    const caminho = url.host.startsWith('login.') ? '/token' : url.pathname.replace(/^\/v1\.0/, '');
    this.requisicoes.push({ metodo, caminho: `${caminho}${url.search}`, cabecalhos, corpo });
    const rota = `${metodo} ${caminho.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id')}`;
    const programada = this.programadas.get(rota)?.shift();
    if (programada !== undefined) {
      if (programada === 'pendurar') {
        return penduradoAteAbortar(init?.signal);
      }
      if (programada instanceof Error) throw programada;
      return typeof programada === 'function' ? programada() : programada;
    }
    if (caminho === '/token') {
      this.tokensEmitidos += 1;
      return json({ access_token: `token-ficticio-${this.tokensEmitidos}`, expires_in: 3599 });
    }
    if (cabecalhos.get('authorization')?.startsWith('Bearer token-ficticio-') !== true) {
      return erroGraph(401, 'InvalidAuthenticationToken', 'Access token is empty.');
    }
    return this.responder(metodo, caminho, url.searchParams, cabecalhos, corpo);
  };

  private responder(
    metodo: string,
    caminho: string,
    q: URLSearchParams,
    cabecalhos: Headers,
    corpo: string,
  ): Response {
    const partes = caminho.split('/').filter(Boolean).map(decodeURIComponent);
    const filtro = q.get('$filter') ?? '';
    const avancada = cabecalhos.get('consistencylevel') === 'eventual';
    const pegarUsuario = (chave: string) =>
      this.usuarios.find(
        (u) => u.id === chave || u.userPrincipalName.toLowerCase() === chave.toLowerCase(),
      );

    if (metodo === 'GET' && caminho === '/organization') {
      return json({ value: [{ id: randomUUID() }] });
    }
    if (metodo === 'GET' && caminho === '/subscribedSkus') return json({ value: this.skus });

    if (partes[0] === 'users' && partes.length === 1 && metodo === 'GET') {
      const mail = /^mail eq '(.*)'$/.exec(filtro)?.[1]?.replace(/''/g, "'");
      if (mail !== undefined) {
        return json({
          value: this.usuarios.filter((u) => u.mail?.toLowerCase() === mail.toLowerCase()),
        });
      }
      const alias = /^proxyAddresses\/any\(p:p eq 'smtp:(.*)'\)$/.exec(filtro)?.[1];
      if (alias !== undefined) {
        if (!avancada || q.get('$count') !== 'true') {
          return erroGraph(400, 'Request_UnsupportedQuery', 'Unsupported query.');
        }
        return json({
          value: this.usuarios.filter((u) =>
            u.proxyAddresses.some((p) => p.toLowerCase() === `smtp:${alias.toLowerCase()}`),
          ),
        });
      }
      return erroGraph(400, 'BadRequest', 'Filtro não suportado no falso.');
    }

    if (partes[0] === 'users' && partes.length >= 2) {
      const usuario = pegarUsuario(partes[1]!);
      if (usuario === undefined) {
        return erroGraph(
          404,
          'Request_ResourceNotFound',
          `Resource '${partes[1]}' does not exist.`,
        );
      }
      if (metodo === 'GET' && partes.length === 2) return json(usuario);
      if (metodo === 'PATCH' && partes.length === 2) {
        Object.assign(usuario, JSON.parse(corpo) as object);
        return new Response(null, { status: 204 });
      }
      if (metodo === 'GET' && partes[2] === 'memberOf') {
        const meus = this.grupos.filter((g) => g.membros.includes(usuario.id));
        const inicio = Number(q.get('$skiptoken') ?? 0);
        const pagina = meus.slice(inicio, inicio + this.tamanhoPagina);
        const fim = inicio + this.tamanhoPagina;
        return json({
          value: pagina.map(publico),
          ...(fim < meus.length
            ? {
                '@odata.nextLink': `https://graph.microsoft.com/v1.0/users/${usuario.id}/memberOf/microsoft.graph.group?$skiptoken=${fim}`,
              }
            : {}),
        });
      }
      if (metodo === 'POST' && partes[2] === 'assignLicense') {
        const pedido = JSON.parse(corpo) as {
          addLicenses?: { skuId: string }[];
          removeLicenses?: string[];
        };
        if (!Array.isArray(pedido.addLicenses) || !Array.isArray(pedido.removeLicenses)) {
          return erroGraph(
            400,
            'Request_BadRequest',
            'Invalid value specified for property removeLicenses.',
          );
        }
        if (pedido.addLicenses.length > 0 && usuario.usageLocation === null) {
          return erroGraph(
            400,
            'Request_BadRequest',
            'License assignment failed because user has an invalid usage location.',
          );
        }
        for (const { skuId } of pedido.addLicenses) {
          const sku = this.skus.find((s) => s.skuId === skuId);
          if (sku === undefined) return erroGraph(400, 'Request_BadRequest', 'License not found.');
          if (sku.consumedUnits >= sku.prepaidUnits.enabled) {
            return erroGraph(
              400,
              'Request_BadRequest',
              'Subscription has no more licenses available.',
            );
          }
        }
        for (const { skuId } of pedido.addLicenses) {
          if (!usuario.assignedLicenses.some((l) => l.skuId === skuId)) {
            usuario.assignedLicenses.push({ skuId });
            this.skus.find((s) => s.skuId === skuId)!.consumedUnits += 1;
          }
        }
        for (const skuId of pedido.removeLicenses) {
          if (usuario.assignedLicenses.some((l) => l.skuId === skuId)) {
            usuario.assignedLicenses = usuario.assignedLicenses.filter((l) => l.skuId !== skuId);
            this.skus.find((s) => s.skuId === skuId)!.consumedUnits -= 1;
          }
        }
        return json(usuario);
      }
    }

    if (partes[0] === 'groups') {
      if (partes.length === 1 && metodo === 'GET') {
        const alvo = /displayName eq '(.*?)' or/.exec(filtro)?.[1]?.replace(/''/g, "'") ?? '';
        const achados = this.grupos.filter((g) =>
          [g.displayName, g.mailNickname, g.mail].some(
            (v) => v?.toLowerCase() === alvo.toLowerCase(),
          ),
        );
        return json({ value: achados.map(publico) });
      }
      const grupo = this.grupos.find((g) => g.id === partes[1]);
      if (grupo === undefined)
        return erroGraph(404, 'Request_ResourceNotFound', 'Group not found.');
      if (metodo === 'GET' && partes.length === 2) {
        return json(publico(grupo));
      }
      if (metodo === 'GET' && partes[2] === 'members') {
        if (!avancada) return erroGraph(400, 'Request_UnsupportedQuery', 'Unsupported query.');
        const id = /^id eq '(.*)'$/.exec(filtro)?.[1];
        return json({ value: grupo.membros.filter((m) => m === id).map((m) => ({ id: m })) });
      }
      if (metodo === 'POST' && partes[2] === 'members' && partes[3] === '$ref') {
        if (grupo.onPremisesSyncEnabled === true) {
          return erroGraph(
            400,
            'Request_BadRequest',
            'Cannot Update a mail-enabled security groups and or distribution list.',
          );
        }
        const id = /directoryObjects\/([0-9a-f-]+)$/.exec(
          (JSON.parse(corpo) as Record<string, string>)['@odata.id'] ?? '',
        )?.[1];
        if (id === undefined) return erroGraph(400, 'BadRequest', 'Invalid @odata.id.');
        if (grupo.membros.includes(id)) {
          return erroGraph(
            400,
            'Request_BadRequest',
            "One or more added object references already exist for the following modified properties: 'members'.",
          );
        }
        grupo.membros.push(id);
        return new Response(null, { status: 204 });
      }
    }
    return erroGraph(404, 'NotFound', 'Rota não implementada no falso.');
  }
}

/** Grupo como o Graph devolve, sem a lista interna de membros do falso. */
function publico(grupo: GrupoGraphFalso): Omit<GrupoGraphFalso, 'membros'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { membros, ...resto } = grupo;
  return resto;
}

/** Erro de rede como o `fetch` do Node lança (TypeError com `cause.code`). */
export function erroDeRedeGraph(codigo: string): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: { code: codigo } });
}
