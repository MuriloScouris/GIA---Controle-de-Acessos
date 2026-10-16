# GIA — contexto do fluxo Onboarding

## Register

product

## Users

RH importa chamados; revisor ajusta e decide; executor solicita operações;
auditor consulta evidências; administradores mantêm configuração. Papéis e
permissões são definidos pelo domínio e revalidados pela API.

## Product Purpose

Receber chamados de admissão, revisar a proposta, decidir e acompanhar os acessos
por sistema, preservando a diferença entre simulação e confirmação no destino.

## Brand Personality

Marca GIA e identidade dos drafts SuperDesign já implementados em `estilos.css`.
Este escopo preserva os tokens, a tipografia Manrope e os componentes existentes.

## Anti-references

Redesign e alterações da UI legado em andamento estão fora da DEV-286.

## Design Principles

- Aprovação e execução são decisões separadas.
- Estado mostrado vem da API; simulação não confirma acesso real.
- Erro de rede não provoca repetição automática de escrita.
- Histórico persistido respeita a permissão de auditoria.

## Accessibility & Inclusion

Preservar controles semânticos, navegação por teclado, rótulos acessíveis e
anúncios dos estados de carregamento, erro e resultado em português.
