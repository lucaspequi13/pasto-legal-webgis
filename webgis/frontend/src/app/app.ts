import { Component } from '@angular/core';
import { Mapa } from './mapa/mapa';

@Component({
  selector: 'app-root',
  imports: [Mapa],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {}
