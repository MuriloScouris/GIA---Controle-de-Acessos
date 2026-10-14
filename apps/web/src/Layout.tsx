import { useState } from 'react';
import { Button } from 'react-aria-components';
import { Navigate, NavLink, Outlet } from 'react-router';
import { IconeLista, IconeMenu, IconeSair } from './componentes/Icones.js';
import { useSessao } from './sessao/Sessao.js';
import { NOME_PRODUTO } from './titulo.js';

function iniciais(nome: string): string {
  const palavras = nome.split(/[\s/]+/).filter(Boolean);
  if (palavras.length === 1) return nome.slice(0, 2).toUpperCase();
  return `${palavras[0]![0]}${palavras[palavras.length - 1]![0]}`.toUpperCase();
}

/** Layout das telas internas; sem sessão (simulada) redireciona para o login. */
export function Layout() {
  const { perfil, sair } = useSessao();
  const [menuAberto, setMenuAberto] = useState(false);
  if (!perfil) return <Navigate to="/login" replace />;

  return (
    <>
      <a className="pular-conteudo" href="#conteudo">
        Pular para o conteúdo
      </a>
      <div className="pagina">
        <aside className="lateral">
          <div className="marca">
            <div className="marca-sinal" aria-hidden="true">
              {NOME_PRODUTO.charAt(0)}
            </div>
            <div className="marca-texto">
              <div className="marca-titulo">{NOME_PRODUTO}</div>
              <div className="marca-sub">Controle de Acessos</div>
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
            <nav aria-label="Navegação principal">
              <div className="menu-item">
                <NavLink className="menu-link" to="/" end>
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
                <span className="operador-rotulo">Perfil</span>
                <span className="operador-nome">{perfil.nome}</span>
              </div>
              <Button className="operador-sair" onPress={sair}>
                <IconeSair />
                Sair
              </Button>
            </div>
          </div>
        </aside>
        <div className="principal">
          <div className="barra-topo">
            <span className="barra-topo-subtitulo">Gestão do ciclo de vida de acessos</span>
            <span className="badge-soft warn no-dot">Sessão simulada</span>
          </div>
          <main id="conteudo" className="conteudo" tabIndex={-1}>
            <Outlet />
          </main>
        </div>
      </div>
    </>
  );
}
