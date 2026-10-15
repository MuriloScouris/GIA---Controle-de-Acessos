import { useState } from 'react';
import { Button } from 'react-aria-components';
import { Navigate } from 'react-router';
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

/**
 * Tela de login. A sessão é SIMULADA e temporária: não há Entra ID/OIDC nesta fase.
 * "Entrar" abre a escolha de um perfil de demonstração, que define a sessão local
 * (ver `sessao/Sessao.tsx`); a integração real substituirá este fluxo.
 */
export function PaginaLogin() {
  const { perfil, entrar } = useSessao();
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

  if (perfil) return <Navigate to="/" replace />;

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

            {escolhendo ? (
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
            )}

            <div className="login-nota">
              <p className="login-nota-titulo">
                <IconeEscudoCheck />
                Ambiente de demonstração
              </p>
              <p className="login-nota-texto">
                O login com Entra ID ainda não está integrado. Escolha um perfil para simular a
                sessão; nenhuma escrita é feita nos sistemas de destino.
              </p>
            </div>

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
