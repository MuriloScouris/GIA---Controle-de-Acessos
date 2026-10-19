import type { KeyObject } from 'node:crypto';
import type { Conector, ResultadoConexao } from '@gia/dominio';
import { ErroFornecedor } from '../erros.js';
import {
  criarConectorDocusign,
  type ClienteDocusign,
  type NovoUsuarioDocusign,
  type UsuarioDocusign,
} from '../adaptadores/docusign.js';
import {
  carregarChaveDocusign,
  carregarConfiguracaoDocusign,
  type ConfiguracaoDocusign,
} from './configuracao.js';
import {
  criarHttpDocusign,
  invalida,
  lista,
  texto,
  type DependenciasHttpDocusign,
  type Objeto,
} from './http.js';
import type { VariaveisAmbiente } from '@gia/contratos';

const normalizar = (valor: string) => valor.trim().toLowerCase();

/** eSignature REST v2.1. Nenhuma escrita é repetida automaticamente. */
export function criarClienteDocusignReal(
  config: ConfiguracaoDocusign,
  chave: KeyObject,
  dependencias: DependenciasHttpDocusign = {},
): ClienteDocusign {
  const http = criarHttpDocusign(config, chave, dependencias);
  const emAndamento = new Set<string>();
  const sinal = () => AbortSignal.timeout(config.timeoutMs);

  async function catalogo(caminho: string, campo: string, abort: AbortSignal): Promise<Objeto[]> {
    const encontrados: Objeto[] = [];
    let inicio = 0;
    for (let pagina = 0; pagina < 100; pagina++) {
      const separador = caminho.includes('?') ? '&' : '?';
      const dados = await http.chamar(
        `${caminho}${separador}start_position=${inicio}&count=100`,
        abort,
      );
      const registros = lista(dados[campo]);
      encontrados.push(...registros);
      if (!dados['nextUri']) return encontrados;
      // Reconstrói a URL localmente; nunca envia o token a nextUri fornecido pela rede.
      const fim = Number(dados['endPosition']);
      if (!Number.isSafeInteger(fim) || fim < inicio || registros.length === 0) invalida();
      inicio = fim + 1;
    }
    return invalida();
  }

  async function procurar(
    caminho: string,
    campo: string,
    nomeCampo: string,
    idCampo: string,
    nome: string,
    abort: AbortSignal,
  ): Promise<string | null> {
    const registros = (await catalogo(caminho, campo, abort)).filter(
      (r) => normalizar(texto(r[nomeCampo])) === normalizar(nome),
    );
    if (registros.length > 1) throw new ErroFornecedor('recusado', 'DOCUSIGN_MAPEAMENTO_AMBIGUO');
    return registros.length === 0 ? null : texto(registros[0]?.[idCampo]);
  }

  async function buscar(email: string, abort: AbortSignal): Promise<UsuarioDocusign | null> {
    const usuarios = (
      await catalogo(`/users?email=${encodeURIComponent(email.trim())}`, 'users', abort)
    ).filter((u) => normalizar(texto(u['email'])) === normalizar(email));
    if (usuarios.length > 1) throw new ErroFornecedor('recusado', 'DOCUSIGN_USUARIO_AMBIGUO');
    if (!usuarios.length) return null;
    const id = texto(usuarios[0]?.['userId']);
    const usuario = await http.chamar(`/users/${encodeURIComponent(id)}`, abort);
    if (
      texto(usuario['userId']) !== id ||
      normalizar(texto(usuario['email'])) !== normalizar(email)
    )
      invalida();
    const status = texto(usuario['userStatus']).toLowerCase();
    const situacao =
      status === 'active'
        ? 'ativo'
        : status === 'closed'
          ? 'encerrado'
          : ['pending', 'activationsent', 'activationrequired'].includes(status)
            ? 'pendente'
            : invalida();
    if (situacao === 'encerrado')
      return { id, email: texto(usuario['email']), situacao, perfil: '', grupo: '', grupos: [] };
    const perfis = await catalogo('/permission_profiles', 'permissionProfiles', abort);
    const perfil = perfis.find((p) => p['permissionProfileId'] === usuario['permissionProfileId']);
    if (!perfil) invalida();
    const grupos = lista(usuario['groupList']).map((g) => texto(g['groupName']));
    return {
      id,
      email: texto(usuario['email']),
      situacao,
      perfil: texto(perfil['permissionProfileName']),
      grupo: grupos[0] ?? '',
      grupos,
    };
  }

  async function escrever<T>(email: string, acao: (abort: AbortSignal) => Promise<T>): Promise<T> {
    if (!config.escritaHabilitada)
      throw new ErroFornecedor('recusado', 'DOCUSIGN_ESCRITA_DESLIGADA');
    const identidade = normalizar(email);
    if (emAndamento.has(identidade))
      throw new ErroFornecedor('recusado', 'DOCUSIGN_OPERACAO_EM_ANDAMENTO');
    emAndamento.add(identidade);
    try {
      return await acao(sinal());
    } finally {
      emAndamento.delete(identidade);
    }
  }

  function resultadoEscrita(dados: Objeto, campo: string): Objeto {
    try {
      const registros = lista(dados[campo]);
      if (registros.length !== 1) invalida(true);
      const registro = registros[0];
      if (!registro) invalida(true);
      if (registro['errorDetails']) {
        if (registro['userId'])
          throw new ErroFornecedor('respostaPerdida', 'DOCUSIGN_ERRO_PARCIAL');
        throw new ErroFornecedor('recusado', 'DOCUSIGN_ERRO_INTERNO');
      }
      return registro;
    } catch (erro) {
      if (
        erro instanceof ErroFornecedor &&
        ['DOCUSIGN_ERRO_INTERNO', 'DOCUSIGN_ERRO_PARCIAL'].includes(erro.codigo)
      )
        throw erro;
      return invalida(true);
    }
  }

  return {
    async testar() {
      const dados = await http.chamar('/users?count=1', sinal());
      lista(dados['users']);
    },
    buscarUsuario: (email) => buscar(email, sinal()),
    async perfilExiste(perfil) {
      return (
        (await procurar(
          '/permission_profiles',
          'permissionProfiles',
          'permissionProfileName',
          'permissionProfileId',
          perfil,
          sinal(),
        )) !== null
      );
    },
    async grupoExiste(grupo) {
      return (await procurar('/groups', 'groups', 'groupName', 'groupId', grupo, sinal())) !== null;
    },
    criarUsuario: (novo: NovoUsuarioDocusign) =>
      escrever(novo.email, async (abort) => {
        const existente = await buscar(novo.email, abort);
        if (existente)
          throw new ErroFornecedor(
            'recusado',
            existente.situacao === 'encerrado' ? 'DOCUSIGN_CONTA_ENCERRADA' : 'USUARIO_JA_EXISTE',
          );
        const perfilId = await procurar(
          '/permission_profiles',
          'permissionProfiles',
          'permissionProfileName',
          'permissionProfileId',
          novo.perfil,
          abort,
        );
        const grupoId = await procurar(
          '/groups',
          'groups',
          'groupName',
          'groupId',
          novo.grupo,
          abort,
        );
        if (!perfilId || !grupoId)
          throw new ErroFornecedor('recusado', 'PERFIL_OU_GRUPO_INEXISTENTE');
        const dados = await http.chamar('/users', abort, 'POST', {
          newUsers: [
            {
              email: novo.email.trim(),
              userName: novo.nome,
              company: novo.empresa,
              jobTitle: novo.cargo,
              permissionProfileId: perfilId,
              groupList: [{ groupId: grupoId }],
              sendActivationEmail: 'true',
              userSettings: { localePolicy: { cultureName: novo.idioma.replace('_', '-') } },
              ...(novo.endereco === null ? {} : { workAddress: { address1: novo.endereco } }),
            },
          ],
        });
        const usuario = resultadoEscrita(dados, 'newUsers');
        if (typeof usuario['userId'] !== 'string' || !usuario['userId']) invalida(true);
        if (
          !['active', 'pending', 'activationsent', 'activationrequired'].includes(
            String(usuario['userStatus']).toLowerCase(),
          )
        )
          invalida(true);
        if (
          usuario['email'] !== undefined &&
          (typeof usuario['email'] !== 'string' ||
            normalizar(usuario['email']) !== normalizar(novo.email))
        )
          invalida(true);
        return usuario['userId'];
      }),
    encerrarUsuario: (email) =>
      escrever(email, async (abort) => {
        const usuario = await buscar(email, abort);
        if (!usuario) throw new ErroFornecedor('recusado', 'CONTA_AUSENTE');
        if (usuario.situacao === 'encerrado') return;
        const dados = await http.chamar('/users', abort, 'DELETE', {
          users: [{ userId: usuario.id }],
        });
        const encerrado = resultadoEscrita(dados, 'users');
        if (
          encerrado['userId'] !== usuario.id ||
          String(encerrado['userStatus']).toLowerCase() !== 'closed'
        )
          invalida(true);
      }),
  };
}

