import type { IdentidadeProposta, UsoIdentidade } from '@gia/dominio';
import type { ClienteAd } from './adaptadores/ad.js';
import type { ClienteGraph } from './adaptadores/m365.js';

/** Porta somente leitura usada pela API. Falha externa nunca é convertida em identidade livre. */
export function criarConsultaDiretorioReal(
  ad: Pick<ClienteAd, 'buscarConta' | 'buscarContaPorEmail'>,
  graph: Pick<ClienteGraph, 'buscarUsuario'>,
) {
  return {
    async buscarUsos(identidade: IdentidadeProposta): Promise<readonly UsoIdentidade[]> {
      const usos: UsoIdentidade[] = [];
      const conta = await ad.buscarConta(identidade.login);
      if (conta)
        usos.push({ fonte: 'ad', campo: 'login', valor: identidade.login, cpfTitular: conta.cpf });
      const emails = new Map<string, 'email' | 'proxyAddress'>([
        [identidade.email, 'email'],
        ...identidade.proxyAddresses.map(
          (p) => [p.replace(/^smtp:/i, ''), 'proxyAddress'] as const,
        ),
      ]);
      for (const [valor, campo] of emails) {
        const titular = await ad.buscarContaPorEmail(valor);
        if (titular) usos.push({ fonte: 'ad', campo, valor, cpfTitular: titular.cpf });
      }
      const usuario = await graph.buscarUsuario(identidade.upn, identidade.email);
      // Graph não comprova CPF/vínculo com o objectGUID local: conflito conservador.
      if (usuario)
        usos.push({ fonte: 'm365', campo: 'upn', valor: identidade.upn, cpfTitular: null });
      return usos;
    },
  };
}
