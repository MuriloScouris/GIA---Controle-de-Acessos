import { avaliarExistencia } from '@gia/dominio';
import { describe, expect, it } from 'vitest';
import { DocusignSimulado } from '../simuladores/docusign.js';
import { JiraDestinoSimulado } from '../simuladores/jira.js';
import { SoftexpertSimulado } from '../simuladores/softexpert.js';
import {
  CADASTROS,
  contexto,
  contextoRevogacao,
  paramsDocusign,
  paramsJira,
  paramsSoftexpert,
} from '../teste/fabricas.js';
import { criarConectorDocusign } from './docusign.js';
import { criarConectorJiraDestino } from './jira-destino.js';
import { criarConectorSoftexpert } from './softexpert.js';

describe('conector DocuSign', () => {
  function montar() {
    const simulador = new DocusignSimulado(CADASTROS.docusign);
    return { simulador, conector: criarConectorDocusign(simulador, { modo: 'simulado' }) };
  }

  it('cria o usuário com perfil e grupo; a conta fica pendente até o convite', async () => {
    const { simulador, conector } = montar();
    const resultado = await conector.provisionar(contexto(paramsDocusign()));
    expect(resultado).toMatchObject({
      efeito: 'confirmado',
      etapa: 'criarUsuarioComPerfilEGrupo',
      referenciaExterna: 'docusign-1',
    });
    expect(simulador.usuario('maria.souza@exemplo.com.br')?.situacao).toBe('pendente');
  });

  it('resposta 2xx com erro interno é tratada como erro, sem efeito', async () => {
    const { simulador, conector } = montar();
    simulador.roteiro.programar('criarUsuario', 'erro2xx');
    expect(await conector.provisionar(contexto(paramsDocusign()))).toMatchObject({
      efeito: 'semEfeito',
      codigo: 'ERRO_INTERNO_2XX',
      etapa: null,
    });
    expect(simulador.usuario('maria.souza@exemplo.com.br')).toBeNull();
  });

  it('timeout é desconhecido; a conferência encontra o usuário criado sem confirmá-lo', async () => {
    const { simulador, conector } = montar();
    simulador.roteiro.programar('criarUsuario', 'timeout', { efeitoAplicado: true });
    expect((await conector.provisionar(contexto(paramsDocusign()))).efeito).toBe('desconhecido');
    const existencia = await conector.conferirExistencia(contexto(paramsDocusign()));
    expect(existencia).toMatchObject({
      contaExiste: true,
      etapaComprovada: 'criarUsuarioComPerfilEGrupo',
      acessosEncontrados: ['perfil:Remetente', 'grupo:Tecnologia'],
    });
    expect(avaliarExistencia(existencia, paramsDocusign()).situacao).toBe('completo');
  });

  it('não recria usuário existente e valida perfil e grupo', async () => {
    const { conector } = montar();
    await conector.provisionar(contexto(paramsDocusign()));
    expect(await conector.provisionar(contexto(paramsDocusign()))).toMatchObject({
      efeito: 'semEfeito',
      codigo: 'USUARIO_JA_EXISTE',
    });
    const validacao = await conector.validar(contexto(paramsDocusign({ perfil: 'X', grupo: 'Y' })));
    expect(validacao.impedimentos.map((i) => i.codigo)).toEqual([
      'USUARIO_JA_EXISTE',
      'PERFIL_INEXISTENTE',
      'GRUPO_INEXISTENTE',
    ]);
    expect(validacao.avisos.map((a) => a.codigo)).toEqual(['CONVITE_PENDENTE']);
  });

  it('revogar encerra o usuário (regra 5)', async () => {
    const { simulador, conector } = montar();
    expect(await conector.revogar(contextoRevogacao(paramsDocusign()))).toMatchObject({
      efeito: 'semEfeito',
      codigo: 'CONTA_AUSENTE',
    });
    await conector.provisionar(contexto(paramsDocusign()));
    expect(await conector.revogar(contextoRevogacao(paramsDocusign()))).toMatchObject({
      efeito: 'confirmado',
      etapa: 'encerrarUsuario',
    });
    expect(simulador.usuario('maria.souza@exemplo.com.br')?.situacao).toBe('encerrado');
    expect(await conector.revogar(contextoRevogacao(paramsDocusign()))).toMatchObject({
      codigo: 'JA_REVOGADO',
    });
    // Usuário encerrado não conta como conta existente.
    expect((await conector.conferirExistencia(contexto(paramsDocusign()))).contaExiste).toBe(false);
  });
});

