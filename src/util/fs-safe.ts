/**
 * Filesystem boundary enforcement for Mesh-managed paths.
 *
 * A boundary root is canonicalized once with `realpath`; every managed path is
 * resolved lexically against it and then against the nearest existing ancestor
 * to reject symlink escapes. These checks protect Mesh API and Mesh-owned file
 * operations. They are not an OS sandbox: an agent holding the same OS account
 * can still read other paths through unrelated tools.
 */

import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  constants as fsConstants,
} from 'node:fs';
import { dirname, isAbsolute, join, relative as relativePath, resolve as resolvePath, sep } from 'node:path';
import { MeshError } from '../errors.ts';

/** Reject a path segment that can escape or is not portable. */
function assertSegment(segment: string, original: string): void {
  if (segment.length === 0 || segment === '.' || segment === '..') {
    throw new MeshError('PATH_ESCAPE', `path contains an empty or traversal segment: ${original}`, {
      path: original,
      segment,
    });
  }
  if (segment.includes('\0')) {
    throw new MeshError('PATH_ESCAPE', `path contains NUL: ${original}`, { path: original });
  }
}

/**
 * Validate a caller-supplied relative path before resolution.
 * @param input - relative path using `/`; backslashes are rejected for portability.
 * @param field - label used in failures.
 * @returns normalized relative path with `/` separators.
 */
export function requireRelativePath(input: string, field = 'path'): string {
  if (input.length === 0) throw new MeshError('INVALID_ARGUMENT', `${field} must not be empty`, { field });
  if (input.includes('\0')) throw new MeshError('PATH_ESCAPE', `${field} contains NUL`, { field });
  if (input.includes('\\')) {
    throw new MeshError('PATH_ESCAPE', `${field} must use '/' separators; backslashes are rejected`, { field });
  }
  if (isAbsolute(input) || /^[A-Za-z]:[/\\]/.test(input) || input.startsWith('~')) {
    throw new MeshError('PATH_ESCAPE', `${field} must be relative to the workspace root`, { field, input });
  }
  const segments = input.split('/').filter(segment => segment !== '.');
  if (segments.length === 0) throw new MeshError('PATH_ESCAPE', `${field} resolves to the root`, { field });
  for (const segment of segments) assertSegment(segment, input);
  return segments.join('/');
}

/** A canonical root directory that all managed paths must stay inside. */
export class PathBoundary {
  /** Canonical absolute root. */
  readonly root: string;

  /**
   * @param root - existing directory.
   */
  constructor(root: string) {
    if (!isAbsolute(root)) throw new MeshError('INVALID_ARGUMENT', 'boundary root must be absolute', { root });
    const stat = statSync(root, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isDirectory()) {
      throw new MeshError('WORKSPACE_MISSING', `boundary root is not a directory: ${root}`, { root });
    }
    this.root = realpathSync(root);
  }

