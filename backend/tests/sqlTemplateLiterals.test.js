import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');

/**
 * GUARDA CONTRA UN FALLO QUE SE COMETIÓ DOS VECES EN UNA HORA (2026-08-03).
 *
 * Las consultas SQL viven en template literals, y un backtick dentro de un comentario `--`
 * TERMINA la cadena. El síntoma no se parece a la causa: revienta el módulo entero con un
 * `SyntaxError: Unexpected token, expected ","` y tumba 7 suites de golpe, ninguna de ellas
 * relacionada con SQL. Y el hábito de este proyecto es escribir los nombres de campo entre
 * backticks en los comentarios, así que la trampa se pisa sola.
 *
 * La suite YA lo detectaba (por los 7 fallos), pero no lo NOMBRABA. Esto lo nombra y falla
 * donde el mensaje dice qué hacer, en vez de exigir leer un stack de Babel.
 */
/**
 * ⚠️ AMPLIADA tras la TERCERA aparición del mismo fallo el mismo día: la vez que mordió en el
 * PROMPT (que también es un template literal) el guard de abajo no la vio, porque solo mira
 * líneas que empiezan por `--`. La lección es que el guard específico llega tarde a la
 * siguiente variante — así que el de verdad es el de abajo del todo: importar cada módulo. Ese
 * caza la clase ENTERA de error de parseo, venga de donde venga.
 */
describe('comentarios SQL dentro de template literals', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
  });

  test('ninguna línea de comentario SQL contiene backticks', () => {
    const ofensas = [];
    for (const file of walk(SRC)) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((ln, i) => {
        if (ln.trimStart().startsWith('--') && ln.includes('`')) {
          ofensas.push(`${path.relative(SRC, file)}:${i + 1} → ${ln.trim().slice(0, 70)}`);
        }
      });
    }
    expect(ofensas).toEqual([]);   // si falla: QUITA los backticks, no los escapes
  });
});

describe('todos los módulos de src/ PARSEAN', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
  });

  /**
   * POR QUÉ ESTE TEST. Un backtick suelto dentro de un template literal —el prompt, una
   * consulta SQL— rompe el módulo ENTERO con un SyntaxError de Babel, y el síntoma no se
   * parece a la causa: caen 7-16 suites que no tienen nada que ver y el mensaje obliga a leer
   * un stack para llegar al fichero. Pasó TRES veces el 2026-08-03.
   *
   * ⚠️ Se PARSEA, no se importa. La primera versión hacía `import()` de cada módulo y se
   * colgaba: importar `index.js` arranca el servidor y los pollers. Un test de sintaxis no
   * debe tener efectos secundarios — `node --check` parsea y no ejecuta nada.
   */
  test('ningún fichero de src/ tiene errores de sintaxis', () => {
    const malos = [];
    for (const file of walk(SRC)) {
      const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (r.status !== 0) {
        const linea = (r.stderr || '').split('\n').find((l) => /SyntaxError|Error:/.test(l)) ?? '';
        malos.push(`${path.relative(SRC, file)} → ${linea.trim()}`);
      }
    }
    expect(malos).toEqual([]);
  });
});
