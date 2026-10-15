import { Button } from 'react-aria-components';
import { Link, Navigate, Outlet } from 'react-router';
import {
  IconeEscudoCheck,
  IconeFrasco,
  IconeSair,
} from './componentes/Icones.js';
import { MarcaGia } from './componentes/MarcaGia.js';
import { useSessao } from './sessao/Sessao.js';
import type { PerfilDemo } from './sessao/perfis.js';
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
  perfil: PerfilDemo;
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

/**
 * Shell das telas internas, no desenho do MainLayout + NavMenu do GIA antigo: cabeçalho branco
 * com marca, navegação horizontal e operador, e a faixa navy de contexto logo abaixo.
 */
export function Layout() {
  const { perfil, sair } = useSessao();

  if (!perfil) return <Navigate to="/login" replace />;
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