  /**
   * Resolve a relative path lexically, then prove no existing component
   * resolves outside the boundary through a symlink.
   * @param input - relative path.
   * @param field - label for failures.
   * @returns canonical candidate under the root.
   */
  resolve(input: string, field = 'path'): string {
    const normalized = requireRelativePath(input, field);
    const candidate = resolvePath(this.root, normalized);
    this.assertLexical(candidate, input);
    let ancestor = candidate;
    for (;;) {
      const stat = lstatSync(ancestor, { throwIfNoEntry: false });
      if (stat !== undefined) {
        if (stat.isSymbolicLink()) {
          const real = realpathSync(ancestor);
          this.assertLexical(real, input);
        } else {
          const real = realpathSync(ancestor);
          this.assertLexical(real, input);
        }
        break;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    return candidate;
  }

  /**
   * Resolve and require that the target exists.
   * @param input - relative path.
   * @param field - label for failures.
   * @returns canonical absolute target.
   */
  resolveExisting(input: string, field = 'path'): string {
    const candidate = this.resolve(input, field);
    if (!existsSync(candidate)) {
      throw new MeshError('WORKSPACE_MISSING', `${field} does not exist inside the boundary`, { field, path: input });
    }
    const real = realpathSync(candidate);
    this.assertLexical(real, input);
    return candidate;
  }

  /**
   * Compute a path relative to this boundary.
   * @param absolute - absolute path.
   * @returns `/`-separated relative path.
   */
  relative(absolute: string): string {
    const rel = relativePath(this.root, absolute);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new MeshError('PATH_ESCAPE', 'path is outside the boundary', { path: absolute, root: this.root });
    }
    return rel.split(sep).join('/');
  }

  /**
   * Create a directory under the boundary.
   * @param input - relative directory path.
   * @returns canonical absolute directory path.
   */
  ensureDir(input: string): string {
    const target = this.resolve(input);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const real = realpathSync(target);
    this.assertLexical(real, input);
    return target;
  }

  private assertLexical(candidate: string, input: string): void {
    if (candidate !== this.root && !candidate.startsWith(this.root + sep)) {
      throw new MeshError('PATH_ESCAPE', 'resolved path escapes the boundary root', {
        input,
        candidate,
        root: this.root,
      });
    }
  }
}

/**
 * Write a text file atomically with owner-only mode.
 * @param path - absolute path; parent must exist.
 * @param content - UTF-8 text.
 */
export function atomicWriteText(path: string, content: string): void {
  const dir = dirname(path);
  const tmp = join(dir, `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    writeFileSync(fd, content, { encoding: 'utf8' });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best-effort temp cleanup; the rename error is the failure */ }
    throw error;
  }
  try { chmodSync(path, 0o600); } catch { /* mode is advisory on non-POSIX filesystems */ }
}

/**
 * Read a UTF-8 file with a hard size cap.
 * @param path - absolute path.
 * @param maxBytes - maximum accepted size.
 * @returns file text.
 */
export function readTextFileLimited(path: string, maxBytes = 16 * 1024 * 1024): string {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) {
    throw new MeshError('WORKSPACE_MISSING', `file does not exist: ${path}`, { path });
  }
  if (stat.size > maxBytes) {
    throw new MeshError('INVALID_ARGUMENT', `file exceeds the ${maxBytes} byte limit: ${path}`, {
      path,
      size: stat.size,
    });
  }
  return readFileSync(path, 'utf8');
}

/**
 * Read JSON text and require an object root; the caller narrows fields.
 * @param path - absolute path.
 * @param field - label used in failures.
 * @returns parsed object.
 */
export function readJsonObjectFile(path: string, field: string): Record<string, unknown> {
  const text = readTextFileLimited(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new MeshError('INVALID_ARGUMENT', `${field} contains invalid JSON`, {
      field,
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MeshError('INVALID_ARGUMENT', `${field} must contain a JSON object`, { field, path });
  }
  return parsed as Record<string, unknown>;
}

/**
 * Ensure a file is a regular file (never a symlink) inside a boundary.
 * @param boundary - containing boundary.
 * @param absolute - absolute path.
 * @param field - label for failures.
 */
export function requireRegularFileInside(boundary: PathBoundary, absolute: string, field: string): void {
  boundary.relative(absolute);
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (stat === undefined) throw new MeshError('WORKSPACE_MISSING', `${field} does not exist`, { field, path: absolute });
  if (stat.isSymbolicLink()) throw new MeshError('PATH_ESCAPE', `${field} must not be a symlink`, { field, path: absolute });
  if (!stat.isFile()) throw new MeshError('INVALID_ARGUMENT', `${field} must be a regular file`, { field, path: absolute });
}

/**
 * Copy a regular file without following a symlink at the destination.
 * @param source - absolute source file.
 * @param destination - absolute destination file.
 */
export function copyRegularFile(source: string, destination: string): void {
  const stat = lstatSync(source, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()) {
    throw new MeshError('ARTIFACT_INVALID', `source is not a regular file: ${source}`, { source });
  }
  copyFileSync(source, destination);
}

/**
 * Check whether a path is a directory without following a symlink.
 * @param path - absolute path.
 * @returns true only for a real directory.
 */
export function isRealDirectory(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat !== undefined && stat.isDirectory() && !stat.isSymbolicLink();
}

/**
 * Check whether a path exists as a symlink.
 * @param path - absolute path.
 * @returns true for a symlink.
 */
export function isSymlink(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat?.isSymbolicLink() === true;
}

/**
 * Read the first bytes of a file without loading the whole file.
 * @param path - absolute path.
 * @param length - byte count.
 * @returns a Buffer of at most `length` bytes.
 */
export function readPrefix(path: string, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    const count = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}
