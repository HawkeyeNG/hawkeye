// expo-file-system's File/Directory over a real temp directory
// (globalThis.__native.docs is the app's document directory).
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
const N = (globalThis.__native ??= {});
N.docs ??= fs.mkdtempSync(nodePath.join(os.tmpdir(), 'rn-docs-'));
const toPath = (b) => (typeof b === 'string' ? b.replace(/^file:\/\//, '') : b.path);
export class Directory {
  constructor(base, ...parts) { this.path = nodePath.join(toPath(base), ...parts); this.uri = 'file://' + this.path; this.name = nodePath.basename(this.path); }
  get exists() { return fs.existsSync(this.path); }
  create() { fs.mkdirSync(this.path, { recursive: true }); }
  delete() { fs.rmSync(this.path, { recursive: true, force: true }); }
  list() { return fs.readdirSync(this.path).map((n) => (fs.statSync(nodePath.join(this.path, n)).isDirectory() ? new Directory(this, n) : new File(this, n))); }
}
export class File {
  constructor(base, ...parts) { this.path = parts.length ? nodePath.join(toPath(base), ...parts) : toPath(base); this.uri = 'file://' + this.path; this.name = nodePath.basename(this.path); }
  get exists() { return fs.existsSync(this.path); }
  get size() { try { return fs.statSync(this.path).size; } catch { return null; } }
  async copy(dest) { fs.copyFileSync(this.path, dest.path); }
  async arrayBuffer() { const b = fs.readFileSync(this.path); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
  async text() { return fs.readFileSync(this.path, 'utf8'); }
  write(s) { fs.writeFileSync(this.path, s); }
  delete() { fs.rmSync(this.path, { force: true }); }
}
export const Paths = { get document() { return new Directory('file://' + N.docs); }, get cache() { return new Directory('file://' + N.docs + '-cache'); } };
