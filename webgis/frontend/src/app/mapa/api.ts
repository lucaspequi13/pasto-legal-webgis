/**
 * Conversa com a API do WebGIS (webgis/api). O token do link vem do fragmento
 * da URL (#t=...): o "#" nunca sai do navegador, então não vai para log de servidor.
 */
import type { Geometry as GjGeometry } from 'geojson';
import { environment } from '../../environments/environment';

export interface FazendaApi {
  id: string;
  name: string | null;
  geometry: GjGeometry;
}

export interface PiqueteApi {
  id: string | null; // null = piquete novo, desenhado no mapa
  number: number;
  name: string | null;
  geometry: GjGeometry;
  area_ha?: number;
}

export interface AlfineteApi {
  id: string | null;
  kind: 'bebedouro' | 'outro';
  name: string | null;
  lon: number;
  lat: number;
}

export interface LinkApi {
  farm: FazendaApi;
  paddocks: PiqueteApi[];
  pins: AlfineteApi[];
  version: number;
  status: string;
  read_only: boolean;
  message: string | null;
}

export interface SalvoApi {
  version: number;
  paddocks: PiqueteApi[];
  pins: AlfineteApi[];
}

/** Erro da API com a mensagem em pt-BR que pode ir para a tela. */
export class ErroApi extends Error {
  constructor(
    readonly status: number,
    mensagem: string,
  ) {
    super(mensagem);
  }
}

/** Token do link, lido de "#t=..."; null = modo demonstração (fazenda de teste). */
export function tokenDaUrl(): string | null {
  const hash = window.location.hash.replace(/^#/, '');
  return new URLSearchParams(hash).get('t');
}

async function pedir<T>(caminho: string, init?: RequestInit): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(`${environment.apiUrl}${caminho}`, {
      ...init,
      headers: { 'Content-Type': 'application/json' },
      referrerPolicy: 'strict-origin',
    });
  } catch {
    throw new ErroApi(0, 'Sem conexão com o servidor.');
  }
  if (!resp.ok) {
    let msg = 'Algo deu errado. Tente de novo.';
    try {
      const corpo = await resp.json();
      if (typeof corpo?.detail === 'string') msg = corpo.detail;
    } catch {
      /* corpo sem JSON */
    }
    throw new ErroApi(resp.status, msg);
  }
  return (await resp.json()) as T;
}

export const api = {
  abrir: (token: string) => pedir<LinkApi>(`/links/${encodeURIComponent(token)}`),
  salvar: (token: string, corpo: { version: number; paddocks: PiqueteApi[]; pins: AlfineteApi[] }) =>
    pedir<SalvoApi>(`/links/${encodeURIComponent(token)}/draft`, { method: 'PUT', body: JSON.stringify(corpo) }),
  terminar: (token: string) =>
    pedir<{ status: string; notified: boolean }>(`/links/${encodeURIComponent(token)}/finish`, { method: 'POST' }),
};
