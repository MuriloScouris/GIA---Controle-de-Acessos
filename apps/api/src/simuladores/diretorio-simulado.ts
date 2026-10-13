import type { IdentidadeProposta, UsoIdentidade } from '@gia/dominio';
import type { ConsultaDiretorio } from '../aplicacao/portas.js';
import { cpfFicticio } from './cpf-ficticio.js';

/**
 * Espelho fictício do AD e do M365, só leitura. A consulta real (LDAPS e
 * Graph) vem com a sincronização de diretório.
 */
export const USOS_DIRETORIO_FICTICIOS: readonly UsoIdentidade[] = [
  { fonte: 'ad', campo: 'login', valor: 'joao.pereira', cpfTitular: cpfFicticio('900000009') },
  {
    fonte: 'm365',
    campo: 'upn',
    valor: 'joao.pereira@exemplo.com.br',
    cpfTitular: cpfFicticio('900000009'),
  },
];

function normalizar(valor: string): string {
  return valor
    .trim()
    .toLowerCase()
    .replace(/^smtp:/, '');
}

export function criarDiretorioSimulado(
  usos: readonly UsoIdentidade[] = USOS_DIRETORIO_FICTICIOS,
): ConsultaDiretorio {
  return {
    async buscarUsos(identidade: IdentidadeProposta) {
      const procurados = new Set(
        [identidade.login, identidade.email, identidade.upn, ...identidade.proxyAddresses].map(
          normalizar,
        ),
      );
      return usos.filter((uso) => procurados.has(normalizar(uso.valor)));
    },
  };
}
