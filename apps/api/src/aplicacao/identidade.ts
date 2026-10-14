import {
  sucesso,
  verificarIdentidade,
  type ContextoComando,
  type IdentidadeProposta,
  type PedidoAdmissao,
  type PropostaAlterada,
  type Resultado,
  type Revisao,
  type UsoIdentidade,
} from '@gia/dominio';
import type { ConsultaDiretorio, Repositorios } from './portas.js';

/** Usos da identidade no AD/M365 (diretório) e no próprio Gia (identidades efetivas). */
async function buscarUsos(
  tx: Repositorios,
  diretorio: ConsultaDiretorio,
  identidade: IdentidadeProposta,
): Promise<readonly UsoIdentidade[]> {
  const externos = await diretorio.buscarUsos(identidade);
  const doGia = (await tx.colaboradores.todos()).flatMap((colaborador): UsoIdentidade[] => {
    const usos: UsoIdentidade[] = [];
    const cpfTitular = colaborador.cpf;
    if (colaborador.login !== null) {
      usos.push({ fonte: 'gia', campo: 'login', valor: colaborador.login, cpfTitular });
    }
    if (colaborador.email !== null) {
      usos.push({ fonte: 'gia', campo: 'email', valor: colaborador.email, cpfTitular });
    }
    if (colaborador.upn !== null) {
      usos.push({ fonte: 'gia', campo: 'upn', valor: colaborador.upn, cpfTitular });
    }
    return usos;
  });
  return [...externos, ...doGia];
}

/**
 * Revalida a identidade da proposta contra os usos atuais. Sem identidade
 * (pendência do RH), não há o que verificar e nada muda.
 */
export async function revalidarIdentidade(
  tx: Repositorios,
  diretorio: ConsultaDiretorio,
  proposta: { readonly pedido: PedidoAdmissao; readonly revisao: Revisao },
  versaoEsperada: number,
  ctx: ContextoComando,
): Promise<Resultado<PropostaAlterada>> {
  const { pedido, revisao } = proposta;
  if (revisao.identidade === null) return sucesso({ pedido, revisao, eventos: [] });
  const usos = await buscarUsos(tx, diretorio, revisao.identidade);
  return verificarIdentidade({ pedido, revisao, usos }, versaoEsperada, ctx);
}
