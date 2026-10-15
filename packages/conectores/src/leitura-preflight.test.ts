import { expect, it, vi } from 'vitest';
import type { Sistema } from '@gia/dominio';
import { transporteSomenteLeitura, respostaLimitada } from './leitura-preflight.js';
import { envelopeSoftexpert } from './softexpert/cliente.js';
const env = {
  GIA_JIRA_BASE_URL: 'https://jira.example.invalid',
  GIA_M365_TENANT_ID: 'tenant-ficticio',
  GIA_DOCUSIGN_AMBIENTE: 'demo',
  GIA_DOCUSIGN_CONTA_ID: 'conta-ficticia',
  GIA_SOFTEXPERT_URL: 'https://se.example.invalid',
};

it.each([
  ['jira', 'https://jira.example.invalid/rest/api/3/user', 'POST'],
  ['jira', 'https://jira.example.invalid/rest/api/3/group/user', 'DELETE'],
  ['m365', 'https://graph.microsoft.com/v1.0/users/id/assignLicense', 'POST'],
  ['m365', 'https://graph.microsoft.com/v1.0/users/id', 'PATCH'],
  ['docusign', 'https://demo.docusign.net/restapi/v2.1/accounts/conta-ficticia/users', 'DELETE'],
  ['docusign', 'https://demo.docusign.net/restapi/v2.1/accounts/conta-ficticia/users', 'POST'],
  ['jira', 'https://host-nao-autorizado.invalid/rest/api/3/myself', 'GET'],
] as const)('filtro %s recusa %s %s sem chamar a rede', async (sistema, url, method) => {
  const enviar = vi.fn<typeof fetch>();
  await expect(
    transporteSomenteLeitura(sistema, env, enviar)(url, { method }),
  ).rejects.toMatchObject({ codigo: 'PREFLIGHT_ESCRITA_BLOQUEADA' });
  expect(enviar).not.toHaveBeenCalled();
});

it('SOAP aceita exclusivamente a leitura de conexão, recusando mesmo um cabeçalho de leitura com corpo de escrita', async () => {
  const enviar = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  const cliente = transporteSomenteLeitura('softexpert', env, enviar);
  const url = 'https://se.example.invalid/apigateway/se/ws/adm_ws.php';
  await cliente(url, {
    method: 'POST',
    headers: { SOAPAction: 'urn:admin#getUserData' },
    body: envelopeSoftexpert('getUserData', [['iduser', '__gia_teste_conexao__']]),
  });
  await expect(
    cliente(url, {
      method: 'POST',
      headers: { SOAPAction: 'urn:admin#getUserData' },
      body: envelopeSoftexpert('disableUser', [['IDUSER', '123']]),
    }),
  ).rejects.toBeDefined();
  expect(enviar).toHaveBeenCalledTimes(1);
});

it.each([
  ['m365', 'https://login.microsoftonline.com/tenant-ficticio/oauth2/v2.0/token'],
  ['docusign', 'https://account-d.docusign.com/oauth/token'],
] as const)(
  'POST de autenticação %s não é confundido com escrita de acesso',
  async (sistema, url) => {
    const enviar = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    await transporteSomenteLeitura(sistema, env, enviar)(url, { method: 'POST' });
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(enviar.mock.calls[0]?.[1]?.redirect).toBe('error');
  },
);

it('corpo excessivo ou cancelado não passa ao parser', async () => {
  await expect(
    respostaLimitada(new Response(new Uint8Array(2 * 1024 * 1024 + 1))),
  ).rejects.toMatchObject({ codigo: 'PREFLIGHT_RESPOSTA_INVALIDA' });
  const controle = new AbortController();
  controle.abort();
  await expect(respostaLimitada(Response.json({}), controle.signal)).rejects.toBeDefined();
});

it('requisição Request também é classificada pelo método real', async () => {
  const enviar = vi.fn<typeof fetch>();
  await expect(
    transporteSomenteLeitura(
      'm365' as Sistema,
      env,
      enviar,
    )(new Request('https://graph.microsoft.com/v1.0/users', { method: 'POST' })),
  ).rejects.toBeDefined();
  expect(enviar).not.toHaveBeenCalled();
});
