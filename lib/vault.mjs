// Cofre local: guarda token -> valor real, cifrado com AES-256-GCM.
// A chave mestra fica em chave.key, protegida pelo DPAPI do Windows (só seu usuário nesta máquina abre).
// O cofre é um log só de acréscimo (uma linha cifrada por valor), então o servidor MCP e os hooks
// podem gravar ao mesmo tempo sem se atropelar.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PATHS, ensureDataDir } from './config.mjs';

export const TOKEN_RE = /\b([A-Z][A-Z0-9_]{1,15})#([0-9a-f]{12})\b/g;

function dpapi(op, buf) {
  const ps =
    'Add-Type -AssemblyName System.Security; ' +
    '$i=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ' +
    `$o=[Security.Cryptography.ProtectedData]::${op}($i,$null,'CurrentUser'); ` +
    '[Console]::Out.Write([Convert]::ToBase64String($o))';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    input: buf.toString('base64'),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0 || !r.stdout) throw new Error(`DPAPI ${op} falhou: ${r.stderr || r.error}`);
  return Buffer.from(r.stdout.trim(), 'base64');
}

function readMasterKey() {
  ensureDataDir();
  let txt;
  try {
    txt = fs.readFileSync(PATHS.chave, 'utf8').trim();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const key = crypto.randomBytes(32);
    const stored =
      process.platform === 'win32'
        ? 'DPAPI1:' + dpapi('Protect', key).toString('base64')
        : 'RAW1:' + key.toString('base64');
    // wx: se outro processo criou a chave ao mesmo tempo, usa a dele.
    try {
      fs.writeFileSync(PATHS.chave, stored, { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    txt = fs.readFileSync(PATHS.chave, 'utf8').trim();
  }
  const [kind, b64] = txt.split(':');
  const blob = Buffer.from(b64, 'base64');
  if (kind === 'DPAPI1') return dpapi('Unprotect', blob);
  if (kind === 'RAW1') return blob;
  throw new Error('chave.key em formato desconhecido');
}

export class Vault {
  #keys = null;
  #map = new Map(); // hash -> { v: valor original, k: tipo }
  #offset = 0;

  #k() {
    if (!this.#keys) {
      const master = readMasterKey();
      const sub = (label) => crypto.createHmac('sha256', master).update(label).digest();
      this.#keys = { enc: sub('cofre-enc-v1'), tok: sub('cofre-tok-v1') };
      this.#load();
    }
    return this.#keys;
  }

  hash(norm) {
    return crypto.createHmac('sha256', this.#k().tok).update(String(norm)).digest('hex').slice(0, 12);
  }

  // Devolve PREFIXO#hash e guarda o valor original no cofre (se ainda não estiver lá).
  // O prefixo da primeira vez fica gravado, para o token ser idêntico em qualquer fonte.
  token(norm, original, kind, prefix) {
    const h = this.hash(norm);
    let entry = this.#map.get(h);
    if (!entry) {
      entry = { v: original instanceof Date ? original.toISOString() : original, k: kind, p: prefix };
      this.#map.set(h, entry);
      this.#append({ h, ...entry });
    }
    return `${entry.p || prefix}#${h}`;
  }

  lookup(tokenOrHash) {
    const h = String(tokenOrHash).split('#').pop();
    this.#k();
    if (!this.#map.has(h)) this.#load();
    return this.#map.get(h);
  }

  size() {
    this.#k();
    return this.#map.size;
  }

  #append(obj) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.#k().enc, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    const line = Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64') + '\n';
    fs.appendFileSync(PATHS.cofre, line, { mode: 0o600 });
  }

  #load() {
    let buf;
    try {
      buf = fs.readFileSync(PATHS.cofre);
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    const text = buf.subarray(this.#offset).toString('utf8');
    const end = text.lastIndexOf('\n');
    if (end < 0) return;
    for (const line of text.slice(0, end).split('\n')) {
      if (!line) continue;
      const raw = Buffer.from(line, 'base64');
      try {
        const d = crypto.createDecipheriv('aes-256-gcm', this.#keys.enc, raw.subarray(0, 12));
        d.setAuthTag(raw.subarray(12, 28));
        const obj = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
        if (!this.#map.has(obj.h)) this.#map.set(obj.h, { v: obj.v, k: obj.k, p: obj.p });
      } catch {
        // linha corrompida ou de outra chave: ignora
      }
    }
    this.#offset += Buffer.byteLength(text.slice(0, end + 1), 'utf8');
  }
}
