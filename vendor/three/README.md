# three.js (vendorizado)

Biblioteca 3D usada por el hero de la portada (`web/hero-3d.js`).
Se sirve **desde este repositorio**, no desde un CDN: el sitio no hace ninguna
petición externa en tiempo de ejecución.

| Dato | Valor |
| --- | --- |
| Paquete | [`three`](https://www.npmjs.com/package/three) |
| Versión | **0.186.0** (r186) |
| Licencia | MIT (`SPDX-License-Identifier: MIT` en la cabecera de cada archivo) |
| Origen | `https://registry.npmjs.org/three/-/three-0.186.0.tgz`, ruta `build/` |

## Archivos

| Archivo | Tamaño | SHA-256 |
| --- | --- | --- |
| `three.module.js` | 662 772 B | `9052042d676cb0fdc1ddfefe193053f34b7ac0513a616fdac4535d49987812ea` |
| `three.core.js` | 1 458 113 B | `9edde002b066a9a05676a6127f67735b62baf399bdea529f2f7e31657da769e6` |

`three.module.js` importa `./three.core.js`, y `three.core.js` no importa nada
más. Con estos dos archivos la biblioteca queda completa.

## Por qué sin minificar

El paquete oficial **no publica builds minificados**: `three.module.min.js` y
`three.core.min.js`, que sí aparecen en algunos CDNs, son archivos generados por
el propio CDN a partir de estos (llevan la marca «Minified by jsDelivr»). Se
prefieren los artefactos oficiales tal cual, sin modificar, para que los hashes
de arriba sean verificables contra el paquete de npm.

El costo real es aceptable porque el archivo se carga **en diferido**, sólo
cuando el navegador tiene WebGL2 y la página ya se pintó, y el hosting lo
comprime (≈330 KB en gzip).

## Verificar la integridad

```bash
cd web/vendor/three
shasum -a 256 three.module.js three.core.js
```

Si alguna vez se actualiza la versión, hay que cambiar también el número en
`design.md` (§7) y volver a anotar los hashes aquí.
