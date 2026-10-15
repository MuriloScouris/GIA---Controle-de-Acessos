import { Button } from 'react-aria-components';
import { Link, Navigate, Outlet, useLocation } from 'react-router';
import { IconeEscudoCheck, IconeFrasco, IconeSair } from './componentes/Icones.js';
import { MarcaGia } from './componentes/MarcaGia.js';
import { useSessao, type UsuarioSessao } from './sessao/Sessao.js';
import { NOME_PRODUTO } from './titulo.js';

function iniciais(nome: string): string {
  const palavras = nome.split(/[\s/]+/).filter(Boolean);
  if (palavras.length === 1) return nome.slice(0, 2).toUpperCase();
  return `${palavras[0]![0]}${palavras[palavras.length - 1]![0]}`.toUpperCase();
}

function Operador({
  perfil,
  sair,
  movel = false,
}: {
  perfil: UsuarioSessao;
  sair: () => void;
  movel?: boolean;
}) {
  return (
    <div className={movel ? 'operator operator-mobile' : 'operator operator-desktop'}>
      <span className="operator-avatar" aria-hidden="true">
        {iniciais(perfil.nome)}
      </span>
      <span className="operator-info">
        <span className="operator-label">{movel ? 'Operando como' : 'Operador'}</span>
        <span className="operator-name">{perfil.nome}</span>
      </span>
      <Button className="operator-sair" onPress={sair} aria-label="Sair">
        <IconeSair />
        {movel && <span aria-hidden="true">Sair</span>}
      </Button>
    </div>
  );
}

/** Enquanto o servidor diz como entrar e se já há sessão. */
export function CarregandoSessao() {
  return (
    <main id="conteudo" className="estado estado-carregando-sessao">
      <p role="status">Carregando sessão…</p>
    </main>
  );
}

/**
 * Shell das telas internas, no desenho do MainLayout + NavMenu do GIA antigo: cabeçalho branco
 * com marca, navegação horizontal e operador, e a faixa navy de contexto logo abaixo.
 */
export function Layout() {
  const { modo, perfil, sair } = useSessao();
  const local = useLocation();

  if (modo === 'carregando') return <CarregandoSessao />;
  if (!perfil) {
    // Volta para onde estava depois do login (só caminho local; o servidor revalida).
    const retorno = `${local.pathname}${local.search}`;
    const destino = retorno === '/' ? '/login' : `/login?retorno=${encodeURIComponent(retorno)}`;
    return <Navigate to={destino} replace />;
  }
  return (
    <div className="app-shell">
      <a className="pular-conteudo" href="#conteudo">
        Pular para o conteúdo
      </a>
      <header className="shell-header">
        <div className="shell-primary">
          <Link className="brand" to="/" aria-label={`${NOME_PRODUTO} — ir para o painel`}>
            <MarcaGia className="brand-mark" />
            <span className="brand-text">
              <strong className="brand-title">{NOME_PRODUTO}</strong>
              <span className="brand-sub">Controle de Acessos</span>
            </span>
          </Link>
          <Operador perfil={perfil} sair={sair} />
        </div>
        <div className="shell-contexto">
          <div className="shell-contexto-texto">
            <IconeEscudoCheck />
            <span>Gestão segura do ciclo de vida de acessos</span>
          </div>
          <span className="integration-status is-mock" role="status">
            <IconeFrasco />
            Ambiente com dados de exemplo
          </span>
        </div>
      </header>
      <main id="conteudo" className="shell-main" tabIndex={-1}>
        <article className="content">
          <Outlet />
        </article>
      </main>
    </div>
  );
}
