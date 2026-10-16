import { useState } from 'react';
import { Button } from 'react-aria-components';
import { Navigate, useSearchParams } from 'react-router';
import { useApi } from '../api/ApiProvider.js';
import { IconeEscudoCheck } from '../componentes/Icones.js';
import { MarcaGia } from '../componentes/MarcaGia.js';
import { PERFIS_DEMO, type PerfilDemo } from '../sessao/perfis.js';
import { useSessao } from '../sessao/Sessao.js';
import { NOME_PRODUTO, TITULO_APLICACAO } from '../titulo.js';

function IconeMicrosoft() {
  return (
    <svg className="login-botao-logo" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="#f25022" d="M2 2h9.4v9.4H2z" />
      <path fill="#7fba00" d="M12.6 2H22v9.4h-9.4z" />
      <path fill="#00a4ef" d="M2 12.6h9.4V22H2z" />
      <path fill="#ffb900" d="M12.6 12.6H22V22h-9.4z" />
    </svg>
  );
}

/** Mensagens dos códigos que o servidor devolve em `/login?erro=` (o texto do provedor nunca chega aqui). */
const MENSAGENS_DE_ERRO: Readonly<Record<string, string>> = {
  LOGIN_RECUSADO_PELO_PROVEDOR:
    'O login foi cancelado ou recusado pela Microsoft. Tente entrar de novo.',
  LOGIN_ESTADO_INVALIDO:
    'O login expirou ou foi iniciado em outra aba. Tente entrar de novo por aqui.',
  LOGIN_TROCA_FALHOU:
    'Não foi possível confirmar sua identidade com a Microsoft. Tente de novo; se persistir, avise o suporte.',
  LOGIN_TOKEN_INVALIDO:
    'Não foi possível confirmar sua identidade com a Microsoft. Tente de novo; se persistir, avise o suporte.',
  LOGIN_INDISPONIVEL: 'O login está indisponível no momento. Tente de novo em alguns minutos.',
};

/** Só caminho local volta depois do login (o servidor revalida). */
function retornoLocal(valor: string | null): string {
  if (valor === null || !valor.startsWith('/')) return '/';
  // `//host` e `/\host` mudariam de origem no navegador.
  return valor.startsWith('//') || valor.startsWith('/\\') ? '/' : valor;
}

/**
 * Tela de login. Quem decide o login é o servidor (`GET /sessao/modo`):
 * em produção, "Entrar com Microsoft" (Entra ID/OIDC); só em desenvolvimento,
 * os perfis de demonstração da sessão simulada.
 */
