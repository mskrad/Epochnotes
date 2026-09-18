// Regenerates registry/schema.json from the zod schema in @epochnotes/core. Run via `npm run schema:write`.
import { writeFileSync } from 'node:fs';

import { entryJsonSchema } from '../packages/core/dist/index.js';

writeFileSync(
  new URL('../registry/schema.json', import.meta.url),
  `${JSON.stringify(entryJsonSchema(), null, 2)}\n`,
);
