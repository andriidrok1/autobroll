import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default {
  plugins: {
    tailwindcss: {config: join(here, 'tailwind.config.js')},
    autoprefixer: {},
  },
};
