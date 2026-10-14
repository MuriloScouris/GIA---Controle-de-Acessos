import { useLayoutEffect, useState, type ReactNode } from 'react';
import { Button } from 'react-aria-components';
import { Link, Navigate, NavLink, Outlet, useMatch } from 'react-router';
import {
  IconeCaixaEntrada,
  IconeEscudoCheck,
  IconeFrasco,
  IconeLista,
  IconeMenu,
  IconeSair,
} from './componentes/Icones.js';
import { useSessao } from './sessao/Sessao.js';
import type { PerfilDemo } from './sessao/perfis.js';
import { NOME_PRODUTO } from './titulo.js';

const AVISO_DADOS_DE_EXEMPLO = 'Ambiente com dados de exemplo';

function iniciais(nome: string): string {
  const palavras = nome.split(/[\s/]+/).filter(Boolean);
  if (palavras.length === 1) return nome.slice(0, 2).toUpperCase();
  return `${palavras[0]![0]}${palavras[palavras.length - 1]![0]}`.toUpperCase();
}

function PularConteudo() {
  return (
    <a className="pular-conteudo" href="#conteudo">
      Pular para o conteúdo
    </a>
  );
}

/**
 * Shell do painel de chamados: reproduz o draft SuperDesign "Onboarding de Acessos - Solicitações"
 * (sidebar escura de 250px, top-row e conteúdo à esquerda), com a marca GIA.
 */
function ShellLista({ perfil, sair }: { perfil: PerfilDemo; sair: () => void }): ReactNode {
  const [menuAberto, setMenuAberto] = useState(false);
  return (
    <div className="tema-lista pagina">
      <PularConteudo />
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            {NOME_PRODUTO}
          </div>
          <div className="brand-text">
            <div className="brand-title">{NOME_PRODUTO}</div>
            <div className="brand-sub">Controle de Acessos</div>
          </div>
          <Button
            className="menu-alternar"
            aria-expanded={menuAberto}
            aria-controls="menu-principal"
            onPress={() => setMenuAberto((aberto) => !aberto)}
          >
            <IconeMenu />
            <span className="so-leitor">Menu</span>
          </Button>
        </div>
        <div id="menu-principal" className="menu-rolavel" data-aberto={menuAberto || undefined}>
          <nav className="menu" aria-label="Navegação principal">
            <div className="nav-item">
              <NavLink className="nav-link" to="/" end>
                <IconeLista />
                Painel de chamados
              </NavLink>
            </div>
          </nav>
          <div className="operador">
            <div className="operador-avatar" aria-hidden="true">
              {iniciais(perfil.nome)}
            </div>
            <div className="operador-info">
              <div className="operador-rotulo">Operador</div>
              <div className="operador-nome">{perfil.nome}</div>
            </div>
            <Button className="operador-sair" onPress={sair} aria-label="Sair">
              <IconeSair />
              <span className="operador-sair-texto" aria-hidden="true">
                Sair
              </span>
            </Button>
          </div>
        </div>
      </aside>
      <div className="principal">
        <header className="top-row">
          <span className="top-subtitle">Gestão do ciclo de vida de acessos</span>
          <span className="badge-soft warn">
            <IconeFrasco />
            {AVISO_DADOS_DE_EXEMPLO}
          </span>
        </header>
        <main id="conteudo" className="conteudo" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/**
 * Shell do detalhe do pedido: reproduz o draft SuperDesign "Detalhe da solicitação de acesso"
 * (header branco com navegação horizontal e barra de contexto navy), com a marca GIA.
 */
function ShellDetalhe({ perfil, sair }: { perfil: PerfilDemo; sair: () => void }): ReactNode {
  return (
    <div className="tema-detalhe">
      <PularConteudo />
      <header className="det-header">
        <div className="det-header-linha">
          <Link className="det-marca" to="/" aria-label={`${NOME_PRODUTO} — ir para o painel`}>
            <svg
              viewBox="0 0 40 40"
              className="det-marca-icone"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M8 7.5h15.2l8.8 8.8v16.2H8z" fill="#5b4bd2" />
              <path
                d="M23.2 7.5v8.8H32"
                fill="none"
                stroke="#ffb097"
                strokeWidth="2.2"
                strokeLinejoin="round"
              />
              <path
                d="M13.5 21h13M13.5 26h9"
                fill="none"
                stroke="#fff"
                strokeWidth="2.1"
                strokeLinecap="round"
              />
            </svg>
            <span className="det-marca-texto">
              <strong>{NOME_PRODUTO}</strong>
              <span>Controle de Acessos</span>
            </span>
          </Link>
          <div className="det-operador">
            <span className="det-operador-avatar" aria-hidden="true">
              {iniciais(perfil.nome)}
            </span>
            <span className="det-operador-info">
              <span className="det-operador-rotulo">Operador</span>
              <span className="det-operador-nome">{perfil.nome}</span>
            </span>
            <Button className="det-sair" onPress={sair}>
              <IconeSair />
              Sair
            </Button>
          </div>
        </div>
        <nav className="det-nav" aria-label="Navegação principal">
          {/* O detalhe pertence à seção do painel: o item aparece ativo, como no draft. */}
          <Link className="det-nav-link ativo" to="/">
            <IconeCaixaEntrada />
            Painel de chamados
            <span className="det-nav-ponto" aria-hidden="true" />
          </Link>
        </nav>
        <div className="det-contexto">
          <span className="det-contexto-texto">
            <IconeEscudoCheck />
            Gestão segura do ciclo de vida de acessos
          </span>
          <span className="det-contexto-aviso">
            <IconeFrasco />
            {AVISO_DADOS_DE_EXEMPLO}
          </span>
        </div>
      </header>
      <main id="conteudo" className="det-main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}

/** Layout das telas internas; sem sessão (simulada) redireciona para o login. */
export function Layout() {
  const { perfil, sair } = useSessao();
  const emDetalhe = useMatch('/pedidos/:pedidoId') !== null;

  // Os tokens do draft (e dos portais, como o diálogo) são escolhidos pela raiz do documento.
  useLayoutEffect(() => {
    document.documentElement.dataset.tema = emDetalhe ? 'detalhe' : 'lista';
    return () => {
      delete document.documentElement.dataset.tema;
    };
  }, [emDetalhe]);

  if (!perfil) return <Navigate to="/login" replace />;
  return emDetalhe ? (
    <ShellDetalhe perfil={perfil} sair={sair} />
  ) : (
    <ShellLista perfil={perfil} sair={sair} />
  );
}
