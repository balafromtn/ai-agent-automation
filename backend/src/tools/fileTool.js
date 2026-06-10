// backend/src/tools/fileTool.js
// simple file read/write in a safe folder. Beware: do not use for storing secrets.
// Provides write, append, read, remove, list
const fs = require("fs");
const path = require("path");
const util = require("util");
const mkdirp = util.promisify(fs.mkdir);
const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const appendFile = util.promisify(fs.appendFile);
const unlink = util.promisify(fs.unlink);
const readdir = util.promisify(fs.readdir);
const stat = util.promisify(fs.stat);

const BASE_DIR = path.resolve(process.env.FILE_BASE_DIR || path.join(process.cwd(), "runtime/sandbox"));

// Ensure the parent directory of a path exists
async function ensureDir(dirPath) {
  try {
    await mkdirp(dirPath, { recursive: true });
  } catch (e) {
    // ignore
  }
}

/**
 * Resolves a path relative to the BASE_DIR and prevents directory traversal.
 */
function resolveSafePath(filePath) {
  const resolved = path.resolve(BASE_DIR, filePath);
  const relative = path.relative(BASE_DIR, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Access denied: Path traversal detected for path: "${filePath}"`);
  }
  return resolved;
}

async function write(filename, content, opts = {}) {
  const fullPath = resolveSafePath(filename);
  await ensureDir(path.dirname(fullPath));

  // limit file size (default 5MB)
  const maxBytes = opts.maxBytes || 5 * 1024 * 1024;
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  if (buf.length > maxBytes) throw new Error("File too large");

  await writeFile(fullPath, buf);
  const relative = path.relative(BASE_DIR, fullPath);
  return { path: fullPath, filename: relative, size: buf.length };
}

async function append(filename, content, opts = {}) {
  const fullPath = resolveSafePath(filename);
  await ensureDir(path.dirname(fullPath));

  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  // Append uses a newline by default to separate log-like writes
  await appendFile(fullPath, Buffer.concat([buf, Buffer.from("\n")]));
  const relative = path.relative(BASE_DIR, fullPath);
  return { path: fullPath, filename: relative };
}

async function read(filename, opts = {}) {
  const fullPath = resolveSafePath(filename);
  const content = await readFile(fullPath, "utf8");
  return content;
}

async function remove(filename) {
  const fullPath = resolveSafePath(filename);
  await unlink(fullPath);
  const relative = path.relative(BASE_DIR, fullPath);
  return { removed: relative };
}

async function list(subDir = "") {
  const fullPath = resolveSafePath(subDir);
  const files = await readdir(fullPath);
  const out = [];
  for (const f of files) {
    const fileFullPath = path.join(fullPath, f);
    const s = await stat(fileFullPath);
    const relative = path.relative(BASE_DIR, fileFullPath);
    out.push({ filename: relative, size: s.size, mtime: s.mtime, isDirectory: s.isDirectory() });
  }
  return out;
}

module.exports = { write, append, read, remove, list, BASE_DIR };
