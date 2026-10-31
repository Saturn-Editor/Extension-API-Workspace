import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.js';
import { fromPostman, fromPostmanEnvironment } from './postman.js';
import { fromBrunoFolder, fromBrunoFiles } from './bruno.js';
import { fromOpenApi } from './openapi.js';

export function importFiles(files) {
  const results = [];
  const bru = [];
  for (const file of files) {
    const base = path.basename(file).toLowerCase();
    if (base === 'bruno.json') {
      results.push(fromBrunoFolder(path.dirname(file)));
    } else if (base.endsWith('.bru')) {
      bru.push(file);
    } else {
      results.push(importDataFile(file));
    }
  }
  const groups = new Map();
  for (const file of bru) {
    const dir = path.dirname(file);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(file);
  }
  for (const [dir, list] of groups) results.push(fromBrunoFiles(dir, list));
  return results;
}

function importDataFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const fallback = path.basename(file).replace(/\.[^.]+$/, '');
  let data;
  try {
    data = /\.ya?ml$/i.test(file) ? parseYaml(text) : JSON.parse(text);
  } catch (error) {
    try {
      data = parseYaml(text);
    } catch {
      throw new Error(`${path.basename(file)} isn't valid JSON or YAML: ${error.message}`);
    }
  }
  if (!data || typeof data !== 'object') throw new Error(`${path.basename(file)} is empty or not a collection.`);
  if (data.openapi || data.swagger) return fromOpenApi(data, fallback);
  if (Array.isArray(data.item) || /postman/i.test(data.info?.schema ?? '')) return fromPostman(data, fallback);
  if (data.collection && Array.isArray(data.collection.item)) return fromPostman(data.collection, fallback);
  if (Array.isArray(data.values) && (data._postman_variable_scope || data.name)) return fromPostmanEnvironment(data, fallback);
  if (data.environment && Array.isArray(data.environment.values)) return fromPostmanEnvironment(data.environment, fallback);
  throw new Error(`${path.basename(file)} doesn't look like a Postman collection, Postman environment or OpenAPI file.`);
}
