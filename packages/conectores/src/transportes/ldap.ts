import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import { Attribute, Change, Client, ResultCodeError, type ClientOptions } from 'ldapts';
import { ErroFornecedor } from '../erros.js';
import { exigirPrazo, limitarAoPrazo } from '../prazo.js';

/**
 * O pouco de LDAP que o transporte do AD usa. Isolado aqui para que o cliente
 * do AD seja testado sem rede e para que a biblioteca (ldapts) fique numa só
 * fronteira.
 */
export interface EntradaLdap {
  readonly dn: string;
  /** Valores textuais; atributos binários pedidos em `binarios` vêm como Buffer. */
  readonly atributos: Readonly<Record<string, readonly string[] | readonly Buffer[]>>;
}

export interface BuscaLdap {
  readonly base: string;
  readonly escopo: 'base' | 'sub';
  readonly filtro: string;
  readonly atributos: readonly string[];
  readonly binarios?: readonly string[];
  readonly limite?: number;
}

export type MudancaLdap = {
  readonly operacao: 'add' | 'replace' | 'delete';
  readonly atributo: string;
  readonly valores: readonly string[] | readonly Buffer[];
};

export interface SessaoLdap {
  buscar(busca: BuscaLdap): Promise<readonly EntradaLdap[]>;
  incluir(dn: string, atributos: Readonly<Record<string, readonly string[]>>): Promise<void>;
  alterar(dn: string, mudancas: readonly MudancaLdap[]): Promise<void>;
  renomear(dn: string, novoDn: string): Promise<void>;
  encerrar(): Promise<void>;
}

/** Abre uma sessão já autenticada. Falha aqui é sempre antes de qualquer operação no destino. */
export type AbrirSessaoLdap = () => Promise<SessaoLdap>;

export interface OpcoesConexaoLdap {
  readonly urls: readonly string[];
  readonly bindDn: string;
  readonly senha: () => Promise<string>;
  readonly ca: Buffer | null;
  readonly nomeServidorTls: string | null;
  readonly timeoutConexaoMs: number;
  readonly timeoutOperacaoMs: number;
}

/** Códigos de resultado LDAP (RFC 4511) que o transporte trata de forma específica. */
export const RESULTADO_LDAP = {
  limiteDeTempo: 3,
  restricaoViolada: 19,
  valorJaExiste: 20,
  objetoInexistente: 32,
  credencialInvalida: 49,
  acessoInsuficiente: 50,
  ocupado: 51,
  indisponivel: 52,
  recusaExecutar: 53,
  jaExiste: 68,
} as const;

/** Código do resultado LDAP, se o erro veio do servidor. */
export function codigoLdap(erro: unknown): number | null {
  return erro instanceof ResultCodeError ? erro.code : null;
}

/** Em que momento a falha aconteceu: antes de autenticar nada foi enviado ao destino. */
export type FaseLdap = 'conexao' | 'operacao';

/**
 * Traduz uma falha do LDAP para o vocabulário do motor (regra 3). As mensagens
 * são fixas: as da biblioteca podem carregar filtro, DN ou dados da pessoa.
 */
export function traduzirErroLdap(erro: unknown, fase: FaseLdap): ErroFornecedor {
  if (erro instanceof ErroFornecedor) return erro;
  const codigo = codigoLdap(erro);
  if (codigo !== null) {
    switch (codigo) {
      case RESULTADO_LDAP.credencialInvalida:
        return new ErroFornecedor(
          'recusado',
          'AD_CREDENCIAL_INVALIDA',
          'A conta de serviço do GIA foi recusada pelo AD; confira o cofre.',
        );
      case RESULTADO_LDAP.acessoInsuficiente:
        return new ErroFornecedor(
          'recusado',
          'AD_PERMISSAO_INSUFICIENTE',
          'A conta de serviço do GIA não tem permissão para esta operação no AD.',
        );
      case RESULTADO_LDAP.ocupado:
      case RESULTADO_LDAP.indisponivel:
        return new ErroFornecedor(
          'conexaoRecusada',
          'AD_INDISPONIVEL',
          'O AD está ocupado ou indisponível; nada foi feito.',
        );
      case RESULTADO_LDAP.limiteDeTempo:
        return new ErroFornecedor('timeout', 'AD_TEMPO_ESGOTADO');
      case RESULTADO_LDAP.objetoInexistente:
        return new ErroFornecedor(
          'recusado',
          'AD_OBJETO_INEXISTENTE',
          'O objeto não existe no AD.',
        );
      case RESULTADO_LDAP.restricaoViolada:
        return new ErroFornecedor(
          'recusado',
          'AD_RESTRICAO_VIOLADA',
          'O AD recusou a alteração por violar uma restrição (ex.: política de senha ou valor duplicado).',
        );
      case RESULTADO_LDAP.recusaExecutar:
        return new ErroFornecedor(
          'recusado',
          'AD_RECUSOU_EXECUTAR',
          'O AD recusou executar a operação.',
        );
      default:
        return new ErroFornecedor('recusado', `AD_LDAP_${codigo}`, 'O AD recusou a operação.');
    }
  }
  const mensagem = erro instanceof Error ? erro.message : '';
  const sistema = (erro as { code?: unknown } | null)?.code;
  if (
    typeof sistema === 'string' &&
    /^(ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED)/.test(sistema)
  ) {
    return new ErroFornecedor(
      'recusado',
      'AD_TLS_INVALIDO',
      'O certificado do AD não foi aceito; confira o CA e o nome do servidor.',
    );
  }
  if (fase === 'conexao') {
    return new ErroFornecedor(
      'conexaoRecusada',
      'AD_CONEXAO_RECUSADA',
      'Não foi possível conectar ao AD; nada foi feito.',
    );
  }
  if (/Operation timed out/i.test(mensagem))
    return new ErroFornecedor('timeout', 'AD_TEMPO_ESGOTADO');
  // Socket caiu com a requisição em voo: o AD pode ter agido.
  return new ErroFornecedor('respostaPerdida', 'AD_RESPOSTA_PERDIDA');
}

