import { avaliarExistencia, CODIGO_JA_REVOGADO } from '@gia/dominio';
import { describe, expect, it } from 'vitest';
import { AdSimulado } from '../simuladores/ad.js';
import {
  CADASTROS,
  CPF_MARIA,
  OU_INATIVOS,
  OU_PADRAO,
  contexto,
  contextoRevogacao,
  cpfFicticio,
  paramsAd,
} from '../teste/fabricas.js';
import { criarConectorAd } from './ad.js';

function montar(estado: ConstructorParameters<typeof AdSimulado>[0] = {}) {
  const simulador = new AdSimulado({ ...CADASTROS.ad, ...estado });
  const conector = criarConectorAd(simulador, { modo: 'simulado', ouInativos: OU_INATIVOS });
  return { simulador, conector };
}

describe('conector AD', () => {
  it('provisiona nas quatro etapas e devolve o objectGUID como referência', async () => {
    const { simulador, conector } = montar();
    const resultado = await conector.provisionar(contexto(paramsAd()));
    expect(resultado).toMatchObject({
      efeito: 'confirmado',
      modo: 'simulado',
      etapa: 'adicionarGrupos',
      codigo: 'OK',
      referenciaExterna: 'ad-guid-1',
      transitorio: false,
    });
    expect(simulador.conta('maria.souza')).toMatchObject({
      habilitada: true,
      grupos: ['GG-Tecnologia', 'GG-VPN'],
    });
  });

  it('cria a conta desabilitada e só habilita depois de definir a senha', async () => {
    const { simulador, conector } = montar();
    simulador.roteiro.programar('definirSenhaInicial', 'falha');
    const resultado = await conector.provisionar(contexto(paramsAd()));
    expect(resultado).toMatchObject({ efeito: 'parcial', etapa: 'criarContaDesabilitada' });
    expect(simulador.conta('maria.souza')?.habilitada).toBe(false);
    expect(simulador.roteiro.chamadas('habilitarConta')).toBe(0);
  });

  it('cenário parcial: grupo falha depois de conta criada e habilitada, e a retomada só faz o que falta', async () => {
    const { simulador, conector } = montar();
    simulador.roteiro.aplicar('parcial');
    const parcial = await conector.provisionar(contexto(paramsAd()));
    expect(parcial).toMatchObject({
      efeito: 'parcial',
      etapa: 'habilitarConta',
      transitorio: false,
    });

    const retomada = await conector.provisionar(
      contexto(paramsAd(), { etapaInicial: 'adicionarGrupos' }),
    );
    expect(retomada).toMatchObject({ efeito: 'confirmado', etapa: 'adicionarGrupos' });
    expect(simulador.roteiro.chamadas('criarContaDesabilitada')).toBe(1);
    expect(simulador.roteiro.chamadas('habilitarConta')).toBe(1);
  });

  it('cenário de falha: nada é criado e o efeito é semEfeito', async () => {
    const { simulador, conector } = montar();
    simulador.roteiro.aplicar('falha');
    const resultado = await conector.provisionar(contexto(paramsAd()));
    expect(resultado).toMatchObject({
      efeito: 'semEfeito',
      etapa: null,
      codigo: 'RECUSADO_PELO_FORNECEDOR',
    });
    expect(simulador.conta('maria.souza')).toBeNull();
  });

  it('timeout é resultado desconhecido, mesmo quando o destino chegou a criar a conta (regra 3)', async () => {
    const { simulador, conector } = montar();
    simulador.roteiro.programar('criarContaDesabilitada', 'timeout', { efeitoAplicado: true });
    const resultado = await conector.provisionar(contexto(paramsAd()));
    expect(resultado).toMatchObject({ efeito: 'desconhecido', codigo: 'TIMEOUT', etapa: null });
    expect(simulador.conta('maria.souza')).not.toBeNull();

    // A conferência enxerga o que o destino fez, sem marcar sucesso.
    const existencia = await conector.conferirExistencia(contexto(paramsAd()));
    expect(existencia).toMatchObject({
      contaExiste: true,
      etapaComprovada: 'criarContaDesabilitada',
    });
    expect(avaliarExistencia(existencia, paramsAd()).situacao).toBe('incompleto');
  });

  it('resposta perdida também é desconhecida e mantém a etapa já concluída', async () => {
    const { simulador, conector } = montar();
    simulador.roteiro.programar('habilitarConta', 'respostaPerdida');
    const resultado = await conector.provisionar(contexto(paramsAd()));
    expect(resultado).toMatchObject({
      efeito: 'desconhecido',
      codigo: 'RESPOSTA_PERDIDA',
      etapa: 'definirSenha',
    });
  });

  it('limite de taxa: sem efeito, transitório e com Retry-After', async () => {
    const { simulador, conector } = montar();
    simulador.roteiro.aplicar('limiteDeTaxa');
    const resultado = await conector.provisionar(contexto(paramsAd()));
    expect(resultado).toMatchObject({
      efeito: 'semEfeito',
      codigo: 'LIMITE_DE_TAXA',
      transitorio: true,
      tentarAposMs: 2_000,
    });
  });

  it('conexão recusada: sem efeito e transitória', async () => {
    const { simulador, conector } = montar();
    simulador.roteiro.programar('criarContaDesabilitada', 'conexaoRecusada');
    expect(await conector.provisionar(contexto(paramsAd()))).toMatchObject({
      efeito: 'semEfeito',
      codigo: 'CONEXAO_RECUSADA',
      transitorio: true,
    });
  });

  it('recusa etapa de retomada de outro sistema e parâmetros de outro sistema', async () => {
    const { conector } = montar();
    expect(
      await conector.provisionar(contexto(paramsAd(), { etapaInicial: 'criarUsuario' })),
    ).toMatchObject({ efeito: 'semEfeito', codigo: 'ETAPA_INICIAL_INVALIDA' });
    expect(
      await conector.provisionar(contexto({ ...paramsAd(), sistema: 'jira' } as never)),
    ).toMatchObject({ efeito: 'semEfeito', codigo: 'PARAMETROS_INCOMPATIVEIS' });
  });

  describe('revogar (regra 5)', () => {
    it('desabilita e move para a OU de inativos', async () => {
      const { simulador, conector } = montar();
      await conector.provisionar(contexto(paramsAd()));
      const resultado = await conector.revogar(contextoRevogacao(paramsAd()));
      expect(resultado).toMatchObject({ efeito: 'confirmado', etapa: 'moverParaOuInativos' });
      expect(simulador.conta('maria.souza')).toMatchObject({ habilitada: false, ou: OU_INATIVOS });
    });

    it('conta ausente é falha', async () => {
      const { conector } = montar();
      expect(await conector.revogar(contextoRevogacao(paramsAd()))).toMatchObject({
        efeito: 'semEfeito',
        codigo: 'CONTA_AUSENTE',
      });
    });

    it('acesso já revogado é sucesso e não escreve nada', async () => {
      const { simulador, conector } = montar();
      await conector.provisionar(contexto(paramsAd()));
      await conector.revogar(contextoRevogacao(paramsAd()));
      const antes = simulador.roteiro.chamadas('desabilitarConta');
      const segunda = await conector.revogar(contextoRevogacao(paramsAd()));
      expect(segunda).toMatchObject({ efeito: 'confirmado', codigo: CODIGO_JA_REVOGADO });
      expect(simulador.roteiro.chamadas('desabilitarConta')).toBe(antes);
    });

    it('falha ao mover deixa a revogação parcial, retomável do ponto certo', async () => {
      const { simulador, conector } = montar();
      await conector.provisionar(contexto(paramsAd()));
      simulador.roteiro.programar('moverParaOu', 'falha');
      const parcial = await conector.revogar(contextoRevogacao(paramsAd()));
      expect(parcial).toMatchObject({ efeito: 'parcial', etapa: 'desabilitarConta' });
      const retomada = await conector.revogar(
        contextoRevogacao(paramsAd(), { etapaInicial: 'moverParaOuInativos' }),
      );
      expect(retomada).toMatchObject({ efeito: 'confirmado', etapa: 'moverParaOuInativos' });
    });
  });

  describe('conferirExistencia (regra 6)', () => {
    it('conta ausente', async () => {
      const { conector } = montar();
      const existencia = await conector.conferirExistencia(contexto(paramsAd()));
      expect(existencia).toMatchObject({ contaExiste: false, etapaComprovada: null });
      expect(avaliarExistencia(existencia, paramsAd()).situacao).toBe('ausente');
    });

    it('existir não é sucesso: conta sem todos os grupos é incompleta', async () => {
      const { conector } = montar({
        contas: [
          {
            guid: 'g-1',
            login: 'maria.souza',
            cpf: CPF_MARIA,
            email: 'maria.souza@exemplo.com.br',
            habilitada: true,
            ou: OU_PADRAO,
            grupos: ['GG-Tecnologia'],
          },
        ],
      });
      const existencia = await conector.conferirExistencia(contexto(paramsAd()));
      expect(existencia).toMatchObject({
        contaExiste: true,
        etapaComprovada: 'habilitarConta',
        referenciaExterna: 'g-1',
      });
      const avaliacao = avaliarExistencia(existencia, paramsAd());
      expect(avaliacao).toEqual({ situacao: 'incompleto', faltantes: ['grupo:gg-vpn'] });
    });

    it('conta completa comprova a última etapa', async () => {
      const { conector } = montar();
      await conector.provisionar(contexto(paramsAd()));
      const existencia = await conector.conferirExistencia(contexto(paramsAd()));
      expect(existencia.etapaComprovada).toBe('adicionarGrupos');
      expect(avaliarExistencia(existencia, paramsAd()).situacao).toBe('completo');
    });

    it('é leitura: falha técnica é lançada para o worker retentar', async () => {
      const { simulador, conector } = montar();
      simulador.roteiro.programar('buscarConta', 'conexaoRecusada');
      await expect(conector.conferirExistencia(contexto(paramsAd()))).rejects.toMatchObject({
        tipo: 'conexaoRecusada',
      });
    });
  });

  describe('validar', () => {
    it('conta nova com OU e grupos existentes não tem impedimentos', async () => {
      const { simulador, conector } = montar();
      const validacao = await conector.validar(contexto(paramsAd()));
      expect(validacao).toEqual({ modo: 'simulado', impedimentos: [], avisos: [] });
      expect(simulador.conta('maria.souza')).toBeNull();
    });

    it('login em uso por outra pessoa e e-mail em uso por outra conta são impedimentos', async () => {
      const outra = {
        guid: 'g-9',
        login: 'maria.souza',
        cpf: cpfFicticio('900000009'),
        email: 'maria.souza@exemplo.com.br',
        habilitada: true,
        ou: OU_PADRAO,
        grupos: [],
      };
      const { conector } = montar({ contas: [outra] });
      const validacao = await conector.validar(contexto(paramsAd()));
      expect(validacao.impedimentos.map((i) => i.codigo)).toEqual(['LOGIN_EM_USO']);

      const { conector: outro } = montar({ contas: [{ ...outra, login: 'msouza' }] });
      const comEmail = await outro.validar(contexto(paramsAd()));
      expect(comEmail.impedimentos.map((i) => i.codigo)).toEqual(['EMAIL_EM_USO']);
    });

    it('mesmo titular vira aviso; OU e grupo inexistentes viram impedimentos', async () => {
      const { conector } = montar({
        contas: [
          {
            guid: 'g-1',
            login: 'maria.souza',
            cpf: CPF_MARIA,
            email: 'maria.souza@exemplo.com.br',
            habilitada: true,
            ou: OU_PADRAO,
            grupos: [],
          },
        ],
      });
      const validacao = await conector.validar(
        contexto(paramsAd({ ou: 'OU=Inexistente', grupos: ['GG-Nao-Existe'] })),
      );
      expect(validacao.avisos.map((a) => a.codigo)).toEqual(['CONTA_JA_EXISTE_DO_MESMO_TITULAR']);
      expect(validacao.impedimentos.map((i) => i.codigo)).toEqual([
        'OU_INEXISTENTE',
        'GRUPO_INEXISTENTE',
      ]);
    });
  });

  it('testarConexao informa disponibilidade e o código da falha', async () => {
    const { simulador, conector } = montar();
    expect(await conector.testarConexao()).toEqual({
      modo: 'simulado',
      disponivel: true,
      codigo: 'OK',
      mensagem: 'Conexão estabelecida.',
    });
    simulador.roteiro.programar('testar', 'conexaoRecusada');
    expect(await conector.testarConexao()).toMatchObject({
      disponivel: false,
      codigo: 'CONEXAO_RECUSADA',
    });
  });
});
