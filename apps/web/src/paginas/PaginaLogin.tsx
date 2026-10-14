import { useState } from 'react';
import { Button } from 'react-aria-components';
import { Navigate } from 'react-router';
import { useApi } from '../api/ApiProvider.js';
import { PERFIS_DEMO, type PerfilDemo } from '../sessao/perfis.js';
import { useSessao } from '../sessao/Sessao.js';
import { NOME_PRODUTO, TITULO_APLICACAO } from '../titulo.js';

function LogoGia() {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <path className="logo-folha" d="M8 7.5h15.2l8.8 8.8v16.2H8z" />
      <path className="logo-dobra" d="M23.2 7.5v8.8H32" />
      <path className="logo-linhas" d="M13.5 21h13M13.5 26h9" />
    </svg>
  );
}

function IconeEscudo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"
        fill="none"
        stroke="#fff"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M9 12l2.2 2.2L15.5 10"
        fill="none"
        stroke="#fff"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconeMicrosoft() {
  return (
    <svg className="icone-ms" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="#fff" opacity="0.9" d="M2 2h9.4v9.4H2z" />
      <path fill="#fff" opacity="0.7" d="M12.6 2H22v9.4h-9.4z" />
      <path fill="#fff" opacity="0.7" d="M2 12.6h9.4V22H2z" />
      <path fill="#fff" opacity="0.5" d="M12.6 12.6H22V22h-9.4z" />
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
      <section className="login-marca" aria-label={`Sobre o ${NOME_PRODUTO}`}>
        <div className="login-marca-conteudo">
          <div className="login-logo">
            <span className="login-logo-icone">
              <LogoGia />
            </span>
            <div>
              <p className="login-logo-nome">{NOME_PRODUTO}</p>
              <p className="login-logo-legenda">Controle de Acessos</p>
            </div>
          </div>
          <p className="login-titulo-marca">Gestão do ciclo de vida de acessos.</p>
          <p className="login-subtitulo-marca">
            Acompanhe pedidos, decisões e a execução dos acessos de colaboradores em um único lugar,
            com histórico de quem fez o quê e quando.
          </p>
          <div className="login-ilustracao" aria-hidden="true">
            <span className="login-camada login-camada-3" />
            <span className="login-camada login-camada-2" />
            <span className="login-camada login-camada-1">
              <IconeEscudo />
            </span>
          </div>
        </div>
        <p className="login-rodape-marca">{TITULO_APLICACAO}</p>
      </section>

      <main id="conteudo" className="login-painel" tabIndex={-1}>
        <div className="login-logo-mobile" aria-hidden="true">
          <LogoGia />
          <span>{NOME_PRODUTO}</span>
        </div>
        <div className="login-cartao">
          <h1>Bem-vindo ao {NOME_PRODUTO}</h1>
          <p className="login-texto-suave">
            Entre com sua conta corporativa para acompanhar pedidos e acessos de colaboradores.
          </p>

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
                <p role="alert" className="mensagem-erro">
                  {erro}
                </p>
              )}
              <Button className="botao-link" onPress={() => setEscolhendo(false)}>
                Voltar
              </Button>
            </section>
          ) : (
            <Button className="botao-primario" onPress={() => setEscolhendo(true)}>
              <IconeMicrosoft />
              Entrar
            </Button>
          )}

          <div className="login-divisor" role="separator">
            <span>Atenção</span>
          </div>
          <p className="login-aviso">
            Ambiente de demonstração: o login com Entra ID ainda não está integrado. Escolha um
            perfil para simular a sessão; nenhuma escrita é feita nos sistemas de destino.
          </p>
        </div>
      </main>
    </div>
  );
}
