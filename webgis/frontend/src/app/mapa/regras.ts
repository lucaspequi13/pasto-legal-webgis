/**
 * Regras de desenho do WebGIS (DDS #171, seção 2), em coordenadas geográficas (EPSG:4326).
 *
 * - Cerca: abaixo de 10% fora, o traço volta ao limite; a partir de 10%, o desenho é recusado.
 * - Sobreposição: as partes viram piquetes menores ("fatias de pizza").
 *
 * Funções puras com Turf.js: sem OpenLayers e sem Angular, para testar e levar para a API depois.
 */
import type { Feature, MultiPolygon, Point, Polygon } from 'geojson';
import {
  area,
  booleanPointInPolygon,
  difference,
  featureCollection,
  intersect,
  kinks,
  polygon,
  union,
  unkinkPolygon,
} from '@turf/turf';

export type Poligono = Feature<Polygon | MultiPolygon>;

/** Pedaços menores que isso (m²) são ruído de arredondamento/snap e são ignorados. */
export const AREA_MINIMA_M2 = 1;
/** Fração máxima fora da cerca que ainda é corrigida automaticamente. */
export const LIMITE_FORA = 0.1;

function valido(p: Poligono | null): Poligono | null {
  return p && area(p) >= AREA_MINIMA_M2 ? p : null;
}

/** Parte em comum entre A e B (ou null se não houver área). */
export function interseccao(a: Poligono, b: Poligono): Poligono | null {
  return valido(intersect(featureCollection([a, b])) as Poligono | null);
}

/** A sem a parte de B (ou null se não sobrar área). */
export function diferenca(a: Poligono, b: Poligono): Poligono | null {
  return valido(difference(featureCollection([a, b])) as Poligono | null);
}

/** Quebra em polígonos simples, do maior para o menor, descartando ruído. */
export function partes(p: Poligono): Poligono[] {
  const lista: Poligono[] =
    p.geometry.type === 'Polygon'
      ? [p]
      : p.geometry.coordinates.map((c) => polygon(c) as Poligono);
  return lista.filter((x) => area(x) >= AREA_MINIMA_M2).sort((a, b) => area(b) - area(a));
}

/**
 * Traço que cruza a si mesmo (estrela, "gravata") tem área quase zero para o Turf,
 * e aí a regra da cerca erra feio. Aqui ele é desfeito nas partes reais e unido de novo.
 * Polígono normal volta igual.
 */
export function consertar(p: Poligono): Poligono {
  if (p.geometry.type !== 'Polygon' || kinks(p as Feature<Polygon>).features.length === 0) return p;
  const pedacos = unkinkPolygon(p as Feature<Polygon>);
  return (union(pedacos) as Poligono | null) ?? p;
}

export type ResultadoCerca =
  | { tipo: 'ok'; geom: Poligono; ajustado: boolean }
  | { tipo: 'recusado'; fracaoFora: number };

/** Aplica a regra da cerca a um piquete desenhado ou editado. */
export function aplicarCerca(original: Poligono, cerca: Poligono): ResultadoCerca {
  const piquete = consertar(original);
  const total = area(piquete);
  const dentro = interseccao(piquete, cerca);
  if (!dentro) return { tipo: 'recusado', fracaoFora: 1 };
  const fora = Math.max(0, 1 - area(dentro) / total);
  if (fora >= LIMITE_FORA) return { tipo: 'recusado', fracaoFora: fora };
  const ajustado = fora > 0.0005; // > 0,05%: houve corte de verdade
  // Traço consertado também conta como ajustado, para o mapa redesenhar a forma real.
  return { tipo: 'ok', geom: ajustado ? dentro : piquete, ajustado: ajustado || piquete !== original };
}

/** Alfinete precisa estar dentro da fazenda. */
export function pontoDentro(ponto: Feature<Point>, cerca: Poligono): boolean {
  return booleanPointInPolygon(ponto, cerca);
}

export function areaHa(p: Poligono): number {
  return area(p) / 10_000;
}
