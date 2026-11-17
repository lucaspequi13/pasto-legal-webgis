import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, signal } from '@angular/core';
import OlMap from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import TileJSON from 'ol/source/TileJSON';
import { fromLonLat } from 'ol/proj';
import { environment } from '../../environments/environment';

// IDs do satélite no MapTiler, do mais novo para o mais antigo; usa o primeiro que existir.
const SATELITE_IDS = ['satellite-v2', 'satellite-v4', 'satellite'];
const tilejsonUrl = (id: string) =>
  `https://api.maptiler.com/tiles/${id}/tiles.json?key=${environment.maptilerKey}`;

@Component({
  selector: 'app-mapa',
  templateUrl: './mapa.html',
  styleUrl: './mapa.scss',
})
export class Mapa implements AfterViewInit, OnDestroy {
  @ViewChild('mapEl', { static: true }) mapEl!: ElementRef<HTMLDivElement>;
  private map?: OlMap;
  protected readonly aviso = signal<string | null>(null);

  ngAfterViewInit(): void {
    this.map = new OlMap({
      target: this.mapEl.nativeElement,
      layers: [],
      view: new View({ center: fromLonLat([-49.25, -16.68]), zoom: 14 }),
    });
    this.carregarSatelite();
  }

  private async carregarSatelite(): Promise<void> {
    const erros: string[] = [];
    for (const id of SATELITE_IDS) {
      try {
        const resp = await fetch(tilejsonUrl(id));
        if (!resp.ok) {
          erros.push(`${id}: ${resp.status}`);
          continue;
        }
        console.info(`[mapa] satélite carregado: ${id}`);
        this.map?.addLayer(
          new TileLayer({ source: new TileJSON({ url: tilejsonUrl(id), crossOrigin: 'anonymous' }) }),
        );
        return;
      } catch (e) {
        erros.push(`${id}: ${e}`);
      }
    }
    this.aviso.set(`MapTiler não respondeu (${erros.join(' · ')}). Confira a chave e as origens permitidas.`);
  }

  ngOnDestroy(): void {
    this.map?.setTarget(undefined);
  }
}
