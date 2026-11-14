// Keep the last complete content file if a write fails or the process stops.
// The hidden sibling is never served. Rename only after its bytes are flushed;
// an interrupted write can leave a temporary file, never a partial site.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function writeLocalContent(filename, data) {
  // Preserve a site's explicit content symlink rather than replacing the link.
  const target = await fs.realpath(filename).catch((e) => { if (e.code === 'ENOENT') return filename; throw e; });
  const mode = await fs.stat(target).then((s) => s.mode & 0o777).catch((e) => { if (e.code === 'ENOENT') return 0o666; throw e; });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.plater-tmp`);
  let file;
  try {
    file = await fs.open(temporary, 'wx', mode);
    await file.writeFile(data);
    await file.sync();
    await file.close();
    file = null;
    await fs.rename(temporary, target);
  } finally {
    if (file) await file.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}
