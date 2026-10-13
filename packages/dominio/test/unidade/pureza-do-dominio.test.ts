import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const raiz = fileURLToPath(new URL('../../src', import.meta.url));

function arquivosTs(diretorio: string): string[] {
  return readdirSync(diretorio, { withFileTypes: true }).flatMap((entrada) => {
    const caminho = join(diretorio, entrada.name);
    if (entrada.isDirectory()) return arquivosTs(caminho);
    return entrada.name.endsWith('.ts') ? [caminho] : [];
  });
}

const fontes = arquivosTs(raiz).map((caminho) => ({
  arquivo: relative(raiz, caminho),
  codigo: readFileSync(caminho, 'utf8'),
}));

describe('Domínio sem banco, rede, conectores ou framework', () => {
  it('encontra os fontes', () => {
    expect(fontes.length).toBeGreaterThan(10);
  });

  it('só importa arquivos do próprio pacote', () => {
    const externos = fontes.flatMap(({ arquivo, codigo }) =>
      [...codigo.matchAll(/(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/g)]
        .map((match) => match[1]!)
        .filter(
          (especificador) => !especificador.startsWith('./') && !especificador.startsWith('../'),
        )
        .map((especificador) => `${arquivo}: ${especificador}`),
    );
    expect(externos).toEqual([]);
  });

  it('não usa relógio, aleatoriedade, rede, processo ou agendamento', () => {
    const proibidos = [
      /\bDate\.now\(/,
      /new Date\(\)/,
      /Math\.random\(/,
      /\bfetch\(/,
      /\bprocess\./,
      /\bsetTimeout\(/,
      /\bsetInterval\(/,
      /\brequire\(/,
    ];
    const violacoes = fontes.flatMap(({ arquivo, codigo }) =>
      proibidos
        .filter((padrao) => padrao.test(codigo))
        .map((padrao) => `${arquivo}: ${padrao.source}`),
    );
    expect(violacoes).toEqual([]);
  });
});
