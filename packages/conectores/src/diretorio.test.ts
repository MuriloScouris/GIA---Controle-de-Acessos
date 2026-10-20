import type { IdentidadeProposta } from '@gia/dominio';
import { expect, it } from 'vitest';
import { criarConsultaDiretorioReal } from './diretorio.js';
import { CPF_MARIA } from './teste/fabricas.js';

const identidade: IdentidadeProposta = {
  login: 'pessoa',
  upn: 'pessoa@example.invalid',
  email: 'pessoa@example.invalid',
  proxyAddresses: ['SMTP:pessoa@example.invalid'],
  nomeExibicao: 'Pessoa Ficticia',
  origem: 'emailCorporativoRh',
};
it('API consulta AD e Graph sem transformar existência em identidade livre', async () => {
  const conta = {
    guid: 'ad-1',
    login: identidade.login,
    cpf: CPF_MARIA,
    email: identidade.email,
    habilitada: true,
    ou: 'OU=Teste',
    grupos: [],
    gruposDn: [],
  };
  const consulta = criarConsultaDiretorioReal(
    { buscarConta: async () => conta, buscarContaPorEmail: async () => conta },
    { buscarUsuario: async () => ({ id: 'entra-1', paisUso: 'BR', licencas: [], grupos: [] }) },
  );
  expect(await consulta.buscarUsos(identidade)).toEqual([
    { fonte: 'ad', campo: 'login', valor: identidade.login, cpfTitular: CPF_MARIA },
    { fonte: 'ad', campo: 'proxyAddress', valor: identidade.email, cpfTitular: CPF_MARIA },
    { fonte: 'm365', campo: 'upn', valor: identidade.upn, cpfTitular: null },
  ]);
});
it('falha do diretório é propagada, sem resposta de identidade livre', async () => {
  const consulta = criarConsultaDiretorioReal(
    {
      buscarConta: async () => {
        throw new Error('indisponivel');
      },
      buscarContaPorEmail: async () => null,
    },
    { buscarUsuario: async () => null },
  );
  await expect(consulta.buscarUsos(identidade)).rejects.toThrow('indisponivel');
});