describe('conector SoftExpert', () => {
  function montar() {
    const simulador = new SoftexpertSimulado({
      areas: CADASTROS.softexpert.areas,
      funcoes: CADASTROS.softexpert.funcoes,
      grupos: CADASTROS.softexpert.grupos,
    });
    return { simulador, conector: criarConectorSoftexpert(simulador, { modo: 'simulado' }) };
  }

  it('cria usuário com área, função e grupo de acesso', async () => {
    const { simulador, conector } = montar();
    expect(await conector.provisionar(contexto(paramsSoftexpert()))).toMatchObject({
      efeito: 'confirmado',
      etapa: 'criarUsuario',
      referenciaExterna: 'M1001',
    });
    expect(simulador.usuario('maria.souza')).toMatchObject({ ativo: true, area: 'Tecnologia' });
  });

  it('Fault dentro de 2xx é erro e cadastro inexistente não cria nada', async () => {
    const { simulador, conector } = montar();
    simulador.roteiro.programar('criarUsuario', 'erro2xx');
    expect(await conector.provisionar(contexto(paramsSoftexpert()))).toMatchObject({
      efeito: 'semEfeito',
      codigo: 'ERRO_INTERNO_2XX',
    });
    expect(
      await conector.provisionar(contexto(paramsSoftexpert({ area: 'Inexistente' }))),
    ).toMatchObject({ efeito: 'semEfeito', codigo: 'CADASTRO_INEXISTENTE' });
    expect(simulador.usuario('maria.souza')).toBeNull();
  });

  it('limite de taxa e timeout seguem a regra 3', async () => {
    const { simulador, conector } = montar();
    simulador.roteiro.programar('criarUsuario', 'limiteDeTaxa', { tentarAposMs: 7_000 });
    expect(await conector.provisionar(contexto(paramsSoftexpert()))).toMatchObject({
      efeito: 'semEfeito',
      transitorio: true,
      tentarAposMs: 7_000,
    });
    simulador.roteiro.programar('criarUsuario', 'timeout');
    expect(await conector.provisionar(contexto(paramsSoftexpert()))).toMatchObject({
      efeito: 'desconhecido',
      codigo: 'TIMEOUT',
    });
  });

  it('existir com cadastro diferente do pedido não comprova a etapa (regra 6)', async () => {
    const { simulador, conector } = montar();
    await conector.provisionar(contexto(paramsSoftexpert()));
    const diferente = await conector.conferirExistencia(
      contexto(paramsSoftexpert({ funcao: 'Gerente' })),
    );
    expect(diferente).toMatchObject({ contaExiste: true, etapaComprovada: null });
    expect(avaliarExistencia(diferente, paramsSoftexpert({ funcao: 'Gerente' })).situacao).toBe(
      'incompleto',
    );
    expect(simulador.usuario('maria.souza')?.ativo).toBe(true);
  });

  it('revogar inativa o usuário', async () => {
    const { simulador, conector } = montar();
    await conector.provisionar(contexto(paramsSoftexpert()));
    expect(await conector.revogar(contextoRevogacao(paramsSoftexpert()))).toMatchObject({
      efeito: 'confirmado',
      etapa: 'inativarUsuario',
    });
    expect(simulador.usuario('maria.souza')?.ativo).toBe(false);
    expect(await conector.revogar(contextoRevogacao(paramsSoftexpert()))).toMatchObject({
      codigo: 'JA_REVOGADO',
    });
  });

  it('validar lista usuário existente e cadastros inexistentes', async () => {
    const { conector } = montar();
    await conector.provisionar(contexto(paramsSoftexpert()));
    const validacao = await conector.validar(
      contexto(paramsSoftexpert({ area: 'A', funcao: 'F', grupoAcesso: 'G' })),
    );
    expect(validacao.impedimentos.map((i) => i.codigo)).toEqual([
      'USUARIO_JA_EXISTE',
      'AREA_INEXISTENTE',
      'FUNCAO_INEXISTENTE',
      'GRUPO_INEXISTENTE',
    ]);
  });
});

