import { comandos, requisitos, sistemas, type Requisito } from './catalogo.js';
import { conferirContexto, digest, preflightSchema, registroSchema, sha } from './evidencias.js';

export interface Entrada {
  readonly revisao: string;
  readonly preflight?: { readonly dados: unknown; readonly sha256: string };
  readonly registro?: { readonly dados: unknown; readonly sha256: string };
}

/** Avalia evidencias locais; nao chama rede, fila, clientes, ambiente ou SDKs externos. */
export function montarMatriz(entrada: Entrada, agora = new Date()) {
  const revisao = sha.parse(entrada.revisao);
  if (entrada.preflight) digest.parse(entrada.preflight.sha256);
  if (entrada.registro) digest.parse(entrada.registro.sha256);
  const preflight = entrada.preflight ? preflightSchema.parse(entrada.preflight.dados) : undefined;
  const registro = entrada.registro ? registroSchema.parse(entrada.registro.dados) : undefined;
  if (preflight) conferirContexto(preflight, revisao, agora);
  if (registro) {
    conferirContexto(registro, revisao, agora);
    for (const item of registro.itens)
      if (item.evidencia) {
        conferirContexto({ revisao, geradoEm: item.evidencia.ocorridoEm }, revisao, agora);
        if (Date.parse(item.evidencia.ocorridoEm) > Date.parse(registro.geradoEm))
          throw new Error('REGISTRO_INCONSISTENTE');
      }
  }
  const contextoSeguro =
    !!preflight &&
    preflight.ambiente === 'producao' &&
    preflight.gatesObservados.configuracao === 'desligada' &&
    preflight.gatesObservados.api === 'desligada' &&
    !preflight.checks.some((c) => c.estado === 'bloqueado');
  function conferir(r: Requisito) {
    if (!preflight || !r.checks || !contextoSeguro) return false;
    const checks =
      r.sistema === 'global'
        ? preflight.checks
        : (preflight.sistemas.find((s) => s.sistema === r.sistema)?.checks ?? []);
    if (!r.checks.every((nome) => checks.some((c) => c.nome === nome))) return false;
    const selecionados = checks.filter((c) => r.checks!.includes(c.nome));
    if (!selecionados.every((c) => c.estado === 'ok' && c.codigo === 'OK')) return false;
    if (r.etapa === 'redeCa') {
      const destinos = new Set(selecionados.map((c) => c.destino));
      if (destinos.has(undefined) || destinos.has(0)) return false;
      if (
        ![...destinos].every((destino) =>
          ['dns', 'tcp', 'tls'].every((nome) =>
            selecionados.some((c) => c.destino === destino && c.nome === nome),
          ),
        )
      )
        return false;
    }
    return true;
  }
  const itens = requisitos.map((r) => {
    const declaracao = registro?.itens.find((i) => i.id === r.id);
    const leituraComprovada = conferir(r);
    const checks =
      r.sistema === 'global'
        ? preflight?.checks
        : preflight?.sistemas.find((s) => s.sistema === r.sistema)?.checks;
    const bloqueioLeitura =
      !!r.checks &&
      (!!checks?.some((c) => r.checks!.includes(c.nome) && c.estado === 'bloqueado') ||
        preflight?.gatesObservados.configuracao === 'insegura' ||
        preflight?.gatesObservados.api === 'ligada');
    const estado =
      declaracao?.estado === 'bloqueado' || bloqueioLeitura
        ? 'bloqueado'
        : leituraComprovada
          ? 'leituraComprovada'
          : declaracao?.estado === 'declarado'
            ? 'declaracaoPendenteDeValidacao'
            : 'pendente';
    return {
      ...r,
      comandos: r.comandos.map((id) => comandos[id]),
      implementacao: r.implementacao.map(
        (n) => `https://github.com/MuriloScouris/GIA---Controle-de-Acessos/pull/${n}`,
      ),
      responsavelConfirmado: declaracao?.responsavelConfirmado ?? false,
      estado,
      pronto: false as const,
      evidenciaLeitura: leituraComprovada
        ? { execucaoId: preflight!.execucaoId, sha256: entrada.preflight!.sha256 }
        : null,
      evidenciaDeclarada: declaracao?.evidencia ?? null,
      validacaoAdministrativa: 'pendente' as const,
    };
  });
  const leiturasConsolidadas =
    contextoSeguro &&
    preflight?.leiturasValidadas === true &&
    preflight.codigoSaida === 2 &&
    !preflight.sistemas.some((s) => s.checks.some((c) => c.estado === 'bloqueado')) &&
    itens.filter((i) => i.checks).every((i) => i.estado === 'leituraComprovada');
  return {
    schema: 'gia.prontidao.v1' as const,
    geradoEm: agora.toISOString(),
    revisao,
    somenteLeitura: true as const,
    escritaHabilitada: false as const,
    producaoPronta: false as const,
    decisao: 'NO_GO' as const,
    leiturasConsolidadas,
    gatesObservados: preflight?.gatesObservados ?? null,
    codigoSaida: leiturasConsolidadas ? (2 as const) : (1 as const),
    motivo: 'DECISAO_ADMINISTRATIVA_E_ENSAIO_REAL_NAO_VALIDADOS' as const,
    fontes: {
      preflight: entrada.preflight?.sha256 ?? null,
      registro: entrada.registro?.sha256 ?? null,
    },
    sistemas: sistemas.map((sistema) => ({
      sistema,
      itens: itens.filter((i) => i.sistema === sistema),
    })),
  };
}
