import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Almacén cifrado (AES-256-GCM) del PAT. La clave sale de SECRET_KEY (recomendado) o de un
 * archivo local generado una sola vez con permisos restringidos.
 */
export function createPatStore(dir) {
  const file = path.join(dir, 'pat.enc');
  const keyFile = path.join(dir, '.key');
  let keyPromise;

  async function getKey() {
    keyPromise ??= (async () => {
      await mkdir(dir, { recursive: true });
      if (process.env.SECRET_KEY) return scryptSync(process.env.SECRET_KEY, 'searchrepocode-pat', 32);
      try {
        return Buffer.from(await readFile(keyFile, 'utf8'), 'hex');
      } catch {
        const k = randomBytes(32);
        await writeFile(keyFile, k.toString('hex'), { mode: 0o600 });
        await chmod(keyFile, 0o600).catch(() => {});
        return k;
      }
    })();
    return keyPromise;
  }

  return {
    async load() {
      try {
        const { iv, tag, data, updatedAt } = JSON.parse(await readFile(file, 'utf8'));
        const d = createDecipheriv('aes-256-gcm', await getKey(), Buffer.from(iv, 'base64'));
        d.setAuthTag(Buffer.from(tag, 'base64'));
        const token = Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
        return { token, updatedAt };
      } catch {
        return null;
      }
    },
    async save(token) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', await getKey(), iv);
      const data = Buffer.concat([c.update(token, 'utf8'), c.final()]);
      const updatedAt = new Date().toISOString();
      await writeFile(
        file,
        JSON.stringify({ iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64'), updatedAt }),
        { mode: 0o600 },
      );
      await chmod(file, 0o600).catch(() => {});
      return updatedAt;
    },
    async clear() {
      await rm(file, { force: true });
    },
  };
}

export const maskToken = (t) => (t ? `${'•'.repeat(12)}${t.slice(-4)}` : '');
