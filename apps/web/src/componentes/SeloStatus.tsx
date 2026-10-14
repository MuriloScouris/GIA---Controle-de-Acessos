const CLASSE_DO_TOM = { neutro: 'neutral', ok: 'ok', aviso: 'warn', erro: 'danger' } as const;

/** Estado sempre com ponto e texto (não depende só de cor). */
export function SeloStatus({
  rotulo,
  tom,
}: {
  rotulo: string;
  tom: 'neutro' | 'ok' | 'aviso' | 'erro';
}) {
  return <span className={`badge-soft ${CLASSE_DO_TOM[tom]}`}>{rotulo}</span>;
}

export function tomDoStatusPedido(status: string): 'neutro' | 'ok' | 'aviso' | 'erro' {
  if (status === 'concluido') return 'ok';
  if (status === 'concluidoComErros') return 'erro';
  if (status === 'rejeitado') return 'neutro';
  return 'aviso';
}

export function tomDoStatusItem(status: string): 'neutro' | 'ok' | 'aviso' | 'erro' {
  if (status === 'confirmado' || status === 'registradoManual') return 'ok';
  if (status === 'falhou' || status === 'parcial' || status === 'desconhecido') return 'erro';
  if (status === 'pendente') return 'neutro';
  return 'aviso';
}
