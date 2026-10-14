import { avaliarExistencia, decidirProximoPasso, POLITICA_EXECUCAO_PADRAO } from '@gia/dominio';
import { describe, expect, it } from 'vitest';
import { GraphSimulado } from '../simuladores/m365.js';
import { CADASTROS, contexto, contextoRevogacao, paramsM365 } from '../teste/fabricas.js';
import { criarConectorM365 } from './m365.js';

function montar(sincronizado = true) {
  const simulador = new GraphSimulado(CADASTROS.m365);
  if (sincronizado) simulador.sincronizarIdentidade('maria.souza@exemplo.com.br');
  return { simulador, conector: criarConectorM365(simulador, { modo: 'simulado' }) };
}

describe('conector M365', () => {
  it('licencia a identidade sincronizada: país, licenças e grupo', async () => {
    const { simulador, conector } = montar();
    const resultado = await conector.provisionar(contexto(paramsM365()));
    expect(resultado).toMatchObject({
      efeito: 'confirmado',
      etapa: 'adicionarGrupo',
      referenciaExterna: 'entra-1',
    });
    expect(simulador.usuario('maria.souza@exemplo.com.br')).toMatchObject({
      paisUso: 'BR',
      licencas: ['E3', 'EMS'],
      grupos: ['M365-Tecnologia'],
    });
  });

  it('regra 7: sem identidade sincronizada não cria usuário e pede para aguardar', async () => {
    const { simulador, conector } = montar(false);
    const resultado = await conector.provisionar(contexto(paramsM365()));
    expect(resultado).toMatchObject({
      efeito: 'semEfeito',
      codigo: 'IDENTIDADE_NAO_SINCRONIZADA',
      etapa: null,
      transitorio: true,
    });
    expect(simulador.usuario('maria.souza@exemplo.com.br')).toBeNull();
    expect(simulador.roteiro.chamadas('definirPaisDeUso')).toBe(0);
    // O executor espera a sincronização em vez de tentar de novo na hora.
    expect(
      decidirProximoPasso(
        { acao: 'provisionar', modo: 'simulado', resultado, tentativas: 1 },
        POLITICA_EXECUCAO_PADRAO,
      ),
    ).toEqual({
      tipo: 'aguardarDependencia',
      aguardarMs: POLITICA_EXECUCAO_PADRAO.esperaSincronizacaoM365Ms,
    });

    simulador.sincronizarIdentidade('maria.souza@exemplo.com.br');
    expect((await conector.provisionar(contexto(paramsM365()))).efeito).toBe('confirmado');
  });

  it('só atribui as licenças que faltam', async () => {
    const simulador = new GraphSimulado({
      ...CADASTROS.m365,
      usuarios: [
        {
          upn: 'maria.souza@exemplo.com.br',
          id: 'entra-x',
          paisUso: 'BR',
          licencas: ['E3'],
          grupos: [],
        },
      ],
    });
    const conector = criarConectorM365(simulador, { modo: 'simulado' });
    await conector.provisionar(contexto(paramsM365()));
    expect(simulador.usuario('maria.souza@exemplo.com.br')?.licencas).toEqual(['E3', 'EMS']);
  });

  it('licença com plano inexistente deixa o item parcial no país definido', async () => {
    const { conector } = montar();
    const resultado = await conector.provisionar(
      contexto(paramsM365({ planosLicenca: ['PLANO-FANTASMA'] })),
    );
    expect(resultado).toMatchObject({
      efeito: 'parcial',
      etapa: 'definirPais',
      codigo: 'PLANO_INEXISTENTE',
    });
  });

  it('timeout ao licenciar é desconhecido e a conferência mostra até onde foi', async () => {
    const { simulador, conector } = montar();
    simulador.roteiro.programar('atribuirLicencas', 'timeout', { efeitoAplicado: true });
    expect(await conector.provisionar(contexto(paramsM365()))).toMatchObject({
      efeito: 'desconhecido',
      etapa: 'definirPais',
    });
    const existencia = await conector.conferirExistencia(contexto(paramsM365()));
    expect(existencia.etapaComprovada).toBe('atribuirLicencas');
    expect(avaliarExistencia(existencia, paramsM365()).faltantes).toEqual([
      'grupo:m365-tecnologia',
    ]);
  });

  it('retoma a partir do grupo sem repetir licenças', async () => {
    const { simulador, conector } = montar();
    simulador.roteiro.aplicar('parcial');
    const parcial = await conector.provisionar(contexto(paramsM365()));
    expect(parcial).toMatchObject({ efeito: 'parcial', etapa: 'atribuirLicencas' });
    const retomada = await conector.provisionar(
      contexto(paramsM365(), { etapaInicial: 'adicionarGrupo' }),
    );
    expect(retomada).toMatchObject({ efeito: 'confirmado', etapa: 'adicionarGrupo' });
    expect(simulador.roteiro.chamadas('atribuirLicencas')).toBe(1);
  });

  it('sem grupo configurado a última etapa é concluída sem chamar o Graph', async () => {
    const { simulador, conector } = montar();
    const resultado = await conector.provisionar(contexto(paramsM365({ grupo: null })));
    expect(resultado).toMatchObject({ efeito: 'confirmado', etapa: 'adicionarGrupo' });
    expect(simulador.roteiro.chamadas('adicionarAoGrupo')).toBe(0);
  });

  it('revogar remove as licenças; sem licença ativa já está revogado; sem usuário é falha', async () => {
    const { simulador, conector } = montar();
    await conector.provisionar(contexto(paramsM365()));
    expect(await conector.revogar(contextoRevogacao(paramsM365()))).toMatchObject({
      efeito: 'confirmado',
      etapa: 'removerLicencas',
    });
    expect(simulador.usuario('maria.souza@exemplo.com.br')?.licencas).toEqual([]);
    expect(await conector.revogar(contextoRevogacao(paramsM365()))).toMatchObject({
      efeito: 'confirmado',
      codigo: 'JA_REVOGADO',
    });
    const { conector: vazio } = montar(false);
    expect(await vazio.revogar(contextoRevogacao(paramsM365()))).toMatchObject({
      efeito: 'semEfeito',
      codigo: 'CONTA_AUSENTE',
    });
  });

  it('existir não é sucesso: identidade sincronizada sem licenças é incompleta', async () => {
    const { conector } = montar();
    const existencia = await conector.conferirExistencia(contexto(paramsM365()));
    expect(existencia).toMatchObject({
      contaExiste: true,
      etapaComprovada: 'aguardarIdentidadeSincronizada',
    });
    expect(avaliarExistencia(existencia, paramsM365()).situacao).toBe('incompleto');
  });

  it('validar avisa da identidade ainda não sincronizada e aponta plano ou grupo inexistente', async () => {
    const { conector } = montar(false);
    const validacao = await conector.validar(
      contexto(paramsM365({ planosLicenca: ['E3', 'XPTO'], grupo: 'Nao-Existe' })),
    );
    expect(validacao.avisos.map((a) => a.codigo)).toEqual(['IDENTIDADE_NAO_SINCRONIZADA']);
    expect(validacao.impedimentos.map((i) => i.codigo)).toEqual([
      'PLANO_INEXISTENTE',
      'GRUPO_INEXISTENTE',
    ]);
  });

  it('validar que não consegue consultar avisa sem bloquear', async () => {
    const { simulador, conector } = montar();
    simulador.roteiro.programar('buscarUsuario', 'conexaoRecusada');
    const validacao = await conector.validar(contexto(paramsM365()));
    expect(validacao.impedimentos).toEqual([]);
    expect(validacao.avisos.map((a) => a.codigo)).toEqual(['VALIDACAO_INDISPONIVEL']);
  });
});
