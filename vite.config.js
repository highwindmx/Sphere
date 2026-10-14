import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

// vite-plugin-cesium 会自动处理 Cesium 的静态资源
// （Workers / Assets / Widgets / ThirdParty）与 CESIUM_BASE_URL
export default defineConfig({
  plugins: [cesium()],
  server: {
    port: 5173,
    open: true,
    host: '127.0.0.1',
    watch: {
      // 忽略 TIF 与原始数据目录（TIF 被 Windows 锁定导致 EBUSY）
      // 月球原始 TIF 已移至 raw-data/lunar（不进 dist、不打包）；public/lunar 仅存运行时 JPG
      ignored: ['**/*.tif', '**/*.TIF', '**/raw-data/**', '**/.git/**', '**/node_modules/**']
    }
  }
});
