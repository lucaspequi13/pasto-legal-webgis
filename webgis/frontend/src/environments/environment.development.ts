export const environment = {
  maptilerKey: 'DfGj9q5LsBgdiVNHDNr5',
  // Desenvolvimento: API local (webgis/api/dev.py) no mesmo computador que serve o mapa.
  // Usa o host da página, para funcionar também no celular pelo IP do Mac (http://192.168.x.x:4200).
  apiUrl: `http://${location.hostname}:8100`,
};