/** Timeouts do motor que o chamador (worker) pode impor; os padrões vêm da configuração. */
export interface OpcoesConectorDocusignDoAmbiente {
  readonly timeoutConexaoMs?: number;
  readonly timeoutChamadaMs?: number;
}

/**
 * Único ponto que liga a configuração do DocuSign aos timeouts do motor, para o fluxo isolado
 * (`criarConectorDocusignDoAmbiente`) e para a composição do worker (M5): sem o que o chamador
 * impõe, a conexão usa o prazo de uma operação (`config.timeoutMs`) e a chamada usa o padrão do motor.
 */
export function montarConectorDocusign(
  config: ConfiguracaoDocusign,
  chave: KeyObject,
  opcoes: OpcoesConectorDocusignDoAmbiente = {},
  dependencias: DependenciasHttpDocusign = {},
): Conector {
  return criarConectorDocusign(criarClienteDocusignReal(config, chave, dependencias), {
    modo: 'real',
    // O testarConexao inclui OAuth e userinfo: precisa do prazo de uma operação, não dos 5 s de conexão.
    timeoutConexaoMs: opcoes.timeoutConexaoMs ?? config.timeoutMs,
    ...(opcoes.timeoutChamadaMs === undefined ? {} : { timeoutChamadaMs: opcoes.timeoutChamadaMs }),
  });
}

/** Montagem explícita; não altera o gate de escrita do domínio ou o catálogo do worker. */
export async function criarConectorDocusignDoAmbiente(
  env: VariaveisAmbiente,
  opcoes: OpcoesConectorDocusignDoAmbiente = {},
): Promise<Conector> {
  const config = carregarConfiguracaoDocusign(env);
  const chave = await carregarChaveDocusign(config.chavePrivadaArquivo);
  return montarConectorDocusign(config, chave, opcoes);
}

/**
 * Homologação somente leitura (`pnpm --filter @gia/conectores docusign:verificar`):
 * valida a configuração, carrega a chave, obtém o token JWT e confere a conta no
 * userinfo. Não lê nem altera usuários.
 */
export async function verificarConexaoDocusign(env: VariaveisAmbiente): Promise<ResultadoConexao> {
  return (await criarConectorDocusignDoAmbiente(env)).testarConexao();
}
