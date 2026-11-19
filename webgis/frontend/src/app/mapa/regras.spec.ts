/**
 * Regras de desenho do WebGIS (decisões de 06/11 e 19/11). Cada caso aqui é uma
 * decisão: se alguém mudar regras.ts e quebrar uma delas, o teste avisa qual.
 */
import { area, point, polygon } from '@turf/turf';
import { LASCA_M2, aplicarCerca, consertar, pontoDentro, resolverSobreposicao } from './regras';

// ~0,001° ≈ 110 m perto de Goiás. Fazenda de ~1,1 km x 1,1 km.
const d = 0.001;
const quadrado = (x0: number, y0: number, x1: number, y1: number) =>
  polygon([[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]);
const ha = (p: { geometry: unknown } | null) => (p ? area(p as never) / 10_000 : 0);

const cerca = quadrado(-49.3, -16.7, -49.3 + 10 * d, -16.7 + 10 * d);
const x = (n: number) => -49.3 + n * d;
const y = (n: number) => -16.7 + n * d;

describe('cerca', () => {
  it('desenho dentro da cerca é aceito sem corte', () => {
    const r = aplicarCerca(quadrado(x(1), y(1), x(3), y(3)), cerca);
    expect(r.tipo).toBe('ok');
    if (r.tipo === 'ok') expect(r.ajustado).toBe(false);
  });

  it('menos de 10% fora: aceito e cortado no limite', () => {
    const r = aplicarCerca(quadrado(x(8), y(1), x(10.15), y(3)), cerca); // ~7% fora
    expect(r.tipo).toBe('ok');
    if (r.tipo === 'ok') {
      expect(r.ajustado).toBe(true);
      expect(ha(r.geom)).toBeLessThan(ha(quadrado(x(8), y(1), x(10.15), y(3))));
    }
  });

  it('10% ou mais fora: recusado', () => {
    const r = aplicarCerca(quadrado(x(8), y(1), x(13), y(3)), cerca); // 60% fora
    expect(r.tipo).toBe('recusado');
  });
});

describe('traço que cruza a si mesmo', () => {
  it('gravata dentro da cerca não conta como fora (bug de 19/11)', () => {
    const gravata = polygon([[[x(1), y(1)], [x(5), y(5)], [x(5), y(1)], [x(1), y(5)], [x(1), y(1)]]]);
    const r = aplicarCerca(gravata, cerca);
    expect(r.tipo).toBe('ok');
    if (r.tipo === 'ok') expect(r.geom.geometry.type).toBe('MultiPolygon'); // virou 2 triângulos
  });

  it('polígono normal volta igual', () => {
    const p = quadrado(x(1), y(1), x(2), y(2));
    expect(consertar(p)).toBe(p);
  });
});

describe('sobreposição: o piquete que já existia manda (19/11)', () => {
  const antigo = quadrado(x(0), y(0), x(5), y(5));

  it('sem encostar: nada muda', () => {
    const r = resolverSobreposicao(quadrado(x(6), y(6), x(8), y(8)), antigo);
    expect(r.tipo).toBe('nada');
  });

  it('encostou numa ponta: a ponta fica com o antigo, nenhum piquete novo', () => {
    const novo = quadrado(x(4.5), y(1), x(9), y(3));
    const r = resolverSobreposicao(novo, antigo);
    expect(r.tipo).toBe('antigo');
    expect(r.novos).toHaveLength(0);
    expect(ha(r.vizinho)).toBeCloseTo(ha(antigo), 3); // o antigo não perdeu nada
    expect(ha(r.novo)).toBeLessThan(ha(novo)); // o novo ficou só com o que sobra
  });

  it('cruzou metade: o antigo continua inteiro', () => {
    const r = resolverSobreposicao(quadrado(x(2.5), y(-1), x(8), y(6)), antigo);
    expect(r.tipo).toBe('antigo');
    expect(ha(r.vizinho)).toBeCloseTo(ha(antigo), 3);
  });

  it('desenho inteiro dentro de um piquete: divide esse piquete', () => {
    const dentro = quadrado(x(1), y(1), x(3), y(3));
    const r = resolverSobreposicao(dentro, antigo);
    expect(r.tipo).toBe('dividiu');
    expect(r.novo).toBeNull();
    expect(r.novos).toHaveLength(1);
    expect(ha(r.novos[0])).toBeCloseTo(ha(dentro), 3);
    expect(ha(r.vizinho)).toBeCloseTo(ha(antigo) - ha(dentro), 2);
  });

  it('lasca menor que ~0,05 ha nunca vira piquete', () => {
    const lasca = quadrado(x(1), y(1), x(1.15), y(1.15)); // ~0,027 ha
    expect(area(lasca)).toBeLessThan(LASCA_M2);
    const r = resolverSobreposicao(lasca, antigo);
    expect(r.novos).toHaveLength(0);
  });
});

describe('alfinete', () => {
  it('dentro da fazenda é aceito; fora é recusado', () => {
    expect(pontoDentro(point([x(5), y(5)]), cerca)).toBe(true);
    expect(pontoDentro(point([x(20), y(20)]), cerca)).toBe(false);
  });
});
