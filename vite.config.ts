import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const rootDir = process.cwd();

/**
 * Конфиг веб-приложения тирлиста. Отдельный от vitest.config.ts, чтобы
 * тесты продолжали собираться из корня, а сайт — из ./web.
 */
export default defineConfig({
  // GitHub Pages публикует проект по пути /<repository>/, поэтому assets
  // должны ссылаться относительно корня страницы, а не от домена.
  base: './',
  root: resolve(rootDir, 'web'),
  // Сайту нужен только готовый tierlist.json, а не весь каталог BSData.
  publicDir: resolve(rootDir, 'web/public'),
  build: {
    outDir: resolve(rootDir, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
  },
});
