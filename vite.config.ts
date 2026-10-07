import { defineConfig, loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const configuredBase = env.VITE_BASE_PATH || '/';

  return {
    base: configuredBase.endsWith('/') ? configuredBase : `${configuredBase}/`,
    plugins: [tailwindcss()],
    server: {
      host: '127.0.0.1',
      allowedHosts: ['.ts.net'],
    },
  };
});
