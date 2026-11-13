// Keep the last complete content file if a write fails or the process stops.
// The hidden sibling is never served. Rename only after its bytes are flushed;
// an interrupted write can leave a temporary file, never a partial site.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function writeLocalContent(filename, data, { exclusive = false } = {}) {
  // Preserve a site's explicit content symlink rather than replacing the link.
  // An exclusive asset must never follow or replace an existing destination.
  const target = exclusive ? filename : await fs.realpath(filename).catch((e) => { if (e.code === 'ENOENT') return filename; throw e; });
  const mode = exclusive ? 0o666 : await fs.stat(target).then((s) => s.mode & 0o777).catch((e) => { if (e.code === 'ENOENT') return 0o666; throw e; });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.plater-tmp`);
  let file;
  try {
    file = await fs.open(temporary, 'wx', mode);
    await file.writeFile(data);
    await file.sync();
    await file.close();
    file = null;
    // A hard link publishes the complete flushed asset and fails if another
    // writer already owns the name. Content saves intentionally replace it.
    if (exclusive) await fs.link(temporary, target);
    else await fs.rename(temporary, target);
  } finally {
    if (file) await file.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}