function opcoesTls(opcoes: OpcoesConexaoLdap) {
  const nome = opcoes.nomeServidorTls;
  return {
    minVersion: 'TLSv1.2' as const,
    rejectUnauthorized: true,
    ...(opcoes.ca === null ? {} : { ca: [opcoes.ca] }),
    ...(nome === null
      ? {}
      : {
          servername: nome,
          // Confere o certificado contra o nome configurado (DC acessado por IP ou apelido).
          checkServerIdentity: (_host: string, certificado: PeerCertificate) =>
            checkServerIdentity(nome, certificado),
        }),
  };
}

/**
 * Conecta e autentica no primeiro DC que aceitar. Só passa ao seguinte quando
 * o anterior nem conectou: credencial recusada ou certificado inválido param na hora.
 */
export function criarAbridorLdapts(opcoes: OpcoesConexaoLdap): AbrirSessaoLdap {
  return async () => {
    let ultimaFalha: ErroFornecedor | null = null;
    for (const url of opcoes.urls) {
      exigirPrazo();
      // O ldapts lê `timeout` e `connectTimeout` do mesmo objeto, a cada requisição e a cada conexão:
      // cada etapa os reajusta ao prazo restante (M4). `autoRebind` fica desligado de propósito.
      const opcoesCliente: ClientOptions = {
        url,
        connectTimeout: limitarAoPrazo(opcoes.timeoutConexaoMs),
        timeout: limitarAoPrazo(opcoes.timeoutOperacaoMs),
        tlsOptions: opcoesTls(opcoes),
        strictDN: true,
        autoRebind: false,
      };
      const cliente = new Client(opcoesCliente);
      try {
        const senha = await opcoes.senha();
        // Ler a senha pode ter gasto o prazo: o orçamento da conexão e do bind sai de agora.
        opcoesCliente.connectTimeout = limitarAoPrazo(opcoes.timeoutConexaoMs);
        opcoesCliente.timeout = limitarAoPrazo(opcoes.timeoutOperacaoMs);
        await cliente.bind(opcoes.bindDn, senha);
        return sessaoDe(cliente, () => {
          opcoesCliente.timeout = limitarAoPrazo(opcoes.timeoutOperacaoMs);
        });
      } catch (erro) {
        await cliente.unbind().catch(() => undefined);
        const traduzido = traduzirErroLdap(erro, 'conexao');
        if (traduzido.tipo !== 'conexaoRecusada') throw traduzido;
        ultimaFalha = traduzido;
      }
    }
    throw ultimaFalha ?? new ErroFornecedor('conexaoRecusada', 'AD_CONEXAO_RECUSADA');
  };
}

/**
 * `limitarTimeout` ajusta o timeout do cliente ao prazo restante e lança `timeout` se ele já venceu.
 *
 * O ldapts reconecta sozinho quando o socket caiu (`_ensureConnected`), antes de enviar, e o prazo
 * da operação só começa a contar depois disso: uma escrita poderia sair depois do deadline. Por
 * isso cada operação confere, no mesmo instante em que chama o ldapts, se a sessão ainda está
 * conectada e autenticada; se não, falha sem enviar nada e sem reconectar. Não há `await` entre a
 * conferência e o envio, então o socket não pode cair no intervalo.
 */
function sessaoDe(cliente: Client, limitarTimeout: () => void): SessaoLdap {
  const preparar = () => {
    limitarTimeout();
    if (!cliente.isBound) {
      // Cada sessão faz no máximo uma escrita; nada foi enviado para esta operação.
      throw new ErroFornecedor(
        'conexaoRecusada',
        'AD_CONEXAO_PERDIDA',
        'A conexão com o AD caiu antes de a operação ser enviada; nada foi feito.',
      );
    }
  };
  return {
    async buscar(busca) {
      preparar();
      const { searchEntries } = await cliente.search(busca.base, {
        scope: busca.escopo,
        filter: busca.filtro,
        attributes: [...busca.atributos],
        explicitBufferAttributes: [...(busca.binarios ?? [])],
        sizeLimit: busca.limite ?? 0,
        paged: false,
      });
      return searchEntries.map((entrada) => {
        const atributos: Record<string, readonly string[] | readonly Buffer[]> = {};
        for (const [chave, valor] of Object.entries(entrada)) {
          if (chave === 'dn') continue;
          atributos[chave.toLowerCase()] = (Array.isArray(valor) ? valor : [valor]) as
            string[] | Buffer[];
        }
        return { dn: entrada.dn, atributos };
      });
    },
    async incluir(dn, atributos) {
      preparar();
      await cliente.add(
        dn,
        Object.entries(atributos).map(
          ([tipo, valores]) => new Attribute({ type: tipo, values: [...valores] }),
        ),
      );
    },
    async alterar(dn, mudancas) {
      preparar();
      await cliente.modify(
        dn,
        mudancas.map(
          (m) =>
            new Change({
              operation: m.operacao,
              modification: new Attribute({
                type: m.atributo,
                values: [...m.valores] as string[] | Buffer[],
              }),
            }),
        ),
      );
    },
    async renomear(dn, novoDn) {
      preparar();
      await cliente.modifyDN(dn, novoDn);
    },
    async encerrar() {
      await cliente.unbind().catch(() => undefined);
    },
  };
}