export function PaginaLogin() {
  const { modo, perfil, entrar } = useSessao();
  const [parametros] = useSearchParams();
  const codigoErro = parametros.get('erro');
  const retorno = retornoLocal(parametros.get('retorno'));
  const api = useApi();
  const [escolhendo, setEscolhendo] = useState(false);
  const [abrindo, setAbrindo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  /** Abre a sessão simulada no servidor (cookie) e só então guarda o perfil na interface. */
  async function escolher(opcao: PerfilDemo) {
    setAbrindo(true);
    setErro(null);
    try {
      await api.abrirSessaoSimulada(opcao.id);
      entrar(opcao);
    } catch {
      setErro(
        'Não foi possível abrir a sessão. Verifique se a API está disponível e tente de novo.',
      );
      setAbrindo(false);
    }
  }

  if (perfil) return <Navigate to={retorno} replace />;

  return (
    <div className="login">
      <a className="pular-conteudo" href="#conteudo">
        Pular para o conteúdo
      </a>
      {/* Tela em duas colunas do GIA antigo: a marca à esquerda some no celular. */}
      <aside className="login-marca" aria-label={`Sobre o ${NOME_PRODUTO}`}>
        <span className="login-marca-pontos" aria-hidden="true" />
        <span className="login-marca-brilho" aria-hidden="true" />
        <div className="login-marca-logo">
          <span className="login-marca-icone" aria-hidden="true">
            <svg viewBox="0 0 40 40" focusable="false">
              <path d="M8 7.5h15.2l8.8 8.8v16.2H8z" fill="#fff" />
              <path
                d="M23.2 7.5v8.8H32"
                fill="none"
                stroke="#2b2144"
                strokeWidth="2.2"
                strokeLinejoin="round"
              />
              <path
                d="M13.5 21h13M13.5 26h9"
                fill="none"
                stroke="#2b2144"
                strokeWidth="2.1"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span>{NOME_PRODUTO}</span>
        </div>
        <div className="login-marca-texto">
          <p className="login-tagline">
            Gestão do ciclo de vida <span>de acessos.</span>
          </p>
          <p className="login-subtitulo">
            Acompanhe pedidos, decisões e a execução dos acessos de colaboradores em um único lugar,
            com histórico de quem fez o quê e quando.
          </p>
        </div>
        <p className="login-copyright">{TITULO_APLICACAO}</p>
      </aside>

      <main id="conteudo" className="login-acesso" tabIndex={-1}>
        <div className="login-logo-mobile" aria-hidden="true">
          <MarcaGia />
          <span>{NOME_PRODUTO}</span>
        </div>
        <div className="login-centro">
          <div className="login-caixa">
            <header className="login-cabecalho">
              <h1 className="login-titulo">Bem-vindo ao {NOME_PRODUTO}</h1>
              <p className="login-descricao">
                Entre com sua conta corporativa para acompanhar pedidos e acessos de colaboradores.
              </p>
            </header>

            {codigoErro === 'ACESSO_NEGADO' ? (
              <section
                role="alert"
                aria-labelledby="titulo-acesso-negado"
                className="login-nota login-acesso-negado"
              >
                <h2 id="titulo-acesso-negado" className="login-nota-titulo">
                  <IconeEscudoCheck />
                  Acesso negado
                </h2>
                <p className="login-nota-texto">
                  Sua conta Microsoft foi reconhecida, mas não tem papel no {NOME_PRODUTO}. Peça a
                  liberação ao administrador do {NOME_PRODUTO}; nenhuma sessão foi aberta.
                </p>
              </section>
            ) : (
              codigoErro !== null && (
                <p role="alert" className="alert alert-danger">
                  {MENSAGENS_DE_ERRO[codigoErro] ?? 'Não foi possível entrar. Tente de novo.'}
                </p>
              )
            )}

            {modo === 'carregando' && (
              <p role="status" className="login-descricao">
                Carregando…
              </p>
            )}

            {modo === 'oidc' && (
              <>
                <div className="login-entrada">
                  <a className="login-botao" href={api.urlEntrarOidc(retorno)}>
                    <IconeMicrosoft />
                    <span>Entrar com Microsoft</span>
                  </a>
                  <p className="login-divisor">
                    <span>Segurança corporativa</span>
                  </p>
                </div>
                <div className="login-nota">
                  <p className="login-nota-titulo">
                    <IconeEscudoCheck />
                    Acesso restrito
                  </p>
                  <p className="login-nota-texto">
                    Use sua conta corporativa. O acesso é liberado pelo administrador do{' '}
                    {NOME_PRODUTO} no Entra ID; sem papel liberado, o login conclui e o{' '}
                    {NOME_PRODUTO} avisa.
                  </p>
                </div>
              </>
            )}

            {modo === 'indisponivel' && (
              <p role="alert" className="alert alert-warning">
                O login não está disponível neste ambiente. Avise o suporte do {NOME_PRODUTO}.
              </p>
            )}

            {modo === 'simulada' &&
              (escolhendo ? (
                <section aria-labelledby="titulo-perfis" className="login-perfis">
                  <h2 id="titulo-perfis">Escolha um perfil de demonstração</h2>
                  <ul>
                    {PERFIS_DEMO.map((opcao) => (
                      <li key={opcao.id}>
                        <Button
                          className="login-perfil"
                          isDisabled={abrindo}
                          onPress={() => void escolher(opcao)}
                        >
                          <span className="login-perfil-nome">{opcao.nome}</span>
                          <span className="login-perfil-descricao">{opcao.descricao}</span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                  {erro && (
                    <p role="alert" className="alert alert-danger">
                      {erro}
                    </p>
                  )}
                  <Button className="btn btn-link" onPress={() => setEscolhendo(false)}>
                    Voltar
                  </Button>
                </section>
              ) : (
                <div className="login-entrada">
                  <Button className="login-botao" onPress={() => setEscolhendo(true)}>
                    <IconeMicrosoft />
                    <span>Entrar</span>
                  </Button>
                  <p className="login-divisor">
                    <span>Segurança corporativa</span>
                  </p>
                </div>
              ))}

            {modo === 'simulada' && (
              <div className="login-nota">
                <p className="login-nota-titulo">
                  <IconeEscudoCheck />
                  Ambiente de demonstração
                </p>
                <p className="login-nota-texto">
                  Sessão simulada de desenvolvimento: escolha um perfil para simular a sessão;
                  nenhuma escrita é feita nos sistemas de destino.
                </p>
              </div>
            )}

            {/* Rótulos institucionais em texto, sem link: as páginas ainda não existem. */}
            <p className="login-rodape">
              <span>Privacidade</span>
              <span>Termos de Uso</span>
              <span>Suporte</span>
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
