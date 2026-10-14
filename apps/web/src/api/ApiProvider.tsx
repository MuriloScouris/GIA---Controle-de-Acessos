import { createContext, useContext, type ReactNode } from 'react';
import { criarClienteApi, type ClienteApi } from './cliente.js';

const clientePadrao = criarClienteApi('/api');
const ApiContext = createContext<ClienteApi>(clientePadrao);

/** Entrega o cliente da API às telas; os testes injetam um cliente falso. */
export function ApiProvider({ api, children }: { api?: ClienteApi; children: ReactNode }) {
  return <ApiContext.Provider value={api ?? clientePadrao}>{children}</ApiContext.Provider>;
}

export function useApi(): ClienteApi {
  return useContext(ApiContext);
}
