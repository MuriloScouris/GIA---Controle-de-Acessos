/**
 * @gia/conectores — adaptadores AD, M365, DocuSign, SoftExpert e Jira e os
 * simuladores de cada fornecedor. Os adaptadores implementam o contrato
 * `Conector` do domínio sobre um cliente de transporte injetado; os
 * simuladores implementam esses clientes em memória, sem rede nem segredos.
 * O AD já tem transporte real (LDAPS, em `transportes/`); Graph, REST e SOAP ainda não.
 * O Jira Cloud também dispõe de transporte REST real, habilitado explicitamente.
 */
export const PACOTE = '@gia/conectores';

export * from './erros.js';
export * from './escape.js';
export * from './motor.js';
export * from './catalogo.js';

export * from './adaptadores/ad.js';
export * from './adaptadores/m365.js';
export * from './adaptadores/docusign.js';
export * from './docusign/configuracao.js';
export * from './docusign/cliente.js';
export * from './adaptadores/softexpert.js';
export * from './adaptadores/jira-destino.js';
export * from './adaptadores/jira-origem.js';
export * from './jira/http.js';
export * from './jira/origem.js';
export * from './jira/destino.js';
export * from './jira/ambiente.js';

export * from './simuladores/roteiro.js';
export * from './simuladores/ad.js';
export * from './simuladores/m365.js';
export * from './simuladores/docusign.js';
export * from './simuladores/softexpert.js';
export * from './simuladores/jira.js';

export * from './transportes/configuracao-ad.js';
export * from './transportes/ldap.js';
export * from './transportes/ad-ldap.js';
export * from './transportes/ad-real.js';

export * from './softexpert/configuracao.js';
export * from './softexpert/cliente.js';
export * from './softexpert/real.js';

export * from './m365/configuracao.js';
export * from './m365/cliente.js';
export * from './m365/real.js';
