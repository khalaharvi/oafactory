import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** @type {import('next').NextConfig} */
export default {
  // The docs live at the repository root so Mintlify can host the same files.
  outputFileTracingRoot: root,
  poweredByHeader: false,
};