describe('conector Jira (destino)', () => {
  function montar() {
    const simulador = new JiraDestinoSimulado(CADASTROS.jira);
    return { simulador, conector: criarConectorJiraDestino(simulador, { modo: 'simulado' }) };
  }

  it('cria a conta pelo e-mail e adiciona aos grupos', async () => {
    const { simulador, conector } = montar();
    expect(await conector.provisionar(contexto(paramsJira()))).toMatchObject({
      efeito: 'confirmado',
      etapa: 'adicionarGrupos',
      referenciaExterna: 'jira-conta-1',
    });
    expect(simulador.usuario('maria.souza@exemplo.com.br')?.grupos).toEqual([
      'jira-software-users',
      'jira-ti',
    ]);
  });

  it('parcial: conta criada e grupo falhou; a retomada não recria a conta', async () => {
    const { simulador, conector } = montar();
    simulador.roteiro.aplicar('parcial');
    expect(await conector.provisionar(contexto(paramsJira()))).toMatchObject({
      efeito: 'parcial',
      etapa: 'criarConta',
    });
    expect(
      await conector.provisionar(contexto(paramsJira(), { etapaInicial: 'adicionarGrupos' })),
    ).toMatchObject({ efeito: 'confirmado', etapa: 'adicionarGrupos' });
    expect(simulador.roteiro.chamadas('criarUsuario')).toBe(1);
  });

  it('reaproveita conta que já existe em vez de recriar', async () => {
    const { simulador, conector } = montar();
    await conector.provisionar(contexto(paramsJira({ grupos: ['jira-ti'] })));
    await conector.provisionar(contexto(paramsJira()));
    expect(simulador.roteiro.chamadas('criarUsuario')).toBe(1);
    expect(simulador.usuario('maria.souza@exemplo.com.br')?.grupos).toEqual([
      'jira-ti',
      'jira-software-users',
    ]);
  });

  it('existir não é sucesso: conta sem todos os grupos é incompleta', async () => {
    const { conector } = montar();
    await conector.provisionar(contexto(paramsJira({ grupos: ['jira-ti'] })));
    const existencia = await conector.conferirExistencia(contexto(paramsJira()));
    expect(existencia.etapaComprovada).toBe('criarConta');
    expect(avaliarExistencia(existencia, paramsJira()).faltantes).toEqual([
      'grupo:jira-software-users',
    ]);
  });

  it('revogar remove dos grupos; já fora é sucesso; sem conta é falha', async () => {
    const { simulador, conector } = montar();
    expect(await conector.revogar(contextoRevogacao(paramsJira()))).toMatchObject({
      codigo: 'CONTA_AUSENTE',
    });
    await conector.provisionar(contexto(paramsJira()));
    expect(await conector.revogar(contextoRevogacao(paramsJira()))).toMatchObject({
      efeito: 'confirmado',
      etapa: 'removerGrupos',
    });
    expect(simulador.usuario('maria.souza@exemplo.com.br')?.grupos).toEqual([]);
    expect(await conector.revogar(contextoRevogacao(paramsJira()))).toMatchObject({
      codigo: 'JA_REVOGADO',
    });
  });

  it('validar avisa de conta existente e aponta grupo inexistente', async () => {
    const { conector } = montar();
    await conector.provisionar(contexto(paramsJira()));
    const validacao = await conector.validar(contexto(paramsJira({ grupos: ['grupo-x'] })));
    expect(validacao.avisos.map((a) => a.codigo)).toEqual(['USUARIO_JA_EXISTE']);
    expect(validacao.impedimentos.map((i) => i.codigo)).toEqual(['GRUPO_INEXISTENTE']);
  });
});
